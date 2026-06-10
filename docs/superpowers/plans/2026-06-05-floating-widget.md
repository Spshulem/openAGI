# Floating Widget ("Quick Ask") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A native macOS always-on-top pill that expands to ask OpenAGI from anywhere, grounded in the focused window, with a global hotkey (⌥Space) + tray toggle and (phase 2) proactive nudges.

**Architecture:** SwiftUI hosted in an AppKit `NSPanel` inside the existing menu-bar app, talking to the local daemon over HTTP. One JS change: `agent-host` injects `metadata.screenContext` into the turn. Screen context reuses the existing ScreenCapturer + Vision OCR (exclusion-aware).

**Tech Stack:** Swift / AppKit / SwiftUI / ScreenCaptureKit / Vision / Carbon (hotkey); Node 22 ESM (daemon) with `node:test`.

**Verification reality:** The macOS UI cannot be unit-tested here (all existing tests are JS). Each Swift task is verified by `cd mac && swift build` (compile-clean). The one JS seam (`agent-host` screen-context) gets a real `node:test`. A manual smoke checklist (Task 8) is for the user.

**Spec:** `docs/superpowers/specs/2026-06-05-floating-widget-design.md`

---

# Phase 1 — Ask flow

### Task 1: Daemon — inject `metadata.screenContext` into the agent turn

**Files:**
- Modify: `src/agent-host.js`
- Test: `test/agent-host-screen-context.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/agent-host-screen-context.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatScreenContextBlock } from "../src/agent-host.js";

test("formats a labeled active-window block from screenContext", () => {
  const block = formatScreenContextBlock({ app: "Safari", window: "Spec — Notion", text: "the deadline is Friday" });
  assert.match(block, /Active window the user is looking at right now \(Safari · Spec — Notion\)/);
  assert.match(block, /the deadline is Friday/);
});

test("returns empty string for missing/empty screenContext", () => {
  assert.equal(formatScreenContextBlock(null), "");
  assert.equal(formatScreenContextBlock({ app: "X" }), ""); // no text
  assert.equal(formatScreenContextBlock({ text: "   " }), ""); // blank text
});

test("truncates very long screen text to 4000 chars", () => {
  const block = formatScreenContextBlock({ app: "X", text: "a".repeat(5000) });
  // 4000 of the body + the surrounding labels; assert body itself is capped
  const body = block.split("\n").find((l) => l.startsWith("aaaa"));
  assert.ok(body.length <= 4000, `body should be <= 4000, got ${body.length}`);
});

test("falls back to 'active window' when app is absent", () => {
  const block = formatScreenContextBlock({ text: "hello" });
  assert.match(block, /\(active window\)/);
});
```

- [ ] **Step 2: Run it — verify it FAILS**

Run: `node --test test/agent-host-screen-context.test.js`
Expected: FAIL — `formatScreenContextBlock` is not exported.

- [ ] **Step 3: Implement**

In `src/agent-host.js`, add this exported pure function near the bottom (next to `friendlyProviderLabel`):

```js
// Format the fresh focused-window context the floating widget attaches to a
// message (metadata.screenContext = { app, window, text }) into a labeled
// prompt block. Returns "" when absent/empty. Pure + exported for testing.
export function formatScreenContextBlock(screenContext) {
  if (!screenContext || typeof screenContext.text !== "string" || !screenContext.text.trim()) return "";
  const where = screenContext.window
    ? `${screenContext.app || "?"} · ${screenContext.window}`
    : (screenContext.app || "active window");
  const body = screenContext.text.slice(0, 4000);
  return `\nActive window the user is looking at right now (${where}):\n${body}\nGround your answer in this if it's relevant; don't quote it back verbatim.\n`;
}
```

Then thread it through `instructionsForAgent`:
- Change the signature: `instructionsForAgent(agent, output, intuitions = [], ambientContext = null, screenContext = null) {`
- After the `ambientBlock` is built (before the `return` template), add:
  ```js
  const screenBlock = formatScreenContextBlock(screenContext);
  ```
- In the returned template string, insert `${screenBlock}` immediately after `${ambientBlock}` (so it reads `...${intuitionBlock}${ambientBlock}${screenBlock}\nAnswer the user plainly...`).

And pass it from `handleMessage`: change the existing call (currently `this.instructionsForAgent(agent, output, intuitions, ambientContext)`) to:
```js
instructions: this.instructionsForAgent(agent, output, intuitions, ambientContext, input.metadata?.screenContext ?? null),
```

(The `"overlay"` channel already receives ambient context — the gate is `channel !== "autopilot" && channel !== "cron"` — so no channel-list change is needed.)

- [ ] **Step 4: Run it — verify it PASSES**

Run: `node --test test/agent-host-screen-context.test.js` → 4 pass.

- [ ] **Step 5: Full suite**

Run: `node --test` → all green.

- [ ] **Step 6: Commit**

```bash
git add src/agent-host.js test/agent-host-screen-context.test.js
git commit -m "feat: agent-host injects metadata.screenContext into the turn

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Swift — `captureFocusedText()` on ScreenCapturer

**Files:**
- Modify: `mac/Sources/OpenAGI/Capture/ScreenCapturer.swift`

Factor an on-demand capture+OCR that returns text instead of recording, reusing the existing exclusion check and Vision OCR.

- [ ] **Step 1: Add the `ScreenContext` type + method**

At the top of `ScreenCapturer.swift` (after imports), add:

```swift
struct ScreenContext {
  let app: String
  let window: String?
  let text: String
}
```

Add this method to `ScreenCapturer` (it reuses the private `runOcr` and the same SCScreenshotManager path as `captureOnce`, but returns the OCR text via a continuation and does NOT write to storage):

```swift
// On-demand grab for the floating widget: OCR the current screen (dominated by
// the frontmost window) and return the text. Honors the same exclusion list as
// ambient capture, and returns nil when excluded or when capture/permission is
// unavailable — callers then proceed without screen context.
func captureFocusedText() async -> ScreenContext? {
  let app = NSWorkspace.shared.frontmostApplication
  let bundleId = app?.bundleIdentifier
  let appName = app?.localizedName ?? bundleId ?? "(unknown)"
  let windowTitle = Self.frontmostWindowTitle()

  if CaptureSettings.shared.isExcluded(bundleId: bundleId, windowTitle: windowTitle) {
    return nil
  }

  do {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first else { return nil }
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let cfg = SCStreamConfiguration()
    cfg.width = display.width
    cfg.height = display.height
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    cfg.queueDepth = 1
    cfg.scalesToFit = true
    cfg.showsCursor = false

    let cgImage = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
    let text: String = await withCheckedContinuation { cont in
      ocrQueue.async {
        Self.runOcr(image: cgImage) { ocrText, _ in cont.resume(returning: ocrText) }
      }
    }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return ScreenContext(app: appName, window: windowTitle, text: "") }
    return ScreenContext(app: appName, window: windowTitle, text: String(trimmed.prefix(8000)))
  } catch {
    NSLog("OpenAGI overlay capture: \(error.localizedDescription)")
    return nil
  }
}
```

> Note: `ocrQueue` and `runOcr` are existing private members of `ScreenCapturer`, so this method must live in that class (it does). The daemon caps the text again at 4000 (Task 1); 8000 here is a generous upper bound.

- [ ] **Step 2: Build**

Run: `cd mac && swift build 2>&1 | tail -15`
Expected: build succeeds (warnings OK).

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/OpenAGI/Capture/ScreenCapturer.swift
git commit -m "feat(mac): ScreenCapturer.captureFocusedText() for on-demand context

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Swift — AppState overlay networking + nudge state hook

**Files:**
- Modify: `mac/Sources/OpenAGI/AppState.swift`

- [ ] **Step 1: Add a public ask method + a nudges list**

In `AppState`, add a published nudges array near the other `@Published` props:
```swift
@Published var nudges: [Nudge] = []

struct Nudge: Identifiable, Equatable {
  let id: String
  let title: String
  let body: String
  let category: String
}
```

Add a public overlay-ask method (uses the existing private `post`):
```swift
struct MessageReply: Decodable { let reply: String? }

// Send a question to the agent from the floating widget, attaching fresh
// focused-window context. Returns the agent's reply text.
func askOverlay(text: String, screenContext: ScreenContext?) async throws -> String {
  var meta: [String: Any] = [:]
  if let s = screenContext, !s.text.isEmpty {
    meta["screenContext"] = ["app": s.app, "window": s.window as Any, "text": s.text]
  }
  let payload: [String: Any] = ["text": text, "channel": "overlay", "metadata": meta]
  let body = try JSONSerialization.data(withJSONObject: payload)
  let data = try await post("/message", body: body)
  let decoded = try JSONDecoder().decode(MessageReply.self, from: data)
  return decoded.reply ?? "(no reply)"
}
```

`askOverlay` is a method on `AppState`, so it can call the existing `private func post` directly — no visibility change needed.

In `handleSSEEvent`, in the existing `if event == "proactive-suggestion"` block, AFTER the `notify(...)` call, append to the nudge list so the widget can show it:
```swift
      let nudge = Nudge(
        id: suggestionId.isEmpty ? UUID().uuidString : suggestionId,
        title: parsed.name ?? "OpenAGI noticed something",
        body: body,
        category: category
      )
      nudges.removeAll { $0.id == nudge.id }
      nudges.insert(nudge, at: 0)
      if nudges.count > 20 { nudges = Array(nudges.prefix(20)) }
```
(`suggestionId`, `parsed`, `category`, `body` are all already in scope in that block.)

- [ ] **Step 2: Build**

Run: `cd mac && swift build 2>&1 | tail -15` → succeeds.

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/OpenAGI/AppState.swift
git commit -m "feat(mac): AppState.askOverlay + nudge list from proactive events

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Swift — the panel, view model, and view

**Files:**
- Create: `mac/Sources/OpenAGI/Overlay/OverlayState.swift`
- Create: `mac/Sources/OpenAGI/Overlay/OverlayView.swift`
- Create: `mac/Sources/OpenAGI/Overlay/OverlayController.swift`

- [ ] **Step 1: `OverlayState.swift`**

```swift
import Foundation
import SwiftUI

@MainActor
final class OverlayState: ObservableObject {
  static let shared = OverlayState()

  @Published var expanded = false
  @Published var question = ""
  @Published var answer: String = ""
  @Published var isLoading = false
  @Published var error: String? = nil
  @Published var contextNote: String? = nil   // e.g. "reading Safari" / "no screen context"

  func ask() async {
    let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !q.isEmpty else { return }
    isLoading = true; error = nil; answer = ""
    let ctx = await ScreenCapturer.shared.captureFocusedText()
    if let ctx, !ctx.text.isEmpty {
      contextNote = "reading \(ctx.app)"
    } else {
      contextNote = "no screen context"
    }
    do {
      answer = try await AppState.shared.askOverlay(text: q, screenContext: ctx)
    } catch {
      self.error = error.localizedDescription
    }
    isLoading = false
  }
}
```

- [ ] **Step 2: `OverlayView.swift`**

```swift
import SwiftUI

struct OverlayView: View {
  @ObservedObject var state = OverlayState.shared
  @ObservedObject var app = AppState.shared
  var onCollapse: () -> Void = {}

  var body: some View {
    if state.expanded {
      expandedPanel
    } else {
      pill
    }
  }

  private var pill: some View {
    Button(action: { state.expanded = true }) {
      ZStack {
        Circle().fill(Color.accentColor).frame(width: 16, height: 16)
        if !app.nudges.isEmpty {
          Text("\(app.nudges.count)")
            .font(.system(size: 9, weight: .bold)).foregroundColor(.white)
        }
      }
      .padding(8)
    }
    .buttonStyle(.plain)
    .background(.ultraThinMaterial, in: Circle())
  }

  private var expandedPanel: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text("Ask OpenAGI").font(.caption).foregroundStyle(.secondary)
        Spacer()
        Button(action: { state.expanded = false; onCollapse() }) {
          Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
        }.buttonStyle(.plain)
      }
      if app.status == .down {
        Text("OpenAGI is offline").font(.caption).foregroundStyle(.red)
      }
      TextField("Ask about what you're looking at…", text: $state.question, onCommit: { Task { await state.ask() } })
        .textFieldStyle(.roundedBorder)
        .disabled(app.status == .down)
      if let note = state.contextNote {
        Text(note).font(.system(size: 10)).foregroundStyle(.tertiary)
      }
      if state.isLoading {
        ProgressView().controlSize(.small)
      } else if let err = state.error {
        Text(err).font(.caption).foregroundStyle(.red)
      } else if !state.answer.isEmpty {
        ScrollView { Text(state.answer).font(.callout).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
          .frame(maxHeight: 220)
        Button("Continue in chat") { app.openDashboard(path: "/?tab=chat") }
          .font(.caption).buttonStyle(.plain).foregroundStyle(.blue)
      }
    }
    .padding(12)
    .frame(width: 320)
    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
  }
}
```

- [ ] **Step 3: `OverlayController.swift`**

```swift
import AppKit
import SwiftUI

@MainActor
final class OverlayController {
  static let shared = OverlayController()
  private var panel: NSPanel?

  private static let enabledKey = "openagi.overlay.enabled"
  private static let frameKey = "openagi.overlay.originX" // y stored alongside

  static var isEnabled: Bool {
    UserDefaults.standard.object(forKey: enabledKey) == nil ? true : UserDefaults.standard.bool(forKey: enabledKey)
  }
  static func setEnabled(_ on: Bool) {
    UserDefaults.standard.set(on, forKey: enabledKey)
    if on { shared.show() } else { shared.hide() }
  }

  func startIfEnabled() { if Self.isEnabled { show() } }

  func show() {
    if panel == nil { panel = makePanel() }
    positionPanel()
    panel?.orderFrontRegardless()
  }

  func hide() { panel?.orderOut(nil) }

  func toggle() {
    if panel?.isVisible == true {
      // toggle expands/collapses rather than hiding entirely
      OverlayState.shared.expanded.toggle()
      sizeToContent()
    } else {
      OverlayState.shared.expanded = true
      show(); sizeToContent()
    }
  }

  private func makePanel() -> NSPanel {
    let p = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: 320, height: 60),
      styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
      backing: .buffered, defer: false)
    p.isFloatingPanel = true
    p.level = .statusBar
    p.hidesOnDeactivate = false
    p.isMovableByWindowBackground = true
    p.backgroundColor = .clear
    p.hasShadow = true
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    let host = NSHostingView(rootView: OverlayView(onCollapse: { [weak self] in self?.sizeToContent() }))
    host.translatesAutoresizingMaskIntoConstraints = true
    p.contentView = host
    return p
  }

  private func sizeToContent() {
    guard let p = panel, let host = p.contentView else { return }
    let fitting = host.fittingSize
    var frame = p.frame
    let newH = max(44, fitting.height)
    frame.origin.y += (frame.height - newH) // keep top-left anchored
    frame.size.height = newH
    frame.size.width = OverlayState.shared.expanded ? 320 : 44
    p.setFrame(frame, display: true, animate: false)
  }

  private func positionPanel() {
    guard let p = panel, let screen = NSScreen.main else { return }
    let d = UserDefaults.standard
    if d.object(forKey: Self.frameKey) != nil {
      let x = d.double(forKey: Self.frameKey)
      let y = d.double(forKey: "openagi.overlay.originY")
      p.setFrameOrigin(NSPoint(x: x, y: y))
    } else {
      // default: bottom-right inset
      let vf = screen.visibleFrame
      p.setFrameOrigin(NSPoint(x: vf.maxX - 360, y: vf.minY + 80))
    }
    sizeToContent()
  }

  func persistPosition() {
    guard let p = panel else { return }
    UserDefaults.standard.set(Double(p.frame.origin.x), forKey: Self.frameKey)
    UserDefaults.standard.set(Double(p.frame.origin.y), forKey: "openagi.overlay.originY")
  }
}
```

- [ ] **Step 4: Build**

Run: `cd mac && swift build 2>&1 | tail -20` → succeeds. Fix any compile errors (SwiftUI `onCommit` is deprecated but compiles; if the toolchain rejects it, switch the TextField to `.onSubmit { Task { await state.ask() } }`).

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/OpenAGI/Overlay/
git commit -m "feat(mac): floating overlay panel, view, and ask view-model

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Swift — global hotkey + app/tray wiring

**Files:**
- Create: `mac/Sources/OpenAGI/Overlay/HotkeyManager.swift`
- Modify: `mac/Sources/OpenAGI/AppDelegate.swift`
- Modify: `mac/Sources/OpenAGI/TrayController.swift`

- [ ] **Step 1: `HotkeyManager.swift` (Carbon, ⌥Space)**

```swift
import AppKit
import Carbon.HIToolbox

// System-wide hotkey via Carbon RegisterEventHotKey (needs no Accessibility
// permission). Default: ⌥Space. Fires onHotkey on the main actor.
@MainActor
final class HotkeyManager {
  static let shared = HotkeyManager()
  private var ref: EventHotKeyRef?
  private var handler: EventHandlerRef?
  var onHotkey: () -> Void = {}

  func register() {
    var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: OSType(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, _, userData -> OSStatus in
      let me = Unmanaged<HotkeyManager>.fromOpaque(userData!).takeUnretainedValue()
      Task { @MainActor in me.onHotkey() }
      return noErr
    }, 1, &eventType, Unmanaged.passUnretained(self).toOpaque(), &handler)

    let hotKeyID = EventHotKeyID(signature: OSType(0x4F41_4749 /* 'OAGI' */), id: 1)
    let status = RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), hotKeyID, GetApplicationEventTarget(), 0, &ref)
    if status != noErr { NSLog("OpenAGI: hotkey registration failed (\(status)) — tray-only") }
  }

  func unregister() {
    if let ref { UnregisterEventHotKey(ref) }
    if let handler { RemoveEventHandler(handler) }
    ref = nil; handler = nil
  }
}
```

- [ ] **Step 2: Wire into `AppDelegate.applicationDidFinishLaunching`**

Inside the `Task { @MainActor in ... }` block, after `ReplayController.shared.start()`, add:
```swift
      OverlayController.shared.startIfEnabled()
      HotkeyManager.shared.onHotkey = { OverlayController.shared.toggle() }
      HotkeyManager.shared.register()
```
And in `applicationWillTerminate`'s `Task { @MainActor in ... }`, before `DaemonController.shared.stop()`, add:
```swift
      OverlayController.shared.persistPosition()
      HotkeyManager.shared.unregister()
```

- [ ] **Step 3: Tray toggle + Quick Ask item in `TrayController.swift`**

In `footerSection`, just above the existing `Toggle("Open at Login", ...)`, add:
```swift
      Button("Quick Ask  ⌥Space") { OverlayController.shared.toggle() }
      Toggle("Enable Quick Ask", isOn: Binding(
        get: { OverlayController.isEnabled },
        set: { OverlayController.setEnabled($0) }
      ))
```

- [ ] **Step 4: Build**

Run: `cd mac && swift build 2>&1 | tail -20` → succeeds.

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/OpenAGI/Overlay/HotkeyManager.swift mac/Sources/OpenAGI/AppDelegate.swift mac/Sources/OpenAGI/TrayController.swift
git commit -m "feat(mac): ⌥Space global hotkey + tray Quick Ask toggle, wired in

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# Phase 2 — Proactive nudges in the pill

### Task 6: Swift — render nudges in the expanded panel

**Files:**
- Modify: `mac/Sources/OpenAGI/Overlay/OverlayView.swift`

The badge on the collapsed pill already reflects `app.nudges.count` (Task 4). Now show the list when expanded and let the user act.

- [ ] **Step 1: Add a nudges section to `expandedPanel`**

In `OverlayView.expandedPanel`, after the answer block (inside the `VStack`), add:
```swift
      if !app.nudges.isEmpty {
        Divider()
        Text("Nudges").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
        ForEach(app.nudges.prefix(4)) { n in
          HStack(alignment: .top, spacing: 6) {
            VStack(alignment: .leading, spacing: 1) {
              Text(n.title).font(.system(size: 11, weight: .medium))
              if !n.body.isEmpty { Text(n.body).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(2) }
            }
            Spacer()
            Button(action: { app.openDashboard(path: "/?tab=chat&suggestion=\(n.id)") }) {
              Image(systemName: "arrow.up.right.square")
            }.buttonStyle(.plain).help("Review in chat")
            Button(action: { app.nudges.removeAll { $0.id == n.id } }) {
              Image(systemName: "xmark")
            }.buttonStyle(.plain).help("Dismiss")
          }
        }
      }
```

(Reviewing a nudge routes into the dashboard chat with the suggestion id — reusing the existing approve/dismiss surface — and "Dismiss" just clears it from the pill. This keeps Phase 2 backend-free, per the spec.)

- [ ] **Step 2: Build**

Run: `cd mac && swift build 2>&1 | tail -20` → succeeds.

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/OpenAGI/Overlay/OverlayView.swift
git commit -m "feat(mac): show proactive nudges in the overlay panel

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** Add a short "Floating widget (Quick Ask)" subsection: ⌥Space (or the tray) opens a floating pill to ask OpenAGI about whatever you're looking at; answers are grounded in the focused window via on-device OCR (honors the capture exclusion list; needs Screen Recording permission, degrades gracefully without it); proactive nudges appear in the pill. Toggle it from the tray ("Enable Quick Ask").

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: floating widget (Quick Ask)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Manual smoke checklist (for the user — not automated)

Document in the PR body. The user runs the packaged app and verifies:
- [ ] ⌥Space toggles the pill/panel from any app (incl. a fullscreen app).
- [ ] The panel floats above other windows and doesn't steal focus (you can keep typing in the app behind it).
- [ ] Asking a question about the visible window returns an answer that reflects on-screen content (Screen Recording granted).
- [ ] With an excluded app frontmost (e.g. 1Password), the answer notes "no screen context" and nothing is OCR'd.
- [ ] A proactive suggestion shows a badge on the pill and appears in the panel's Nudges list.
- [ ] "Enable Quick Ask" off in the tray hides the widget; on shows it; position persists across restarts.

---

## Final verification
- [ ] `node --test` — full suite green (Task 1's test included).
- [ ] `cd mac && swift build` — compile-clean.
- [ ] `grep -rn "formatScreenContextBlock" src test` — used + tested.
