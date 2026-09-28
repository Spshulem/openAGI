# OpenAGI mobile — the remote surface

What a phone can do with OpenAGI. Both apps implement this same surface; they
share no code, so the list below is the contract that keeps them equivalent.

Every route here is **already permitted** by the mobile node allowlist in
`src/mobile-node.js`. Building these screens does not widen the security
boundary, and must not: if a screen seems to need a route that is not on the
list, that is a design question to raise, not an allowlist entry to add.

## Navigation

Six destinations. On iOS a `TabView`; on Android a `NavigationBar`.

| Tab | Purpose |
|---|---|
| Today | Today's tasks, the daily brief, the thing the widget mirrors |
| Tasks | Everything, by bucket, with full editing |
| Inbox | Approvals and clarifications — anything waiting on you |
| Chat | Talk to OpenAGI |
| Supervisor | Every coding thread the fleet supervisor watches, worst first |
| Settings | Connection, refresh, revoke |

The Inbox tab carries a badge with the count of items waiting. That count is the
one number worth interrupting someone for.

## Today

- Today's tasks, tappable to complete, matching the widget exactly.
- The daily brief headline above the list (`GET /brief/today`).
- Pull to refresh. The connection line shows the real sync state.
- Below the list: the day's shape in one sentence — "2 left today, 1 this week".

Routes: `GET /mobile/summary`, `GET /brief/today`, `POST /tasks/{id}/complete`,
`POST /brief/focus/dismiss`.

## Tasks

The full manager, not a filtered view.

- Sectioned by bucket: today, this week, this month, this quarter, this year,
  someday, done. Collapsed sections remember their state.
- Create: title, bucket, priority, optional due date. (`POST /tasks`)
- Edit: tap a row to open detail — change title, bucket, priority, due date,
  status. (`GET /tasks/{id}`, `PATCH /tasks/{id}`)
- Complete from any row. (`POST /tasks/{id}/complete`, always with
  `completedVia: "mobile"`)
- Delete, with confirmation. (`DELETE /tasks/{id}`)
- Filter by queue: yours or the agent's.

Routes: `GET /tasks`, `POST /tasks`, `GET|PATCH|DELETE /tasks/{id}`,
`POST /tasks/{id}/complete`.

## Inbox

Two kinds of thing need you, and they belong together.

**Approvals** — actions OpenAGI wants to take and is waiting on.
- List with the summary, the tool, and when it was raised.
- Detail shows the full arguments and the reason it was proposed, so you are
  approving something you have actually read.
- Approve or deny, each with an optional note.

**Clarifications** — questions the agent has asked you.
- The question, the task it belongs to, and the answer. The daemon accepts one
  of four fixed values, not free text — present them as four choices, because a
  text field that rejects most of what you type into it is a worse interface
  than four buttons.

Routes: `GET /pending-actions`, `POST /pending-actions/{id}/approve`,
`POST /pending-actions/{id}/deny`, `GET /tasks/clarifications`,
`POST /tasks/clarifications/{id}/answer`.

## Chat

The one that makes the phone genuinely useful away from the desk.

- A conversation view: your message, then OpenAGI's reply.
- Send with `POST /message` and `"thread": "agent"`: one shared thread for
  every paired phone and G2 (PROTOCOL.md §3.1). A message another device sent
  is labelled with that device's name.
- Load the thread from `GET /conversations/agent/messages` when the screen
  opens, after each reply, and on the `conversation.updated` event. The
  daemon's thread is the history; the phone's copy is an offline cache.
- **The reply streams from `POST /message` itself**, not from `GET /events` —
  `/events` is the daemon's ambient event feed, not the chat transport. Render
  tokens as they arrive rather than waiting for the whole answer; a reply that
  takes 20 seconds must show progress within one.
- `GET /events` runs separately and carries the events the rest of the app
  cares about —
  `task-updated`, `task-reminder`, `task-auto-changed`, `pending-action`,
  `pending-action-resolved`, `clarification-created`, `conversation.updated`.
  When one arrives, refresh
  the affected surface and update the Inbox badge. This is what makes the app
  feel live rather than polled.
- The connection line doubles as the stream indicator: filled while the SSE
  stream is attached.
- Reconnect with backoff when the stream drops. Never silently stay dead.

Routes: `POST /message`, `GET /conversations/agent/messages`, `GET /events`.

## Supervisor

The fleet supervisor (`src/fleet/`) watches every Codex, Claude and Conductor
coding thread and says which ones need you. This tab is its phone view.

- **Header:** a mode control — Observe / Propose / Auto. Switching to Auto
  asks first, because Auto sends preset nudges to agents by itself. Under it,
  the mode's one-line meaning, "Scanned 3m ago · Auto-scan on", and a single
  `alert` line when the last scan failed or a source could not be read. Two
  buttons: **Scan now** (a scan can take up to ~100s) and **Ask supervisor**.
- **Needs you:** each open question with its title, body, the thread and PR
  it is about, and one button per option plus Dismiss. The result shows
  inline: "Sent to the agent.", or "Saved. Couldn't reach the agent: …" when
  the answer was kept but the relay failed. An answer can take up to ~190s.
- **Threads:** a count line ("3 red · 5 yellow · 12 green"), then every
  thread sorted red, yellow, green, gray, most recent first within a colour.
  A row is a health dot plus the colour named in words (colour is never the
  only signal), the name (workspace, else title), the state in plain words,
  a one-line reason, a PR chip (`#112 · CI failing`) and the last activity.
- **Thread detail** (a sheet): repo and branch in mono, health, reason,
  blockers, the PR (tap to open it in the browser), the supervisor's next
  step and why, any error, the last agent message in mono, and — in Propose
  mode — each proposed nudge for that thread with a Send button.
- **Ask supervisor** opens the Chat screen titled "Supervisor", on its own
  conversation, with three starters: "What's running?", "What needs me?",
  "Which threads are red?". It sends `"thread": "supervisor"`, the shared
  supervisor thread every paired device talks in, and loads it like Chat
  from `GET /conversations/supervisor/messages`. The agent has two read-only
  tools for it, `fleet_status` and `fleet_thread`.
- Pull to refresh; refreshes every 30s while on screen (every 5s while a scan
  runs). Nothing is optimistic — a mode, answer or send shows once the daemon
  confirms it.
- A daemon without a supervisor (a 404 or 503 on these routes) shows
  "Supervisor isn't running on this daemon." instead of an error.

Health is a field on every thread. When a daemon does not send it, the phone
derives the same thing from `state`:

| Health | States |
|---|---|
| green | `running`, `waiting-ci`, `local-verify`, `asked-in-scope`, `done` |
| yellow | `pr-not-ready`, `idle-no-pr`, `ready-needs-human` |
| red | `needs-human`, `infra-blocked`, or any other known state but `running` when the thread has an `error` |
| gray | `excluded`, or a state the phone does not know (even with an `error`) |

Yellow is drawn in one added colour token, `caution`: `#8A5A00` light,
`#E8B64C` dark — fixed like `live` and `alert`, 4.5:1 on `surface` in both.

Routes: `GET /fleet/api/state`, `POST /fleet/api/scan`,
`POST /fleet/api/mode` (`{mode}`), `POST /fleet/api/questions/{id}`
(`{answer}` or `{dismiss: true}`), `POST /fleet/api/actions/{id}/send`,
`POST /message` (`thread`: `"supervisor"`), `GET /conversations/supervisor/messages`. The `/fleet/api/*` routes
join the mobile allowlist for this tab; they read and steer the supervisor
and nothing else.

## Lifelog

A read-only view of what the paired G2s captured with consent, opened from
Today (Android) — there is no room for a seventh tab.

- Moments by day, newest first: title, time range, device name, the review
  summary when there is one, and the transcript on tap.
- Search box (words, speaker labels, topics) and a day picker; "Any day"
  clears it.
- Nothing here edits or deletes; that stays on the owner's dashboard.

Routes: `GET /lifelog/moments` (`date`, `query`, `limit`).

## Settings

- The connection: host, node id, when it last synced. Host and id in mono.
- Refresh now.
- Revoke this phone — clears the credential, the snapshot and the outbox, and
  tells the daemon. Confirmation required.
- Build version, so a bug report can name one.

Routes: `POST /nodes/revoke`, plus the local stores.

## Daily surfaces

Reachable from Today, not their own tab.

- Daily plan (`GET /plan/daily`)
- Daily recap (`GET /recap/daily`)
- Digest (`GET /outreach/digest`)

Each is read-only prose. Render it well and get out of the way.

## Deliberately absent

Not oversights. These stay off the phone because the node credential must not
reach them: memory (`/memory`), skills (`/skills`), computer-use
(`/computer-use/*`), daemon control (`/control/*`), node administration
(`/nodes` roster, `/nodes/control/*`), budget, integrations and setup.

A phone is the device most likely to be lost. Its credential opens the things
you need on the move and nothing else.

## Behaviour that applies everywhere

- **Offline is a normal state, not an error.** Every screen renders from the
  last snapshot when the daemon is unreachable, with the connection line saying
  so. Completions queue and replay.
- **Optimistic where it is safe.** Completing a task updates immediately and
  reconciles on the next fetch. Approving does not — an approval waits for the
  server, because a wrongly-shown approval is worse than a slow one.
- **Every mutation names its origin**: `completedVia: "mobile"`.
- **Errors say what to do.** See DESIGN.md's copy rules.
