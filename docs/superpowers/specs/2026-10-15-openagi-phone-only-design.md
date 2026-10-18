# OpenAGI phone-only mode: the daemon on the phone, on-device models

## Outcome

A person with only a phone installs the OpenAGI app, sets it up in a few
minutes, and has a working agent with no Mac, no account, and no cloud.
The real OpenAGI daemon runs inside the app on embedded Node 22, and the
phone's own model (Apple Foundation Models / Gemini Nano) does the
thinking. Later, the same person can move everything to a Mac daemon and
keep their memory, tasks, and history.

User stories:

- As a new user with only a phone, I want to install, name my agent, and
  start chatting in under 3 minutes, so I get value without a Mac.
- As a phone-only user, I want tasks, memory, a morning plan, and an
  evening recap made on my phone, so it is the same OpenAGI as on a Mac.
- As a privacy-minded user, I want every model call to stay on the device,
  so nothing I say leaves my phone.
- As a user who later gets a Mac, I want to move my agent to it in one
  step, so my memory and tasks come with me and the phone becomes a client.

## Non-goals

- No accounts, no OpenAGI server, no cloud relay, no push service.
- No activity capture, computer use, coding supervisor, iMessage, MCP stdio
  servers, or self-update on the phone.
- No re-implementation of agent logic in Swift or Kotlin. The phone runs the
  same `src/` as the Mac.
- No support for phones without an on-device model, beyond the optional
  bring-your-own-key fallback below.
- No two-way sync between a phone daemon and a Mac daemon. Moving is one-way.

## Feasibility evidence (spike, 2026-10-15)

Prebuilt nodejs-mobile v22.18.0 (alzhuravlev fork) booted the unmodified
daemon on the iOS 27.1 simulator (inside an app, `--jitless`) and the
Android 15 arm64 emulator (`adb shell`, `--jitless`):

| Check | iOS sim | Android emu |
|---|---|---|
| Node 22.18 + `node:sqlite` | yes | yes |
| Daemon boot | 401 ms | 198 ms |
| `/health`, `POST /tasks`, `POST /message` (stub model) | OK | OK |
| RSS after boot + one turn | 257 MB | 77 MB |
| `Intl` | missing | missing |
| `WebAssembly` (so built-in `fetch`) | missing | missing |
| 16 KB page alignment | n/a | yes |

The spike needed three patches, all addressed below: a UTC `Intl` stand-in,
an `http`-based `fetch`, and one `\p{L}` regex. Not yet tested: real
devices, the Android app sandbox, App Store review, background lifetime.

## Device support

| Platform | Minimum | On-device model |
|---|---|---|
| iOS | iOS 26, Apple Intelligence device (iPhone 15 Pro and later) | Apple Foundation Models (`SystemLanguageModel`) |
| Android | Android 12 (current `minSdk` 31), device with AICore Gemini Nano | ML Kit GenAI Prompt API |

The current apps target iOS 18 and Android 12, and keep working as paired
clients there. Phone-only mode is offered only where the model check
passes.

## Architecture

```
┌──────────────────────── phone app process ────────────────────────┐
│  SwiftUI / Compose app (existing)        Native model bridge        │
│     │  HTTP + SSE (existing client)         ▲   │                   │
│     ▼                                       │   ▼                   │
│  127.0.0.1:43210  ◄──── embedded Node 22 daemon (src/, unmodified   │
│                         except the mobile profile) ── WS /device/   │
│                         model ◄─────────────────────────────────────┘
│  data dir: Application Support/openagi  (Android: filesDir/openagi) │
└─────────────────────────────────────────────────────────────────────┘
```

Five units:

1. **Runtime (`openagi-node-mobile`)** — our own build of nodejs-mobile at
   Node 22 LTS with ICU, shipped as an xcframework and per-ABI `.so`.
2. **Embedded host** — Swift and Kotlin code that starts Node once per
   process, owns its data dir and auth token, and reports readiness.
3. **Mobile profile** — daemon config selected by `OPENAGI_PROFILE=mobile`
   that turns off what a phone cannot do and fits prompts to a 4k model.
4. **On-device model provider** — a daemon `ModelProvider` that sends each
   generation to the native app over a loopback WebSocket, and the native
   bridge that runs it on Foundation Models / Gemini Nano.
5. **Onboarding and move-to-Mac** — first-run flow, and an export/import
   path to a Mac daemon.

The existing app layers (transport, protocol, store, surfaces) do not
change shape. Phone-only mode is the existing app pointed at
`http://127.0.0.1:43210` with a token it generated itself.

### 1. Runtime

- Fork `alzhuravlev/nodejs-mobile` at the v22.18.0 work into
  `Spshulem/nodejs-mobile` (name to confirm). Track Node 22 LTS.
- Configure with ICU so `Intl.DateTimeFormat` with an IANA `timeZone` works.
  Start with `--with-intl=small-icu`; if any IANA zone fails the acceptance
  test, switch to `full-icu`. Measure and record the size cost either way.
- Keep `--jitless` on iOS (required on device). Use `--jitless` on Android
  too, so both platforms run the same mode and the same tests.
- Build both artifacts through a PR on the fork (macOS runner). Publish
  release artifacts only from the fork's `main`. Pin the app to an artifact
  by version and SHA-256.
- Acceptance test (runs in the fork's PR CI, on simulator and emulator):
  Node version, `node:sqlite` round trip, `Intl.DateTimeFormat("en-CA",
  {timeZone: "America/New_York"})`, `/\p{L}/u`, `https` request to a local
  TLS server.

### 2. Embedded host

- **Start once.** nodejs-mobile cannot restart Node in the same process.
  The host starts it on a dedicated thread with a 16 MB stack at app launch
  (and in Android's process start), and never stops it. If Node exits, the
  host shows a "restart the app" state rather than retrying.
- **Entry script.** `mobile-entry.mjs` (new, bundled) sets mobile env,
  installs the portable `fetch` when `WebAssembly` is missing, and calls
  `startServer({ host: "127.0.0.1", port })`.
- **Data dir.** iOS: `Application Support/openagi`, excluded from iCloud
  backup only for caches; the data itself is backed up with the device.
  Android: `filesDir/openagi`.
- **Token.** On first launch the host generates `OPENAGI_AUTH_TOKEN` (32
  random bytes), stores it in the Keychain / Keystore-backed
  `EncryptedSharedPreferences`, passes it to Node via env, and the app uses
  it as its bearer. The daemon binds loopback only.
- **Port.** 43210 by default; if busy, the host picks a free loopback port
  and passes it via `PORT`.
- **Loopback exemption.** `HostAllowlist` (both apps) refuses loopback
  today because a paired phone can never reach its Mac's loopback. Add an
  explicit embedded-mode exemption: loopback is allowed only when the app is
  in phone-only mode and the target is the embedded daemon's port.
- **Bundle.** Ship `src/`, `bin/`, `package.json`, and `node_modules/ws` as
  a resource folder. The build checks the bundled `src/` matches the commit
  being built.

### 3. Mobile profile (`OPENAGI_PROFILE=mobile`)

Daemon changes, all gated on the profile so desktop behavior is unchanged:

- **Cron jobs.** Disable the jobs that read screen activity, the
  filesystem, or desktop apps, or that update code: `inbox-sweep`,
  `imessage-extract`, `task-activity-scan`, `hourly-pattern-mine`,
  `nightly-pattern-mine`, `ambient-digest`, `proactive-observer`,
  `weekly-project-scan`, `observation-retention`, `self-update`.
  `linear-task-sync` and `buildbetter-task-sync` stay off until the user
  adds those integrations. Every other default job stays on.
- **Routes and tools.** `/computer-use/*`, MCP stdio registration, coding
  supervisor, iMessage, voice relay, and G2 speech relay are not mounted.
  Anything that would `child_process.spawn` is refused with a clear error.
- **Portable fetch.** New `src/portable-fetch.js`: a `fetch` over
  `node:http`/`node:https` returning the built-in `Response`, with streaming
  bodies (SSE) and `AbortSignal`. Installed globally only when
  `typeof WebAssembly === "undefined"`. Same for anything that uses the
  global `WebSocket`: use `ws` instead.
- **Regex.** Replace the one `\p{L}\p{N}` regex in
  `src/fleet/suggestions.js` only if the ICU runtime still rejects it.
- **Small-model budget.** A `mobile` model profile: compact system prompt
  (no tool catalog prose), at most 6 tools exposed per turn (`remember`,
  `recall`, `add_task`, `complete_task`, `move_task`, `schedule_message`),
  at most 3 memory hits, at most 2 tool hops, history trimmed by the
  existing context trimmer to fit the model's reported context size.
- **Embeddings.** Use the existing `HashBagEmbedder`. Native embeddings are
  out of scope for this spec.

### 4. On-device model provider

**Daemon side.** New `OnDeviceModelProvider` in `src/on-device-provider.js`
implementing the same `generate({...})` contract as the other providers.

- It holds one WebSocket at `/device/model` (loopback, bearer-token
  required, at most one connection). Each generation sends
  `{ id, system, messages, tools, schema?, maxOutputTokens }` and awaits
  `{ id, text | toolCall | error, usage }`, streaming
  `{ id, delta }` frames to `onTextDelta`.
- Tool loop runs in the daemon, exactly as the OpenAI/Anthropic providers
  do: model asks for a tool, daemon runs it, sends the result back as the
  next message, up to the mobile hop limit.
- When no device socket is connected (app suspended), a generation waits
  up to 30 s, then fails with `device-model-unavailable`. Cron jobs that
  need a model are deferred to the next run instead of failing silently.
- `createModelProvider` picks it when `OPENAGI_PROVIDER=on-device`.

**iOS bridge.** `LanguageModelSession` per generation. Daemon tools become
Foundation Models `Tool` declarations with `@Generable`-style argument
schemas built at runtime from the JSON schema; a tool call is returned to
the daemon rather than executed natively. Checks
`SystemLanguageModel.default.availability` and `contextSize`. Uses
`respond` (not streaming) when the app is in the background, per Apple's
background rate-limit guidance.

**Android bridge.** ML Kit GenAI Prompt API. The API has no tool calling,
so the bridge asks for structured output with a fixed schema:
`{ "reply": string } | { "tool": name, "args": object }`. One tool per
hop. Handles `checkStatus()` states (`AVAILABLE`, `DOWNLOADABLE`,
`DOWNLOADING`, `UNAVAILABLE`), `BUSY` (retry with backoff), and
`PER_APP_BATTERY_USE_QUOTA_EXCEEDED` (fail the generation, surface it).
Inference only runs while the app is in the foreground.

**Fallback.** If the on-device model is unavailable, setup offers
"use my own API key" (OpenAI or Anthropic, stored in the daemon's `.env`
in the app sandbox). The daemon is still on the phone; only model calls
leave it. This is opt-in and labeled as such.

### 5. Onboarding and move-to-Mac

**First run (new screen before the existing pairing screen):**

1. "Where should OpenAGI run?" — *On this phone* (shown only if the model
   check passes or the user opts into an API key) or *Connect to my Mac*
   (existing pairing flow).
2. Model check: available / downloading (progress) / not supported (offer
   API key or Mac).
3. Name your agent and a short "what do you want help with" prompt, written
   to the persona store the desktop setup wizard uses.
4. Notifications permission, explained as "morning plan, evening recap,
   reminders".
5. Land in Chat with a first message from the agent.

No account, email, or sign-in at any step.

**Move to Mac (one-way):**

- Phone: Settings → "Move to a Mac". The daemon writes a single archive of
  its data dir (`openagi-export-<date>.tar.gz`, excluding caches and the
  auth token) and the app opens the share sheet (AirDrop, Files, Quick
  Share).
- Mac: new `openagi import <archive>` refuses to overwrite a non-empty data
  dir unless `--merge` is passed. This spec ships the non-merge path only;
  `--merge` prints "not supported yet".
- After the user confirms the import worked, the phone switches to the
  existing paired-client mode (pair with `openagi pair-phone`), and keeps
  its local copy read-only until the user deletes it.

## Background behavior

- **iOS.** Node runs while the app is in the foreground and for the short
  time iOS grants on backgrounding. A `BGAppRefreshTask` wakes the app to
  let the daemon run due cron jobs; morning plan and evening recap become
  local notifications. If the model is throttled in the background, the job
  defers and the notification is posted when the app next opens.
- **Android.** Node runs in the app process. A periodic `WorkManager` job
  (existing 15-minute floor) keeps due jobs running. Model-dependent jobs
  run only when the app is in the foreground, because the Prompt API
  requires it; non-model jobs (reminders, sweeps) run in the background.
- The UI always says when the agent last ran, matching the widget's
  existing staleness display.

## Error handling

| Failure | Behavior |
|---|---|
| Node fails to start | "OpenAGI couldn't start" screen with the error and a copy-logs button; app stays usable as a paired client |
| Node exits mid-session | Same screen, "restart the app"; no in-process restart |
| Model unavailable / quota | Turn fails with a plain message; cron job deferred |
| Data dir unwritable / disk full | Daemon refuses writes with existing errors; app shows "storage full" |
| Import onto non-empty Mac data dir | Refused unless `--merge`; no data touched |

## Size and memory budget

- Runtime binary: ~77 MB (iOS arm64) and ~88 MB (Android arm64) before ICU
  and stripping. Target after stripping, ICU, and store compression: under
  60 MB added download per platform. Measured in the runtime PR.
- Ship arm64 only on iOS devices; Android ships `arm64-v8a` (and `x86_64`
  for emulators in debug builds only).
- Memory: daemon RSS under 300 MB on iOS after first turn (spike: 257 MB).

## App Store and Play

- All JavaScript is bundled and signed with the app; nothing is downloaded
  and executed. Self-update is disabled in the mobile profile. Skills are
  prompts, not code. This is the basis for guideline 2.5.2 compliance; it
  is unconfirmed until the first TestFlight review.
- Android: 16 KB page alignment is verified in the runtime acceptance test.

## Testing

- **Daemon (Node test runner):** mobile profile disables the listed jobs and
  routes; `portable-fetch` (status, headers, streaming SSE body, abort,
  https); `OnDeviceModelProvider` against a fake device socket (text reply,
  tool loop, hop limit, timeout, no socket); `openagi import` refuses a
  non-empty dir.
- **Runtime fork CI:** the acceptance test above on the simulator and the
  emulator.
- **iOS / Android unit tests:** embedded-mode allowlist exemption, token
  generation and storage, Foundation Models / Prompt API bridge mapping
  (with a fake model), Android structured-output tool parsing.
- **Smoke test:** the spike probe, kept as a test: boot the embedded daemon
  in the simulator and emulator, `/health`, create a task, one chat turn
  with a fake device model.
- **Manual:** one real iPhone and one real Gemini Nano Android device before
  the first store build.

## Phases

1. **Runtime.** Fork, ICU build, acceptance test, pinned artifacts.
2. **Embedded daemon.** Hosts on both apps, mobile profile,
   `portable-fetch`, loopback exemption, smoke test. Uses the deterministic
   provider.
3. **On-device model.** `OnDeviceModelProvider`, both native bridges,
   small-model budget, API-key fallback.
4. **Onboarding.** First-run flow and notifications.
5. **Background.** BGAppRefresh / WorkManager cron runs and local
   notifications.
6. **Move to Mac.** Export archive, `openagi import`, switch to paired mode.

Each phase lands on iOS and Android together, per the mobile apps design.

## Open questions

- Fork name and owner (`Spshulem/nodejs-mobile` assumed).
- `small-icu` vs `full-icu` — decided by measurement in phase 1.
- Whether the API-key fallback ships in phase 3 or is cut.
