# OpenAGI push relay

A stateless Cloudflare Worker that holds the APNs auth key and forwards
end-to-end encrypted supervisor pushes (alerts and Live Activity updates) from
an OpenAGI daemon to the paired iPhone. Spec:
`docs/superpowers/specs/2026-10-15-ios-supervisor-push-design.md`.

## What it does

- `POST /v1/register` `{ deviceToken, startToken?, env }` creates one APNs
  broadcast channel for the phone's Live Activity and returns a `pass`.
  Without `startToken` no channel is created: the pass supports alerts only,
  and `activity-*` sends return 400 `no_live_activity`. The
  pass is an AES-256-GCM blob (`p1.<nonce>.<ct+tag>`, AAD
  `openagi-relay-pass:v1`) sealed with the Worker secret `PASS_KEY`. It holds
  the device token, push-to-start token, channel id, env, and issue time. The
  relay stores nothing. The phone hands the pass to its daemon.
- `POST /v1/send` `{ pass, type, sealed, collapseId?, staleAt?, dismissAt?, priority? }`
  opens the pass and sends one APNs request:
  - `alert`: device token, generic "Supervisor needs you" text, `sealed` in the payload.
  - `activity-start`: push-to-start token, starts `SupervisorActivityAttributes`
    bound to the channel.
  - `activity-update` / `activity-end`: broadcast on the channel. Priority 5,
    or 10 when the daemon passes `priority: 10`.
  - Returns `{ ok: true, apnsId }`, `{ ok: false, gone: true }` (410,
    `BadDeviceToken`, `Unregistered`, `ChannelNotRegistered`), or
    `{ ok: false, error }`.
- `POST /v1/unregister` `{ pass }` deletes the pass's channel, if any. Returns
  `{ ok: true }` even when the channel is already gone.
- `staleAt` / `dismissAt` take epoch seconds or an ISO-8601 string.
- `GET /v1/health` returns `{ ok: true }`.

## What it can and cannot see

| Can see | Cannot see |
| --- | --- |
| APNs device token, push-to-start token, channel id (inside the pass, only while handling a request) | Task titles, question text, answer options, thread keys |
| Push type, timing, sizes, the caller's IP | The phone's envelope key (it lives on the phone and the daemon only) |

`sealed` is an envelope (`v1.<nonce>.<ct+tag>`) encrypted with a key the phone
generated. The relay checks its shape and length and forwards it untouched.
The Worker never logs request bodies, tokens, or passes.

## Limits

- Body at most 8 KB. `sealed` at most 3000 chars. `collapseId` at most 64 bytes.
- Workers rate-limit bindings `SEND_LIMITER` (keyed by a hash of the pass,
  shared by send and unregister) and `REGISTER_LIMITER` (keyed by
  `CF-Connecting-IP`), enabled in `wrangler.toml`. If a binding is missing,
  that limit is skipped. Bindings only support 10 s or 60 s periods,
  so the spec's hourly budgets are approximated per minute in `wrangler.toml`.

## Deploy

```sh
cd relay
npx wrangler login
npx wrangler secret put APNS_KEY_P8    # paste the whole AuthKey_XXXX.p8 PEM
npx wrangler secret put APNS_KEY_ID    # 10-char key id
npx wrangler secret put APNS_TEAM_ID   # Apple Developer team id
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" \
  | npx wrangler secret put PASS_KEY
npx wrangler deploy
```

The rate-limit bindings ship enabled. Uncomment the `routes` block (and the
`REVOKED` KV block, below) in `wrangler.toml` as needed and deploy again. `BUNDLE_ID` defaults to `sh.openagi.OpenAGI` and must equal the iOS app's bundle id (`OPENAGI_BUNDLE_ID`): it is the APNs topic. The App ID also needs the Broadcast Push Notifications capability for Live Activity channels.

## Pass lifetime and revocation

- Each pass carries `exp` = `iat` + 30 days. After that, send and unregister
  return 400 `pass_expired`. A malformed, tampered, or foreign pass returns
  400 `bad_pass`.
- Optional KV binding `REVOKED`: `/v1/unregister` stores `sha256(pass)` (never
  the pass) with a TTL of the pass's remaining life, minimum 60 s. Later
  send/unregister calls with that pass return 400 `pass_revoked`. The
  revocation is written only after the channel is gone, so a failed delete can
  be retried. KV errors fail open. Without the binding, `exp` bounds the pass.
- Enable it: `npx wrangler kv namespace create REVOKED`, paste the id into the
  commented `[[kv_namespaces]]` block in `wrangler.toml`, uncomment it, deploy.

Rotating `PASS_KEY` invalidates every pass. Phones re-register on their next
foreground or background refresh.

## Risk: ports 2195 / 2196

Channel management calls `api-manage-broadcast.sandbox.push.apple.com:2195`
(sandbox) and `api-manage-broadcast.push.apple.com:2196` (production).
Workers outbound fetch to those non-standard ports is unproven. Check it on
the first deploy with a real register call. If it is blocked, register fails
with `apns_unreachable`, and channel management has to move to a small second
endpoint (any host that can reach those ports). Sends are unaffected because
they use port 443.

## Test

```sh
cd relay && npm test   # Node 22, no dependencies
```

Tests swap in a fake global `fetch` and a throwaway P-256 key.
