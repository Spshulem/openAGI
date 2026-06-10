# Floating Widget ("Quick Ask") — Design

**Date:** 2026-06-05
**Status:** Approved (brainstorming) — pending implementation plan
**Branch:** `feat/floating-widget` (stacks on `feat/external-knowledge-sources`)

## Goal
A native macOS always-on-top floating widget (a collapsed pill that expands into a
panel) that lets the user ask OpenAGI a question from anywhere, grounded in the
content of the window they're looking at, and surfaces proactive nudges. This closes
the last of the three littlebird.ai gaps (web search and BuildBetter transcripts are
already shipped on the sibling branch).

## Decisions (from brainstorming)
- **Form factor:** floating pill (collapsed `●`) that expands into a panel.
- **Summon:** global hotkey (default **⌥Space**) **and** a tray menu item.
- **v1 behavior:** ask → answer inline, **plus** proactive nudges in the panel.
- **Context:** live-grab the focused window per ask, reusing the existing
  ScreenCapturer + Vision OCR pipeline (honoring the privacy exclusion list).

## Architecture
The widget is added to the existing SwiftUI menu-bar app (`mac/Sources/OpenAGI`). It
hosts SwiftUI inside a native AppKit `NSPanel` and talks to the daemon the app already
manages (`http://127.0.0.1:43210`) over HTTP — no new service, no new process. One
small daemon-side (JS) change lets a message carry fresh screen context and is the
single automated-test seam.

```
⌥Space / pill tap
  → FocusedWindowGrabber: OCR frontmost window (privacy-filtered) → {app, window, text}
  → POST /message { text, channel:"overlay", metadata:{ screenContext } }
  → daemon agent-host injects screenContext into the turn context → agent answers
  → OverlayView renders the reply (markdown) with a "continue in chat" link
```

## Components

### macOS (new files under `mac/Sources/OpenAGI/Overlay/`)
1. **`OverlayPanelController.swift`** (AppKit) — owns an `NSPanel`:
   - style: `[.nonactivatingPanel, .borderless]`; `isFloatingPanel = true`;
     `level = .statusBar`; `hidesOnDeactivate = false`;
     `collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]`
     so it floats over every Space/app incl. fullscreen without stealing focus.
   - hosts an `NSHostingView(rootView: OverlayView)`.
   - manages collapsed↔expanded sizing, draggable position persisted to
     `UserDefaults` (`openagi.overlay.frame`), and `show()/hide()/toggle()`.
   - the panel's own window is excluded from capture (so the pill never OCRs itself —
     add its `windowNumber` to the `SCContentFilter` excluded set, or rely on the
     frontmost-window targeting which never targets a non-activating panel).
2. **`OverlayView.swift`** (SwiftUI) — observes `OverlayState`:
   - **collapsed:** a small `●` pill; in Phase 2 a badge with the nudge count.
   - **expanded:** a text field ("Ask OpenAGI…"), submit affordance (Return), an
     answer area rendering markdown, a "Continue in chat" button (opens the dashboard
     via the existing `AppState.openDashboard`), a subtle "reading <app>"/"no screen
     context" indicator, and (Phase 2) a nudges list.
3. **`OverlayState.swift`** (`@MainActor ObservableObject`) — the view model:
   - `ask(_ question:)`: calls `FocusedWindowGrabber`, POSTs `/message`, sets
     `answer`/`isLoading`/`error`. Daemon-health aware via `AppState.shared`.
   - holds `nudges: [Suggestion]` fed from `AppState` (Phase 2).
4. **`HotkeyManager.swift`** — registers a system-wide hotkey via Carbon
   `RegisterEventHotKey` (default ⌥Space; constant in v1, configurable later). On fire,
   calls `OverlayPanelController.toggle()`. Carbon hotkeys need no Accessibility
   permission. Unregisters on teardown.
5. **`FocusedWindowGrabber.swift`** — a focused, on-demand capture factored from
   `ScreenCapturer.captureOnce()`:
   - `func grab() async -> ScreenContext?` returns `{ app, window, text }` where `text`
     is the Vision-OCR'd frontmost window content, truncated (e.g. 4000 chars).
   - honors `CaptureSettings.shared.isExcluded(bundleId:windowTitle:)` — returns `nil`
     (no context) for excluded apps/windows (1Password, banking, etc.).
   - returns `nil` quietly if Screen Recording permission is absent.

### macOS (edits to existing files)
6. **`AppDelegate.swift`** — instantiate `OverlayPanelController` + `HotkeyManager` at
   startup (gated on the overlay-enabled setting), tear down on quit.
7. **`TrayController.swift`** — add a "Quick Ask  ⌥Space" item that toggles the panel,
   and an "Enable Quick Ask" toggle (persisted in `UserDefaults`
   `openagi.overlay.enabled`, default **on**; mirrors the login-item toggle pattern).
8. **`AppState.swift`** — expose the proactive-suggestion list it already receives via
   `SSEDelegate` (`/events`) so `OverlayState` can show nudges (Phase 2); add a small
   `postMessage(text:metadata:)` helper if one isn't already present.

### Daemon (JS — the one backend change + its test)
9. **`src/agent-host.js`** — when an inbound message has
   `metadata.screenContext = { app, window, text }`, include it in the turn's context
   block (the same place `observations.getRecentContext` output is added), clearly
   labeled (e.g. `Active window (<app> — <window>):\n<text>`). Treat the `"overlay"`
   channel as a context-bearing channel (like `"local"`). Truncate the injected text
   defensively. **No secret/PII handling beyond honoring the client-side exclusion
   list** (the grabber already filtered).

## Data flow & transport
- **Ask:** synchronous `POST /message` returns the agent's reply in the HTTP response
  (`channels.handleLocalMessage`), so Phase 1 renders the full answer on completion
  with a thinking state. Token-by-token streaming via the existing `/events` SSE is a
  deferred enhancement, not required for v1.
- **Nudges (Phase 2):** reuse the existing SSE path — `SSEDelegate` already routes
  `proactive-suggestion` events into `AppState`; `OverlayState` mirrors that list and
  uses the existing suggestion accept/dismiss endpoints.

## Error handling
- Daemon offline → panel shows "OpenAGI is offline" (from `AppState.status`); ask
  disabled.
- OCR unavailable / window excluded → ask proceeds **without** screen context, with a
  subtle "no screen context" note (never block the ask).
- Hotkey registration fails (conflict) → log + fall back to tray-only; surface a one-time
  note in the tray.
- `/message` non-200 → inline error in the panel, ask remains retryable.

## Privacy & permissions
- **Screen Recording** permission (reused from ambient capture) gates OCR; absent → no
  context, ask still works.
- The `CaptureSettings` exclusion list is honored on every grab, so excluded
  apps/windows are never read.
- The panel shows which app it read ("reading Safari…") so context capture is never
  invisible.
- Carbon global hotkey needs no permission.

## Testing & honest constraints
- The macOS UI (NSPanel, hotkey, OCR grab, SwiftUI) is **not** unit-testable in this
  repo (all existing tests are JS) — it is verified by `swift build` (compile-clean) and
  manual runtime checks by the user (the panel floats, ⌥Space toggles, an ask returns a
  grounded answer, excluded apps yield no context).
- **Automated test (JS):** `test/agent-host-screen-context.test.js` — a message with
  `metadata.screenContext` produces a turn whose context block contains the labeled
  active-window text, and the `"overlay"` channel is handled like `"local"`. This is the
  one behavior with a real seam, so it gets a real test.

## Out of scope (YAGNI)
- Token-by-token answer streaming (deferred; sync reply is enough for v1).
- Configurable hotkey UI (default ⌥Space hardcoded for v1; wire a setting later).
- Inline action-approval buttons in the panel (the agent's draft/pending-action
  surfaces stay in the dashboard for v1; "continue in chat" bridges there).
- Windows/Linux equivalents (macOS-only feature).

## Build sequencing (for the plan)
**Phase 1 — ask flow**
1. Daemon: `agent-host` `screenContext` injection + `overlay` channel + JS test.
2. `FocusedWindowGrabber` (factor from ScreenCapturer) — returns OCR'd focused-window text, exclusion-aware.
3. `OverlayPanelController` + `OverlayView` + `OverlayState` — the pill/panel and ask flow (POST /message with screenContext).
4. `HotkeyManager` (⌥Space) + `AppDelegate` wiring + `TrayController` toggle.
5. `swift build` green; manual smoke checklist documented.

**Phase 2 — proactive nudges**
6. `AppState` exposes the suggestion list; `OverlayState` mirrors it; `OverlayView` shows badge + list with accept/dismiss via existing endpoints.
