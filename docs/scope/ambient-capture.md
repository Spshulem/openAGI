# Ambient capture + auto-skill scope

What it would take to add Rewind.ai-style screen + activity capture to the Mac app, feed it into OpenAGI's tiered memory, mine it for repeated patterns, and turn those into runnable skills.

References that inform this scope:

- [alikia2x/openrewind](https://github.com/alikia2x/openrewind) — Swift-native, ScreenCaptureKit + Vision OCR, SQLite FTS5, the cleanest open reference for the capture half.
- [VedankPurohit/LiveRecall](https://github.com/VedankPurohit/LiveRecall) — Python, cross-platform, semantic search over OCR text.
- Rewind.ai (commercial, closed) — the UX bar.

This sits naturally on top of OpenAGI's existing pillars: **scrutiny** decides which observations matter, **memory** absorbs them via the tier system, **propagation** spawns specialists when patterns repeat. So the runtime layer is mostly already there — what we're building is the eyes.

---

## Goals

A user can:

1. Turn on capture once (grant macOS Screen Recording permission) and forget about it.
2. Ask the agent *"what was I working on yesterday at 3pm?"* and get an actual answer with timestamp, app, window title, and OCR-extracted text.
3. See the agent propose new skills when it detects a repeated workflow ("you've opened Linear → Slack → GitHub three Mondays in a row at ~9am — want me to make this a `monday-standup-prep` skill?"), and accept/reject in the dashboard.
4. Have accepted skills auto-replay on schedule, with a confirmation step the first time.

What this scope deliberately **does not** include:

- **Keystroke logging.** Captures passwords, 2FA codes, private DMs. Not worth the risk; activity tracking + OCR gets us most of the way.
- **Cloud sync.** All capture stays local on disk, encrypted by the OS user-dir protections. Optional encryption-at-rest can come later.
- **Audio/microphone capture.** Out of scope. If you want meeting transcription, that's a separate scope.

---

## Reading order

1. **Phase 0 — Foundation.** Capture pipeline (Swift), storage (SQLite FTS5), privacy controls.
2. **Phase 1 — Bridge into OpenAGI.** Mac app posts observations; daemon writes them as ABI signals into memory.
3. **Phase 2 — Search and recall.** Dashboard "Activity" tab; agent gains `recall_activity` tool.
4. **Phase 3 — Pattern mining.** Detect repeating sequences, propose skills.
5. **Phase 4 — Skill replay.** Mac-side execution of accepted skills via AppleScript / Accessibility / Shortcuts.

---

## Phase 0 — Foundation (4–5 days)

### 0.1 Capture pipeline (Swift, ~2 days)

- `mac/Sources/OpenAGI/Capture/ScreenCapturer.swift`:
  - `ScreenCaptureKit` for periodic full-screen snapshots (configurable interval, default 5s, throttled when idle).
  - Active display only; if the user has multiple monitors, optionally each.
  - Skip frames where the foreground app is in the exclusion list (1Password, Apple Wallet, banking sites, etc.).
  - Skip frames where the window title matches an exclusion regex (Incognito / Private / 2FA, etc.).
- `mac/Sources/OpenAGI/Capture/Ocr.swift`:
  - Apple `Vision` framework — `VNRecognizeTextRequest` on each captured frame.
  - On-device, free, fast (~50ms per frame on M1).
  - Returns `[ { text, bbox, confidence } ]`; we keep text + confidence, drop bbox after extraction.
- `mac/Sources/OpenAGI/Capture/Activity.swift`:
  - `NSWorkspace` notifications for `didActivateApplicationNotification`.
  - Periodic poll of frontmost window title via Accessibility API (no keystroke access — read-only window title).
  - Activity events are cheap (small JSON) and emitted on every change, independent of the screen capture interval.

### 0.2 Storage (~1 day)

- SQLite database at `~/Library/Application Support/OpenAGI/capture/index.db`.
- Schema:
  - `frames(id, captured_at, app_bundle, window_title, thumbnail_path)` — pointer to a JPEG on disk (50% quality, throttled).
  - `texts(frame_id, text, confidence)` — FTS5 virtual table for full-text search.
  - `activity(at, app_bundle, window_title, event)` — lightweight stream.
- Retention policy:
  - Frames + thumbnails: 7 days default (configurable).
  - OCR text + activity events: 90 days default.
  - Daily compaction job runs at 03:00.
- Disk-cost guardrail: refuse to write new frames when the capture dir exceeds N GB (default 5).

### 0.3 Privacy panel (~1 day)

- Tray menu adds **Capture** submenu:
  - **Pause / Resume** capture
  - **Open privacy settings** → SwiftUI window
- Privacy window:
  - Toggle: capture enabled
  - List of excluded apps (with "+ add app" picker that uses the running-app list)
  - Window-title regex exclusions
  - Retention sliders (frames N days, text N days)
  - Disk usage indicator + "delete all captures" button
  - "Pause for 1 hour / until tomorrow" quick actions
- macOS Screen Recording permission prompt handled gracefully — link to System Settings.

### 0.4 Disk + permission UX (~0.5 day)

- First-launch banner in dashboard if Screen Recording permission isn't granted.
- Tray icon shows a 🔴 dot when capture is paused or permission missing.

**Phase 0 total: 4–5 days.** End state: Mac app captures + indexes; nothing leaves the machine; dashboard has no idea this is happening yet.

---

## Phase 1 — Bridge into OpenAGI (2 days)

### 1.1 Daemon endpoint (~0.5 day)

- New `POST /observations` route:
  - Accepts batches of activity / frame summaries from the Mac app.
  - Validates structure, enforces rate limits.
  - Each observation becomes an ABI signal of `taskType: "ambient-capture"`.
  - Memory absorbs it via the existing tier system; condenser already distills repeated patterns into principles, so this gets pattern detection partly for free.
- Auth: same bearer token as everything else (Mac app already has it).

### 1.2 Mac → daemon push (~0.5 day)

- `Capture/Bridge.swift`: posts batched observations every 30s.
- Backoff if the daemon is offline (cache locally, replay).

### 1.3 Capture status in `/audit` (~0.25 day)

- Health tab gets a "Capture" card: enabled, frames today, OCR text indexed, disk usage, last batch flushed.

### 1.4 Observation signal shape (~0.75 day)

```json
{
  "kind": "activity",       // "activity" | "frame" | "frame-summary"
  "at": "2026-05-08T15:32:11Z",
  "app": "Linear",
  "window": "Linear · OpenAGI roadmap",
  "ocrText": "…",            // present for frame
  "thumbnail": "/path",      // present for frame, only the daemon's local fs
  "frameId": 12345
}
```

**Phase 1 total: 2 days.** End state: agent's memory has a continuous read-only stream of what you've been doing.

---

## Phase 2 — Search and recall (2 days)

### 2.1 `recall_activity` tool (~0.5 day)

- New agent tool: `recall_activity({ query, since, limit })`.
- Uses SQLite FTS5 directly (much faster than the agent's keyword overlap recall for this volume).
- Returns hits with timestamp, app, window, OCR snippet.

### 2.2 Activity tab in dashboard (~1 day)

- New "Activity" tab.
- Day timeline: hourly buckets showing app focus distribution.
- Search box → FTS5 results inline.
- Click a result → preview the thumbnail + full OCR text.

### 2.3 Auto-prompt suggestions (~0.5 day)

- "What did I work on at 3pm yesterday?" → agent calls `recall_activity` and assembles answer.
- Agent learns to use this proactively for "where did I leave off" / "what was I last doing in X" queries.

**Phase 2 total: 2 days.** End state: you can ask the agent about your past activity and get real grounded answers.

---

## Phase 3 — Pattern mining (2–3 days)

### 3.1 Sequence detector (~1 day)

- New autopilot job `mine-patterns`, runs nightly.
- Walks the activity table; bins by hour-of-day and weekday.
- Identifies sequences of length ≥ 3 that recur ≥ 3 times within the last 14 days.
- Confidence scoring weighs: count, time-of-day stability, sequence rigidity.

### 3.2 LLM proposal (~1 day)

- For each high-confidence sequence, the agent (whichever provider is active) is asked:
  > "User opens X → Y → Z most weekdays at 9am. Propose a SKILL.md (name, description, steps in plain prose, schedule recommendation). Be conservative; if this isn't actually a routine, say 'pass'."
- Output: candidate skill JSON.

### 3.3 Approval queue (~0.5 day)

- Dashboard's Skills tab gains a **Suggested** sub-section: list of pending candidates with "Accept" / "Reject" / "Modify".
- Accepted candidate is written to `.openagi/skills/<name>/SKILL.md`. Skills loader picks it up on next reload.

### 3.4 Pattern-aware autopilot harshness (~0.5 day)

- The weekly harsh review (already exists) gains visibility into how many proposed skills were accepted vs rejected. Recalibrates pattern-mining thresholds over time.

**Phase 3 total: 2–3 days.** End state: skills emerge from your actual workflow, not just things you ask for.

---

## Phase 4 — Skill replay (2–3 days, riskiest)

### 4.1 Action vocabulary (~1 day)

A skill's `steps` block becomes structured:

```yaml
steps:
  - open_app: "Linear"
  - wait: 1.0
  - keyboard_shortcut: "Cmd-K"
  - type: "OpenAGI roadmap"
  - press: "Return"
```

Backed by:
- `open_app` → `NSWorkspace.shared.openApplication(...)`
- `keyboard_shortcut` / `type` / `press` → CGEvent (requires Accessibility permission)
- `applescript` → `NSAppleScript`
- `shortcut` → invoke a macOS Shortcut by name

### 4.2 First-run confirmation (~0.5 day)

- Every accepted skill has a `confirmFirst: true` default.
- On first replay attempt, the dashboard shows a confirmation modal with the action sequence and a dry-run option.
- After first successful confirmed run, skill is marked `confirmed: true`.

### 4.3 Dry-run mode (~0.5 day)

- Mac app accepts a `dryRun: true` flag — instead of executing, it logs each action with what it *would* do.
- Useful for the agent to "think out loud" about a skill before running it.

### 4.4 Skill-failure observation (~0.5 day)

- If a skill fails (e.g. the target app isn't running, accessibility denied), the failure becomes an outcome quality 0 → feeds back into the propagation lifecycle (specialist may be retired).

**Phase 4 total: 2–3 days.** End state: the agent sees you do something, distills it, and after one confirmation can do it for you on schedule.

---

## Totals

| Path | Dev-days | What you ship |
|---|---|---|
| **Capture only (no daemon bridge)** | **4–5** | Mac app records + OCRs locally with privacy panel. No agent integration yet. |
| **Capture + memory bridge + recall** | **8–9** | Agent can answer "what was I doing yesterday" but doesn't propose skills yet. |
| **+ Pattern mining (skill suggestions)** | **10–12** | Skills emerge from observed routines; user accepts/rejects. |
| **Full cycle including replay** | **12–15** | Accepted skills run themselves on schedule. |

## Risks that span the whole scope

- **macOS Screen Recording permission UX.** First grant is jarring; a clear in-app "why we need this" explainer is mandatory.
- **OCR quality.** Vision is good but not perfect; small text, code, dark themes can degrade. Worth shipping; not a blocker.
- **Pattern false positives.** A noisy proposal queue erodes user trust. Threshold confidence high; let users tune.
- **Skill replay reliability.** macOS UI changes break recorded sequences. The Action Vocabulary above is an attempt to abstract this — using app-level actions instead of pixel coordinates.
- **Privacy posture.** Hard rules:
  - Capture data NEVER leaves the machine without explicit user opt-in (e.g., "send this OCR text to GPT-5 to summarize").
  - Daemon → LLM calls should be allowed to *summarize* OCR text but never stream raw frames.
  - Excluded-app list defaults to a sensible starter set (1Password, password managers, banking, private browsing).
  - One-click "delete all captures" with a confirmation in the privacy panel.
- **Disk cost.** Frames at 5s intervals ≈ 1–3 GB/day uncompacted. Retention defaults must be tight.

## Recommended sequence

1. **Phase 0 + Phase 1.1 + 1.4 (5–7 days)** — capture pipeline running, observations bridged into memory, but no agent UI yet. Easiest ship that doesn't change user-facing behavior dramatically and lets you live with the data shape for a few days before doubling down.
2. **Phase 2 (2 days)** — agent can recall activity. Real user value lands here.
3. **Phase 3 (2–3 days)** — pattern mining. Most novel piece.
4. **Phase 4 (2–3 days)** — skill replay. Highest risk; do last when the rest is stable.

Open question: would you want this Mac-only initially (ScreenCaptureKit is macOS), or a Linux variant in parallel using `wlroots`/`xrandr` capture? The Mac capture path is cleaner; Linux x11/wayland capture is a separate scope of its own (~3 days).

## What you can do today instead

If 12+ days of work is too much: most of the *value* is Phase 0.3 (activity tracker — window titles + app focus, no screen capture). That's ~1 day of work and gives the agent ambient context for "what was I doing" without the screen-recording permission friction or disk cost. Can ship as a smaller standalone first slice.
