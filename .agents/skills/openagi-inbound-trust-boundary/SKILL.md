---
name: openagi-inbound-trust-boundary
description: Use when changing openAGI hosted route auth, isPublicRoute, webhook secret checks, the Telegram pairing allowlist, or outbound Telegram/digest delivery.
---

# openAGI Inbound Trust Boundary

## When to use

Use this skill when work touches `src/auth.js`, `src/telegram-pairing.js`, `TelegramChannel.handleUpdate` in `src/channels.js`, the `/channels/telegram/webhook`, `/webhooks/buildbetter`, `/channels/telegram/pairing-code` routes in `src/hosted-interface.js`, telegram delivery in `src/outreach-digest.js`, or the tests `test/telegram-pairing.test.js` and `test/telegram-channel-gate.test.js`.

Use it for symptoms containing `not-allowlisted`, `no webhook secret configured`, `no telegram secret configured`, `cross-origin POST blocked`, `allowlist.json`, `/pair`, or a route that unexpectedly answers `401 unauthorized` / `403 forbidden`.

## The two-layer contract

openAGI has one HTTP gate for the dashboard/API and a completely separate gate for Telegram. They are not interchangeable and neither one covers the other.

1. **HTTP gate (`src/auth.js`, applied in `src/hosted-interface.js`).**
   - `checkOrigin(req)` runs FIRST for every non-public route: GET/HEAD/OPTIONS pass, a missing `Origin` passes (non-browser callers like curl and MCP clients), a mismatched `Origin` vs `Host` returns 403. This is browser-CSRF defense only and is always on, even before a token exists.
   - `checkAuth(req, url, getAuthToken())` runs second. **When `OPENAGI_AUTH_TOKEN` is unset it returns `{ ok: true, reason: "auth disabled (OPENAGI_AUTH_TOKEN unset)" }`** — the single-user local default is unauthenticated by design. Token may arrive as `Authorization: Bearer`, `?token=`, or the `openagi_token` cookie; `?token=` sets the cookie via `buildSetCookie`.
   - `isPublicRoute(pathname)` returns true for exactly `/health`, `/sign-in`, `/channels/telegram/webhook`, `/webhooks/buildbetter`. **Adding a path there removes BOTH the CSRF gate and the auth gate** — only do it for a route that self-authenticates.
   - Setup bypass is narrow: `setupBypass = isFirstRun() && pathname in {/setup, /setup/save, /setup/test}`. Do not widen it.

2. **Telegram gate (`src/telegram-pairing.js` + `TelegramChannel.handleUpdate`).** The webhook route is public, so pairing — not HTTP auth — is what keeps strangers out of the agent.

## Procedure

1. Keep the deliberate asymmetry between the two webhook secret checks. `verifyTelegramSecret` fails **OPEN** when `expected` is falsy (`{ ok: true, reason: "no telegram secret configured" }`); `verifyBuildBetterWebhook` fails **CLOSED** (`{ ok: false, reason: "no webhook secret configured" }` → 401) because that webhook triggers outbound API calls. This is not an inconsistency to tidy up. The BuildBetter secret may arrive in `x-buildbetter-webhook-secret` OR `?secret=`; its body is drained and never trusted (the sync re-pulls via the API).

2. Preserve the silent-drop property of `TelegramChannel.handleUpdate` and its ordering:
   - `/pair <6 digits>` is matched by `/^\/pair\s+(\d{6})\s*$/` BEFORE the allowlist check, so an unpaired chat can pair.
   - A failed `/pair` is appended to `events.jsonl` as `op: "pair-attempt"` and is **never replied to** — a probing stranger must learn nothing.
   - Every other message from a chat where `pairing.isAllowed(String(chatId))` is false returns `{ ignored: true, reason: "not-allowlisted" }` with **no `agentHost.handleMessage` call and no reply**. Never move the allowlist check after the agent turn.

3. Treat `TelegramPairing` as pure, injectable state. Every method takes `{ now = Date.now() }`, so tests drive time directly — never add timers, network, or `Date.now()` reads inside the state machine. Exported constants are load-bearing: `CODE_TTL_MS = 10 * 60 * 1000`, `MAX_ATTEMPTS = 5`, `LOCKOUT_MS = 15 * 60 * 1000`. Behaviors to keep:
   - A code is single use — `attempt()` clears `this.active` on success, so the same code cannot pair a second chat (`reason: "no-active-code"`).
   - `generateCode()` resets `failedAttempts` but deliberately does NOT clear `lockedUntil`; issuing codes must never buy a locked attacker a fresh guess budget.
   - Hitting `MAX_ATTEMPTS` sets the lockout AND burns the active code, so even the correct code returns `reason: "locked"`.
   - Codes compare through `crypto.timingSafeEqual` on equal-length buffers; keep the length pre-check.
   - `<dir>/allowlist.json` is `{ version: 1, chats: [{ chatId, pairedAt }] }` at mode 0600 — that comes free from `writeJsonAtomic`'s `mode = 0o600` default, so never pass an explicit looser mode.

4. Issue codes only through the auth-gated route. `GET /channels/telegram/pairing-code` is intentionally absent from `isPublicRoute`, calls `channels.telegram.pairing.generateCode()`, and prints the code to daemon stdout so only someone with server access sees it. It returns 503 `agent-host-disabled` when `channels?.telegram?.pairing` is missing.

5. Respect the allowlist on the way OUT too. `deliverDigest` in `src/outreach-digest.js` sends only to `telegram.pairing.allowlist()`. With `destination` `"telegram"` or `"both"` and an empty allowlist it does not throw — it falls back to mac with `reason: "telegram allowlist is empty (pair a chat first)"`. `src/outreach-config.js` accepts only `mac | telegram | both` and silently coerces anything else to `mac`.

6. Inject dependencies in tests instead of reaching for real state. `TelegramChannel` accepts `options.pairing` and `options.dir`; `TelegramPairing` accepts `{ dir }`. Point both at an `fs.mkdtempSync` directory — never at a real `~/.openagi/channels/telegram`.

## Failure signatures

- `not ok 1 - messages from non-allowlisted chats are ignored with no reply and no agent turn`: the `isAllowed` check is missing, or it runs after `agentHost.handleMessage`, or a reply is sent before the gate.
- `not ok 2 - a failed /pair gets no reply (unknown senders learn nothing)` with `error: "Cannot read properties of undefined ..."`: the channel under test was built without an injected `pairing`/`agentHost` stub, or `handleUpdate` replied on the failure path.
- `401 {"error":"unauthorized","reason":"no webhook secret configured"}` on `POST /webhooks/buildbetter`: `BUILDBETTER_WEBHOOK_SECRET` is unset. This is fail-closed by design — set the secret, do not relax the check.
- `503 {"error":"buildbetter source not configured"}` on that same route: the source is registered but not credentialed; 503 (not 202) is intentional so BuildBetter retries.
- `403 {"error":"forbidden","reason":"cross-origin POST blocked (Origin X ≠ Host Y)"}`: a browser POSTed from another origin, or the route is being reached through a proxy that rewrites `Host`. Do not fix it by adding the path to `isPublicRoute` — that also drops the auth gate.
- A dashboard route answering 200 without any credential: expected when `OPENAGI_AUTH_TOKEN` is unset. Check the env before concluding the auth gate is broken.
- `reason: "locked"` returned for a code you believe is correct: `MAX_ATTEMPTS` was reached; the lockout runs `LOCKOUT_MS` and generating a new code does not clear it.

## Verification

- `node --test test/telegram-pairing.test.js` passes all five cases, including "the 5th failure locks pairing for 15 minutes, even against the correct code" and "the allowlist persists across instances via allowlist.json".
- `node --test test/telegram-channel-gate.test.js` passes all four cases, including "GET /channels/telegram/pairing-code is auth-gated and issues a 6-digit code".
- `grep -n 'isPublicRoute' src/auth.js` still lists exactly `/health`, `/sign-in`, `/channels/telegram/webhook`, `/webhooks/buildbetter` unless the task explicitly adds a self-authenticating route.
- After touching digest delivery: `node --test test/outreach-digest-telegram.test.js` passes and an empty allowlist still yields the mac fallback rather than an exception.
