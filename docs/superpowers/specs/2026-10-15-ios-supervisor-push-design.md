# iOS supervisor push: Live Activity + alerts over an encrypted relay

Date: 2026-10-15. Owner decisions: relay required (App Store customers), relay
sees ciphertext only, relay on Cloudflare Workers, this spec covers the push
pipe only (voice and Supervisor screen parity are later specs).

## Goal

As an owner, I want a lock-screen Live Activity of my running supervisor
tasks and an alert with answer buttons when the supervisor needs me, even
when the app is closed, so I can follow and unblock agents without opening
the app.

Success: with the app killed, a new running fleet thread starts a Live
Activity within seconds; its rows update as threads change; it ends when
nothing is active; a new open question raises an alert whose buttons answer
it. The relay never sees a title, body, option or thread key in plaintext.

## Non-goals

- Android changes (it keeps its foreground service).
- Voice, Supervisor screen parity.
- Multiple daemons per phone (one push registration per paired phone).
- Cancelling a delivered alert when the question closes elsewhere (the app
  clears stale ones when it opens; a later spec can add a background push).

## Parts

```
phone ──register tokens──▶ relay ──pass──▶ phone ──pass + key (tailnet)──▶ daemon
daemon ──pass + ciphertext──▶ relay ──APNs──▶ phone (widget / notification ext decrypts)
```

1. `relay/` — Cloudflare Worker. Holds the APNs .p8 key. Stateless.
2. `src/mobile-push.js` + `src/mobile-push-store.js` — daemon: registrations,
   content building, encryption, diffing, throttling, sending.
3. iOS — push registration, Live Activity UI in the widget extension, a new
   Notification Service Extension, answer handling.

## Shared contracts (all three parts must match exactly)

### Envelope (E2E encryption)

- Key: 32 random bytes the phone generates (`SecRandomCopyBytes`), base64url
  without padding. One per push registration.
- Cipher: AES-256-GCM, 12-byte random nonce, 16-byte tag.
- AAD: UTF-8 `openagi-push:v1:<kind>` where kind is `activity` or `alert`.
- Wire string: `v1.<base64url(nonce)>.<base64url(ciphertext || tag)>`.
- Plaintext: UTF-8 JSON (below). Node: `crypto.createCipheriv("aes-256-gcm")`.
  Swift: `AES.GCM.SealedBox(nonce:ciphertext:tag:)`.
- Fixture: `mobile/fixtures/push-envelope.json` holds a key, kind, plaintext
  and wire string; Node and Swift tests both decrypt it.

### Activity plaintext (kind `activity`)

```json
{ "at": "2026-10-15T12:00:00.000Z",
  "counts": { "you": 1, "working": 2, "waiting": 1 },
  "rows": [ { "key": "codex:abc", "title": "Fix login", "group": "you",
              "waitingOn": "your answer", "since": "2026-10-15T11:58:00.000Z" } ] }
```

- Active thread: `snapshot.threads[].watch.group` in `you | working | waiting`.
- Rows: at most 3, ordered you → working → waiting, then most recent `since`.
  `title` ≤ 60 chars, `waitingOn` ≤ 40, nulls allowed for `waitingOn`/`since`.

ActivityKit types (iOS, shared by app and widget):

- `SupervisorActivityAttributes: ActivityAttributes` with stored `slot: String`
  (always `"fleet"`), and `ContentState: Codable, Hashable { var sealed: String }`.

### Alert plaintext (kind `alert`)

```json
{ "questionId": "fq123", "title": "≤100 chars", "body": "≤220 chars",
  "options": ["Approve", "Skip"], "threadKey": "codex:abc" }
```

- Options exclude `dismiss` and `open thread` (case-insensitive), max 3,
  same rule as Android `SupervisorAlerts.kt`.

### Relay HTTP API (`relay/`)

All JSON. Errors: `{ "error": "<code>" }`.

`POST /v1/register` — body `{ deviceToken, startToken, env }`:

- `deviceToken`, `startToken`: hex strings (APNs device token, Live Activity
  push-to-start token). `env`: `sandbox` | `production`.
- Relay creates one broadcast channel (`message-storage-policy: 1`,
  `push-type: LiveActivity`) on the APNs channel-management host
  (`api-manage-broadcast[.sandbox].push.apple.com:2196`,
  `POST /1/apps/<bundleId>/channels`, channel id in `apns-channel-id`).
- Returns `{ pass }`. `pass` = `p1.<nonce>.<ct+tag>`: AES-256-GCM with the
  Worker secret `PASS_KEY`, AAD `openagi-relay-pass:v1`, plaintext
  `{ d: deviceToken, s: startToken, ch: channelId, env, iat }`.

`POST /v1/send` — body `{ pass, type, sealed, collapseId?, staleAt?, dismissAt? }`:

- `type`: `alert` | `activity-start` | `activity-update` | `activity-end`.
- `sealed`: an envelope wire string, ≤ 3000 chars. Relay never parses it.
- `alert` → device token, `apns-push-type: alert`, priority 10, topic
  `<bundleId>`, payload:
  `{ aps: { alert: { title: "OpenAGI", body: "Supervisor needs you" },
  "mutable-content": 1, category: "SUPERVISOR_QUESTION", sound: "default",
  "thread-id": "supervisor" }, sealed }`. `collapseId` → `apns-collapse-id`.
- `activity-start` → start token, `apns-push-type: liveactivity`, priority 10,
  topic `<bundleId>.push-type.liveactivity`, payload
  `{ aps: { timestamp, event: "start", "content-state": { sealed },
  "attributes-type": "SupervisorActivityAttributes", attributes: { slot: "fleet" },
  "input-push-channel": ch, alert: { title: "OpenAGI", body: "Tracking your agents" },
  "stale-date"? } }`.
- `activity-update` / `activity-end` → broadcast `POST /4/broadcasts/apps/<bundleId>`
  on `api[.sandbox].push.apple.com`, header `apns-channel-id: ch`,
  `apns-push-type: liveactivity`, priority 5 (10 when the plaintext's "you"
  count rose — the daemon passes `priority: 10`), payload
  `{ aps: { timestamp, event, "content-state": { sealed }, "stale-date"?, "dismissal-date"? } }`.
- Returns `{ ok: true, apnsId }`, or `{ ok: false, gone: true }` when APNs
  says the token or channel is gone (410, `BadDeviceToken`,
  `Unregistered`, `ChannelNotRegistered`), or `{ ok: false, error }`.
- Limits: body ≤ 8 KB; per-pass rate limit 120 sends/hour via the Workers
  rate-limit binding; `register` limited per IP (20/hour).
- Secrets: `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `PASS_KEY`; var
  `BUNDLE_ID` (default `sh.openagi.OpenAGI`). JWT ES256 via WebCrypto,
  cached ≤ 50 min. No logging of bodies.

### Daemon route

`POST /mobile/push` (mobile allowlist) — body `{ pass, key, env }` from the
authenticated phone. Stores `{ nodeId, pass, key, env, updatedAt }` in
`<dataDir>/nodes/push.json` (0600), replacing that node's prior record.
`DELETE /mobile/push` removes it. Node revoke also removes it. Returns
`{ ok: true }`. `key` must decode to exactly 32 bytes; `pass` must start
with `p1.` and be ≤ 2000 chars.

Relay URL: `OPENAGI_PUSH_RELAY` env, default `https://push.openagi.sh`.
`OPENAGI_PUSH=0` disables sending.

## Daemon behaviour (`src/mobile-push.js`)

- Listens to `events` `fleet` and `outreach`/`outreach-resolved`; debounces
  2 s; reads `runtime.fleetSupervisor.getState()`.
- Per registration, keeps in memory: activity live?, last activity plaintext
  hash, last sent at, notified question ids (persisted in push.json so a
  restart does not re-alert, pruned to open ids).
- Activity:
  - active > 0 and not live → `activity-start`, mark live.
  - live and content changed → `activity-update`, at most once per 20 s
    (trailing send keeps the latest); priority 10 only when `you` rose.
  - live and active = 0 for 2 minutes → `activity-end` with `dismissAt` =
    now + 15 min.
  - Restart after 7.5 h live (Apple's 8 h cap): end then start.
  - `stale-date` = now + 30 min on every start/update.
- Alerts: each open question not yet notified → `alert` with
  `collapseId` = question id; max 5 per pass, same as Android.
- `{ gone: true }` → delete the registration. Network errors → keep, retry on
  next change. Never throws into the supervisor.

## iOS behaviour

- Push is attempted only after pairing. Requires a real Apple team; the
  project keeps ad-hoc signing by default and adds `aps-environment` +
  push-capable entitlements behind the team setting (README documents it).
- `PushRegistrar` (app): requests notification permission, registers for
  remote notifications, reads `Activity<SupervisorActivityAttributes>.pushToStartTokenUpdates`,
  then when both tokens exist and changed: get/create the key (keychain,
  shared group), `POST relay /v1/register`, `POST daemon /mobile/push`.
  Retries on foreground and background refresh. Forget pairing →
  `DELETE /mobile/push` best effort, delete key.
- `PushEnvelope` (Sources/Protocol, compiled into app, widget and NSE):
  parse + decrypt with CryptoKit. Key read from the shared keychain item
  `sh.openagi.mobile.pushkey`, `AfterFirstUnlock`.
- Live Activity (widget extension): `ActivityConfiguration` for lock screen
  and Dynamic Island. Decrypts `sealed` in the view; on failure shows
  "Open OpenAGI to refresh". Lock screen: counts line + up to 3 rows
  (group dot, title, waitingOn, relative `since`). Island compact: needs-you
  count / working count; minimal: needs-you count or a dot.
- Notification Service Extension `OpenAGINotify`: decrypts `sealed`,
  replaces title/body, registers category `sq.<n>` with one action per
  option (`answer.<i>`) plus Dismiss, stores options in `userInfo`. On
  failure leaves the generic text.
- Answer: `UNUserNotificationCenterDelegate` in the app handles
  `answer.<i>` / dismiss → `POST /fleet/api/questions/:id` `{answer}` or
  `{dismiss:true}`; 404 counts as done; failure posts a local "Not sent"
  notification. Tap opens the Supervisor tab.

## Error handling

- Relay down / APNs error: daemon logs one line per distinct error, keeps
  registration, retries on next change.
- Key mismatch / decrypt fail: UI shows generic text, never crashes.
- Token rotation: phone re-registers; the daemon replaces the record and
  treats the activity as not live (next change starts a fresh one).

## Testing

- Node (`node --test`, Node 22): envelope round-trip + shared fixture;
  content building (ordering, caps, filtering); diff/throttle/end/restart
  timing with a fake clock and fake relay; alert dedupe + persistence;
  `/mobile/push` route auth, validation, revoke cleanup; allowlist.
- Relay (`relay/test`, `node --test` against the Worker module with a fake
  `fetch`): pass seal/unseal, payload shapes per type, gone mapping, limits.
- iOS (XCTest): envelope fixture decrypt, activity/alert plaintext decoding,
  NSE content mapping, answer action → request.
- Manual (needs a real Apple team + device): documented checklist in
  `mobile/README.md`.

## Owner setup (blocking a real-device run, not the code)

1. Apple Developer team ID → `DEVELOPMENT_TEAM`.
2. APNs auth key (.p8), key ID.
3. Cloudflare account + `push.openagi.sh` (or another) route; `wrangler
   secret put` the four secrets.

## Risks

- Workers outbound to port 2196 (channel management): verify on first
  deploy; if blocked, channel creation moves to a tiny second endpoint.
- Lock-screen view decrypting via keychain: covered by the fixture test, but
  only a device run proves the extension can read the item while locked.

## Amendments after review (2026-10-15)

- Channel-management ports: sandbox `:2195`, production `:2196`.
- `POST /v1/register`: `startToken` is optional. Without it no channel is
  created and the pass has no `s`/`ch`; `activity-*` sends with such a pass
  return 400 `{ error: "no_live_activity" }`. Alerts work with the device
  token alone.
- `POST /v1/unregister` `{ pass }`: deletes the pass's channel if any
  (`DELETE /1/apps/<bundleId>/channels` with `apns-channel-id`), returns
  `{ ok: true }` even if the channel is already gone.
- `POST /mobile/push` takes optional `activities: boolean` (default `true`).
  `false` → the daemon never sends `activity-*` for that node.
- The daemon persists per-node activity state (`activity: { startedAt }` or
  null) in `push.json`, so a restart sends `activity-update`, not a second
  `activity-start`. Re-POSTing the same `pass` keeps that state and the
  notified ids; a different `pass` resets activity state only.
- The phone re-POSTs `/mobile/push` (stored pass) on every foreground and
  background refresh, persists the pass as soon as the relay returns it
  (daemon-step retries reuse it), calls `/v1/unregister` with the old pass
  when it re-registers or forgets pairing, and ends all but the newest
  `SupervisorActivityAttributes` activity whenever `Activity.activityUpdates`
  yields.

## Amendments, round 2 (2026-10-16)

- Pass lifetime: pass plaintext adds `exp` = `iat` + 30 days (seconds). The
  relay rejects an expired pass with 400 `pass_expired`.
- Revocation: with an optional KV binding `REVOKED`, `/v1/unregister` stores
  `sha256(pass)` (TTL = remaining life); every send/unregister with a
  revoked pass gets 400 `pass_revoked`. Without the binding, `exp` bounds it.
- `wrangler.toml` ships the `SEND_LIMITER` and `REGISTER_LIMITER` bindings
  enabled.
- Daemon: a relay 400 `bad_pass` | `pass_expired` | `pass_revoked` marks the
  record `renew: true` (persisted) and stops sends with it.
  `POST /mobile/push` returns `{ ok: true, renew }`, where `renew` is true when
  the stored record for that same pass is marked. A new pass clears it.
- `POST /mobile/push` takes optional `alerts: boolean` (default `true`): the
  phone's notification permission. With `false` the daemon sends no alerts
  and does not mark questions notified.
- Daemon: gone deletions only remove the record if it still holds the pass
  the send used. A pass that leaves open questions unsent (over the cap of 5)
  schedules a follow-up pass 30 s later.
- Phone: mints a new pass (re-register, then unregister the old one) when
  the daemon answers `renew: true` or the stored pass is older than 7 days.
