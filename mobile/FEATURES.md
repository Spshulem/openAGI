# OpenAGI mobile — the remote surface

What a phone can do with OpenAGI. Both apps implement this same surface; they
share no code, so the list below is the contract that keeps them equivalent.

Every route here is **already permitted** by the mobile node allowlist in
`src/mobile-node.js`. Building these screens does not widen the security
boundary, and must not: if a screen seems to need a route that is not on the
list, that is a design question to raise, not an allowlist entry to add.

## Navigation

Five destinations. On iOS a `TabView`; on Android a `NavigationBar`.

| Tab | Purpose |
|---|---|
| Today | Today's tasks, the daily brief, the thing the widget mirrors |
| Tasks | Everything, by bucket, with full editing |
| Inbox | Approvals and clarifications — anything waiting on you |
| Chat | Talk to OpenAGI |
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
- The question, the task it belongs to, and a free-text answer.

Routes: `GET /pending-actions`, `POST /pending-actions/{id}/approve`,
`POST /pending-actions/{id}/deny`, `GET /tasks/clarifications`,
`POST /tasks/clarifications/{id}/answer`.

## Chat

The one that makes the phone genuinely useful away from the desk.

- A conversation view: your message, then OpenAGI's reply.
- Send with `POST /message`.
- **Stream the reply over SSE** (`GET /events`), rendering tokens as they
  arrive rather than waiting for the whole answer. A reply that takes 20 seconds
  must show progress within one.
- The stream also carries the events the rest of the app cares about —
  `task-updated`, `task-reminder`, `task-auto-changed`, `pending-action`,
  `pending-action-resolved`, `clarification-created`. When one arrives, refresh
  the affected surface and update the Inbox badge. This is what makes the app
  feel live rather than polled.
- The connection line doubles as the stream indicator: filled while the SSE
  stream is attached.
- Reconnect with backoff when the stream drops. Never silently stay dead.

Routes: `POST /message`, `GET /events`.

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
