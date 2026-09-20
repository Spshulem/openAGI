# OpenAGI native mobile apps (iOS + Android)

## Outcome

The owner of an OpenAGI daemon can pair a phone as a first-class node and,
from the phone, see and work their task list, approve or deny pending
actions, talk to the agent by voice or text, and read the daily brief,
digest, and recap. A home-screen widget shows the current `today` bucket and
the count of pending approvals, refreshes on its own, and completes a task
with one tap.

The phone is a *node*, not a new account and not a cloud service. Nothing
about the local-first, no-telemetry, no-cloud property of OpenAGI changes.

## Non-goals

- No cloud relay, no hosted backend, no push-notification service. The phone
  reaches the daemon directly over the owner's tailnet or LAN.
- No memory browser, skills/specialist management, node topology admin, or
  budget/model settings in the app. Those stay in the desktop interface.
- No multi-user, multi-tenant, or shared-device support. One owner, one
  daemon, N of that owner's own phones.
- No re-implementation of agent logic on device. The phone is a client.

## Platform decisions

| Decision | Choice |
|---|---|
| Native, two codebases | Swift/SwiftUI + WidgetKit; Kotlin/Compose + Glance |
| Cadence | iOS and Android land each phase together |
| Location | `mobile/ios/` and `mobile/android/` in the `openAGI` repo |
| Transport | HTTP + SSE to the daemon over Tailscale or LAN |
| Chat | Text and voice from the first full-app phase |

Two codebases means two implementations of the same client protocol. The
protocol is written down once (`mobile/PROTOCOL.md`) and both clients are
tested against the same fake-daemon fixtures so they cannot drift silently.

## Architecture

```
┌─────────────────────┐        ┌──────────────────────────────┐
│ iOS app  │ Widget   │        │  Mac / Linux                 │
│ Android  │ Widget   │ ◄────► │  openagi daemon :43210       │
└─────────────────────┘  tail  │  HTTP + SSE, node-scoped auth│
   shared on-device cache      └──────────────────────────────┘
```

Each app has four layers:

1. **Transport** — HTTP client, SSE client, bearer + node-id headers, retry
   and backoff, reachability. Knows nothing about tasks.
2. **Protocol** — typed request/response models mirroring `PROTOCOL.md`.
   Pure data; no I/O.
3. **Store** — the on-device snapshot plus the outbound mutation queue. The
   single source of truth for both the app UI and the widget.
4. **Surfaces** — app screens (SwiftUI / Compose) and widget
   (WidgetKit / Glance), both reading the store.

The widget never talks to the network on its own on iOS; it renders the
store and asks the host app to refresh. On Android the refresh worker runs
in the app process and writes the same store.

## Pairing and authentication

Reuses the existing node enrollment flow with a new platform.

1. Owner runs `openagi pair --platform ios` (or `android`) on the machine,
   which calls `POST /nodes/enrollment-code` and renders a QR encoding
   `openagi://pair?url=<daemon-url>&code=<6-digit>`.
2. The phone scans it, `POST /nodes/enroll/exchange` with `{code, platform}`,
   and receives one node id and one node-scoped token.
3. The token goes to the iOS Keychain in a shared access group (so the widget
   extension can read it) with `kSecAttrAccessibleAfterFirstUnlock`, or to
   Android `EncryptedSharedPreferences` backed by Keystore. It is never
   written to `UserDefaults`, `SharedPreferences`, logs, or the snapshot file.
4. The phone heartbeats `POST /nodes/heartbeat` every 30s while foregrounded
   and once per background refresh, so the daemon's Nodes view shows it.
5. `POST /nodes/revoke` from the app's settings, or removal from the desktop
   Nodes tab, kills it. A revoked token fails the next request and the app
   returns to the pairing screen without wiping the local snapshot.

### Authority boundary

The G2 wearable deliberately gets a narrow credential. The phone is a
*full client*, so it needs a wider one — but it must be an explicit, named
scope, not an accidental one. Add a `mobile` node platform whose credential is
accepted for exactly:

- `GET /tasks`, `POST /tasks`, `GET /tasks/:id`, `PATCH /tasks/:id`,
  `POST /tasks/:id/complete`, `DELETE /tasks/:id`
- `GET /tasks/clarifications`, `POST /tasks/clarifications/:id/answer`
- `GET /pending-actions`, `POST /pending-actions/:id/approve`,
  `POST /pending-actions/:id/deny`
- `POST /message`, `GET /events`
- `GET /brief/today`, `POST /brief/focus/dismiss`, `GET /recap/daily`,
  `GET /plan/daily`, `GET /outreach/digest`
- `POST /nodes/heartbeat`, `POST /nodes/revoke`, `POST /nodes/speech-token`
- `GET /mobile/summary`

and rejected everywhere else — notably `/control/*`, `/nodes/control/*`,
`/admin/*`, `/setup*`, `/mcp/*`, `/skills/*`, `/memory*`, `/computer-use/*`.
This is enforced the same way `g2NodeRouteAllowed` is enforced today, in the
single gate in `hosted-interface.js`, and covered by a test that asserts a
`mobile` credential is refused on a representative route from each excluded
family.

### Reachability

The daemon binds loopback by default and refuses a non-loopback bind without
`OPENAGI_AUTH_TOKEN` (`boot.js` bind-safety check). That check stays. Pairing
therefore has a precondition: the owner has bound the daemon to a tailnet or
LAN address with a token set. `openagi pair` detects a loopback-only bind and
prints the exact remediation instead of issuing a code that cannot be used.

The app refuses cleartext `http://` unless the host is a tailnet address
(`*.ts.net`, `100.64.0.0/10`) or an RFC1918 LAN address; anything else must be
`https://`. iOS ships a narrow ATS exception for those; Android ships an
equivalent network-security config. The tailnet case is not "plaintext on the
internet" — WireGuard is the encryption layer — and the allowlist is what keeps
that true.

## Data flow and sync

**Snapshot.** One versioned JSON document in the shared container (iOS App
Group, Android app files dir readable by Glance): today's tasks, counts per
bucket, pending-action count and summaries, brief headline, `fetchedAt`, and
the daemon's ETag. Written atomically. Both the app and the widget read it;
only the app writes it.

**Refresh triggers.** App foreground; pull-to-refresh; SSE event received
while foregrounded (`task-updated`, `task-reminder`, `task-auto-changed`,
`pending-action`, `pending-action-resolved`, `clarification-created`);
background refresh (`BGAppRefreshTask` on iOS, 15-minute periodic
`WorkManager` job on Android); and after any successful mutation.

**Widget refresh.** The widget reloads its timeline when the snapshot
changes. Absent that, iOS is limited to the system's background budget and
Android to the 15-minute `WorkManager` floor. The widget therefore always
renders its own staleness ("as of 14m ago") and shows a distinct
"can't reach OpenAGI" state rather than silently showing old data as current.

**Mutations.** Tap-to-complete on the widget is an `AppIntent` (iOS 17+) /
Glance action that (1) writes the optimistic result to the snapshot, (2)
appends to the outbound queue, (3) reloads the widget. The queue drains on the
next app run or background refresh. Server completes are effectively
idempotent — replaying a complete on an already-completed task is a no-op —
so replay needs no server-side idempotency key. A `404` or `409` on replay
retires the queued op and forces a full refresh rather than retrying forever.
Every mobile-originated completion sends `completedVia: "mobile"` so the
daemon's own accounting can tell them apart.

**Conflict rule.** Server state wins on every full refresh. Optimistic local
state survives only until the next successful fetch that contradicts it.

## New daemon endpoint

`GET /mobile/summary` — one round trip for a widget refresh, returning today's
tasks, per-bucket counts, pending-action count and top summaries, and the
brief headline, with an `ETag` so an unchanged refresh is a `304`. This exists
because a widget refresh budget is too small to spend on four sequential
requests, and because a 304 makes the common background refresh nearly free.

## Voice

Push-to-talk, explicit, foreground-only. No always-listening, no wake word.

1. Hold the mic button; the app requests a scoped streaming-STT grant from
   `POST /nodes/speech-token` (today's `/nodes/g2/speech-token`, generalized to
   accept any node platform; the G2 path stays as an alias so the existing
   wearable client keeps working).
2. Audio streams from the phone to the STT provider with that grant. Audio is
   never persisted on the device and never posted to the daemon.
3. The final transcript is sent as `POST /message` with streaming enabled; the
   reply streams into the chat view token by token.
4. Replies are spoken with the platform TTS (`AVSpeechSynthesizer` /
   Android `TextToSpeech`), mutable per-message and globally.

If the grant request fails, voice degrades to the keyboard with a visible
reason. Voice is never the only path to any function.

## Surfaces

**Widget** (small, medium, large on both platforms) — today's tasks with
tap-to-complete, pending-approval count, staleness/offline state. Large adds
the brief headline.

**App** — Tasks (bucket-grouped list, create, edit, complete, clarification
answers), Approvals (pending actions with the tool call and arguments, approve
/ deny with reason), Chat (streaming text + push-to-talk voice), Today (brief,
plan, recap, digest), Settings (pairing status, daemon URL, heartbeat, revoke,
voice preferences).

## Phases

**Phase 1 — pairing + widget. Shipped.** Transport, protocol, store, pairing,
`mobile` platform scope server-side, `GET /mobile/summary`, widget on both
platforms with tap-to-complete, background refresh, offline queue. Minimal
host app: pair, view today, settings.

One deliberate divergence from this document as written: `pair-phone` never
grew a QR encoder. The CLI prints a manual server-address-plus-six-digit-code
pair and an `openagi://pair` deep link (openable via a saved note, a message
to yourself, or `xcrun simctl openurl` on a simulator); a hand-rolled QR
encoder was not worth several hundred lines of code against a two-field,
once-per-phone flow. Everything else in this document matches what shipped —
see `mobile/README.md` for how to build, pair, and verify it, and
`mobile/PROTOCOL.md` for the exact wire contract.

**Phase 2 — full app.** Task management, approvals, clarifications, streaming
text chat, SSE-driven live refresh.

**Phase 3 — voice + Today.** Speech-token generalization, push-to-talk, TTS,
brief/plan/recap/digest.

Each phase ships iOS and Android together and is independently useful.

## Testing

- **Fake daemon** — one fixture server implementing the documented protocol,
  including 401/403/404/409, slow responses, and mid-stream SSE disconnects.
  Shared by both platforms so both are held to the same contract.
- **Protocol drift test** — fixtures are generated from the real daemon's
  responses and checked in; a daemon change that breaks a client fails in CI
  on the Node side, not months later on a phone.
- **Store tests** — optimistic completion, queue replay, replay against a
  404/409, conflict resolution, atomic snapshot write under interruption.
- **Widget snapshot tests** — XCTest snapshot on iOS, Roborazzi on Android,
  for fresh / stale / offline / empty / unpaired states.
- **Server tests** — the `mobile` scope allowlist (accepted routes and a
  refusal from each excluded family), enrollment with the new platform,
  `/mobile/summary` shape and ETag/304 behavior.
- **Manual hardware pass** — real phone, real daemon, over Tailscale: pair,
  complete from widget with the app killed, go offline and replay, revoke and
  recover.

## Risks and accepted limits

| Risk | Disposition |
|---|---|
| Daemon asleep or off-tailnet → stale widget | Accepted. Widget shows staleness explicitly. |
| No push → no instant nudges | Accepted for v1. A relay is a separate future spec. |
| iOS background refresh budget is not guaranteed | Accepted; the widget never claims freshness it lacks. |
| Node token has no expiry or refresh | Matches today's node model. Revocation is the mitigation. |
| Broader mobile scope widens blast radius of a stolen phone token | Explicit allowlist, Keychain/Keystore storage, one-tap revoke. |
| Two codebases drift | Shared written protocol plus shared fixtures; lockstep phases. |
