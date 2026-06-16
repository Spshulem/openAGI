# Proactive Outreach — design

**Date:** 2026-06-16
**Status:** Approved design, pre-implementation
**Topic:** Surface the brain's proactive output (suggestions, drafts, stalled tasks, decisions) to the user instead of letting it pile up unseen.

## Problem

The Distiller (the "main" brain) is detecting proactive work correctly, but almost none of it reaches the user. A live snapshot of one Distiller showed **67 drafts, 11 pending suggestions, 2 pending actions, 50 tasks** — all detected, none surfaced.

Root causes (from a code + live audit):

1. **Proactive events are fire-and-forget SSE.** `hosted-interface.js` broadcasts events (`proactive-suggestion`, `draft-created`, `clarification-created`, `pending-action`, `daily-plan`) only to dashboard clients connected *at that instant*. No client connected → the event is lost forever. Nothing is persisted for replay.
2. **The Mac app watches the wrong brain.** The menubar app's SSE/poll points at its *own local daemon* (`127.0.0.1`), not the Distiller. Even when open, it never sees the Distiller's queue.
3. **iMessage is reply-only.** No "reach out first" path. SMS outbound isn't configured. Telegram outbound *is* configured but isn't wired to proactive events.

The philosophy (README) says the agent should "watch activity and reach out unsolicited." The detection exists; the **delivery last mile** was never built for push channels.

## Goals

- The brain's proactive output reliably reaches the user — nothing lost when no client is connected.
- A **digest + live-decision** model: rolled-up digests on a frequent cadence, plus immediate pings only for items that need a yes/no decision.
- The user can **act inline** — quick buttons for the common case, freeform chat reply for nuance — from the Mac notification / floating overlay.
- Quiet overnight.

## Non-goals (explicit scope boundaries)

- **No changes to detection.** The observer, miners, daily-planner, clarification/draft/pending-action stores stay exactly as they are. This is a delivery layer downstream of them.
- **Screen-based local proactivity** (the Mac app's local daemon OCR stream) is out of scope — this design delivers the *Distiller's* integration-driven output. Screen nudges can be folded in later.
- **Full "remote main" migration of the Mac app** is out of scope. Only the new outreach feed goes remote; the rest of the app is untouched.
- **Telegram/iMessage transports** are out of scope for the first build but the config/architecture leaves them as a drop-in transport.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Primary destination | **Mac app** (notifications + overlay) |
| Surfacing model | **Digest + live decisions** (backlog never spams; only decisions ping live) |
| Response model | **Inline buttons + chat reply** (uses the existing floating bar) |
| Cadence | **Frequent** (digest every few hours, waking) |
| Quiet hours | Silent overnight; overnight items roll into the next digest |
| Build approach | **A** — server-side Outreach engine + Mac app as durable consumer |

## Architecture

A new **Outreach engine** on the Distiller sits *downstream* of existing detection. It subscribes to events the brain already emits, turns each into a durable **outreach item**, and exposes a cursor-backed feed. The Mac app becomes a durable consumer of that feed and renders notifications + overlay nudges. The brain owns truth; the app is a renderer.

### Data model — `OutreachItem`

```
OutreachItem {
  id,
  seq,                          // monotonic cursor for durable backfill
  type,                         // suggestion | draft | clarification | pending-action | stalled-task | digest
  sourceRef: { kind, id },      // points back to the real draft/task/suggestion/action
  title,
  summary,
  needsDecision: bool,          // true → live ping (subject to quiet hours); false → digest-only
  actions: [string],            // e.g. ["approve","edit","close","keep","do","dismiss","snooze","accept"]
  status,                       // unseen | seen | acted | dismissed | error
  decision,                     // the action taken + optional note
  error,                        // reason string when delegation fails
  createdAt, resolvedAt
}
```

Persisted to `~/.openagi/outreach/feed.jsonl` + a snapshot, mirroring the existing `draft-store` / `clarification-store` pattern. **Durability is the core fix**: every item persists with a `seq`, so a consumer can ask "everything after `seq N`" and never miss anything.

### Two delivery lanes

- **Live decisions** (`needsDecision: true`) — `stalled-task`, `pending-action`, `clarification`. Pushed immediately, subject to quiet hours.
- **Digest** (`needsDecision: false`) — `draft`, `suggestion`. Rolled up and delivered on the configured cadence.

## Components — server (Distiller)

1. **`OutreachStore` (`src/outreach-store.js`)** — durable append-only log. API: `append(item)` (assigns `seq`), `since(cursor)`, `list({status})`, `resolve(id, decision)`, `markSeen(ids)`. Source of truth. Follows the existing file-backed store pattern.

2. **`OutreachMapper`** — a single subscriber on `runtime.events`. Maps each existing event → an outreach item and classifies `needsDecision` + allowed `actions`. The **only** touch-point into detection; the detection modules themselves are unchanged. Examples:
   - `draft-created` → `{type:"draft", needsDecision:false, actions:["approve","edit","dismiss"]}`
   - `proactive-suggestion` → `{type:"suggestion", needsDecision:false, actions:["accept","dismiss"]}`
   - `pending-action` → `{type:"pending-action", needsDecision:true, actions:["do","dismiss"]}`
   - `clarification-created` → `{type:"clarification", needsDecision:true, actions:[<answer options>]}`

3. **`DigestComposer`** — cron job on the configured cadence (every N waking hours). Rolls unseen non-decision items into one `digest` item (e.g. *"12 drafts ready · 3 new suggestions · 2 stalled"*), respecting quiet hours. Emits a `digest` outreach item.

4. **`StalledTaskScan`** — rides the existing hourly `task-sweep` rather than re-implementing staleness. `task-sweep` already *flags* stale non-auto-sourced tasks for review (and auto-cancels stale auto-sourced ones); this component turns each **flagged** task with no activity > `stalledDays` into a `stalled-task` outreach item with `actions:["close","keep","snooze"]` — surfacing the existing flag as a decision instead of silently leaving it in the sweep summary. This is the "haven't heard back — want me to close it?" behavior. Tasks the sweep already auto-cancels are *not* re-surfaced (avoids double-handling).

### Endpoints (`hosted-interface.js`, bearer-auth'd)

- `GET /outreach/feed?since=<cursor>` — durable backfill; the reliability backbone.
- `GET /outreach/digest` — current rollup.
- `POST /outreach/:id/act` `{action, note?}` — **delegates to the real source** (approve→draft-store, close→task cancel, do→pending-action approve, accept→suggestion materialize), then resolves the outreach item. **Idempotent.**
- `POST /outreach/:id/reply` `{text}` — freeform chat reply; the brain interprets intent → action.
- SSE: existing `/events` also emits `outreach` events as a low-latency fast-path. The cursor feed guarantees delivery; SSE is only speed.

## Components — Mac app

1. **Remote-main pointer.** A setting for the Distiller's URL + token (reusing the existing pairing concept). The outreach consumer connects there. Scope-limited: only the outreach feed goes remote; the rest of the app is unchanged.

2. **`OutreachConsumer` (Swift).** Persists a `lastSeq` cursor. On launch/reconnect: `GET /outreach/feed?since=lastSeq` to backfill everything missed, then subscribes to SSE for low latency. Makes "laptop closed for 3 hours" lossless.

3. **Rendering, three surfaces:**
   - **Live decision** → native notification with action buttons (`UNNotificationAction`: *Close it / Keep*, *Approve / Edit*, *Do it / Not now*) + an overlay entry.
   - **Digest** → one notification (*"Your queue: 12 drafts, 3 suggestions, 2 stalled"*) opening the overlay list.
   - **Overlay (floating bar)** → expandable panel lists pending items; each row has the same buttons **plus** the existing chat field, pre-targeted to that item.

4. **Actions wire back:** buttons → `POST /outreach/:id/act`; chat → `POST /outreach/:id/reply`. Tray shows a **badge count** of pending items.

5. **Quiet hours** enforced client-side too: overnight items don't fire notifications; they wait in the overlay and roll into the next digest.

## Configuration

`~/.openagi/outreach.json` (env-overridable; dashboard UI later):

```json
{
  "enabled": true,
  "destination": "mac",
  "cadenceHours": 3,
  "quietHours": { "start": "22:00", "end": "08:00" },
  "stalledDays": 3,
  "liveTypes": ["stalled-task", "pending-action", "clarification"],
  "digestTypes": ["draft", "suggestion"]
}
```

`destination:"mac"` now; the field exists so adding Telegram/iMessage later is config, not code.

## Error handling & reliability

- **Durability is the backbone.** SSE is best-effort; the `since=cursor` feed is the guarantee. App offline → items wait on the Distiller → backfilled on reconnect.
- **Idempotent actions.** Acting on an already-resolved item returns its current state — no double-send. Critical because draft "approve" actually sends something externally.
- **Delegation failures.** If `act` can't reach the underlying source (e.g., draft send-channel down), the item goes `status:"error"` with the reason, stays in the queue, retryable — never silently dropped.
- **Quiet hours.** Items are still *created* overnight, just not *notified*; the next digest catches them.
- **Distiller unreachable from Mac.** Consumer shows "main unreachable," retries with backoff; zero data loss (everything is durable on the Distiller). Note: this path depends on the Tailscale/VPN connectivity already established for this Mac.
- **No new crash paths.** Rides the top-level unhandled-rejection guard shipped in v0.0.8.

## Testing

- **Server (Node `node:test`):**
  - `OutreachStore`: append assigns increasing `seq`; `since(cursor)` returns only newer; `resolve` is idempotent.
  - `OutreachMapper`: each event type maps to the correct item shape + `needsDecision`/`actions` classification.
  - `DigestComposer`: rollup counts; quiet-hours suppression.
  - `StalledTaskScan`: threshold boundary (just-under vs just-over `stalledDays`).
  - `/outreach/*` endpoints: feed backfill, act-delegation to each source, double-act idempotency, reply→intent.
- **Mac:** cursor/backfill logic is the testable core. Notifications + overlay buttons are manual verification — include a verification checklist (backfill on reconnect, button → resolve, chat reply → action, quiet-hours suppression, badge count).

## Future add-ons (out of scope now, enabled by this design)

- **Telegram / iMessage transports** — add a transport behind `destination`; reuses the same Outreach engine. (iMessage also needs a proactive-send path, which is reply-only today.)
- **Screen-based local proactivity** folded into the same feed.
- **Dashboard config UI** for `outreach.json`.
