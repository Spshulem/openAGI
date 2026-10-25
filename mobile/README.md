# OpenAGI mobile (iOS + Android)

The combined iOS onboarding, Supervisor push, and Android compatibility work
is tracked in [PR #211](https://github.com/Spshulem/openAGI/pull/211).
Use [QA.md](QA.md) for its current automated gates and device acceptance
checklist; the phase-by-phase notes below include historical verification.

Connect a phone to your main OpenAGI host for tasks, shared agent chat,
approvals, and the fleet supervisor. The iOS SwiftUI and Android Compose apps
have separate codebases; see [the mobile feature surface](FEATURES.md) for the
current navigation and capabilities. Widgets show a cached task snapshot.

Android also supports Supervisor voice. The iOS source includes an offline
workspace, a phone-agent mode on compatible Apple Intelligence devices, and
optional encrypted Supervisor push alerts and a Live Activity.

**App availability:** this repository includes source and build instructions.
There is no public App Store, TestFlight, or Play Store download link advertised
here. Install an available build of the app before pairing. iOS also has an
optional embedded-runtime mode described below; a build needs its runtime and
compatible on-device model to use it.

Start with [installation](../docs/INSTALL.md) and the
[guided first-use flows](../docs/GETTING_STARTED.md). After pairing, you can ask
in agent chat: "Help me get started with OpenAGI, one question at a time."

The phone needs a route to its main over your private network or authenticated
HTTPS. If that host is asleep or unreachable, remote features will be unavailable;
widgets show the age of their last snapshot. Push-notification options depend
on the platform and configuration; they do not replace reachability for chat.

## Pairing a phone

### Replay mobile setup

On either platform, open **Settings → Run setup again** to return to the
welcome screen. Use **Return to app** to leave it. This replays navigation;
it does not revoke the phone, delete conversations, remove saved model keys,
or clear queued work. You do not need to uninstall or erase app data.

iOS offers the phone agent's model, name, and notification setup, or server
pairing. Android offers Gemini Nano / hosted chat, or server pairing; its
phone chat does not provide the server's tasks or integrations. Existing
pairing links still open the server/code screen directly.

For server discovery, update and restart the desktop app or daemon first.
Wi-Fi discovery needs the same local network. Over Tailscale, enter the main
server's DNS name from the Tailscale device list. Get a phone code from the
Mac app's **Connect a phone…** menu or the main dashboard's
**Nodes → Connect a phone** page.

### Connect to main

On the machine running the daemon, with the daemon already bound to an
address the phone can reach (see **Reachability**, below):

```
openagi pair-phone --platform ios      # or --platform android
```

This prints a server address and a six-digit code to type into the app by
hand, and — for anyone who'd rather not type — an `openagi://pair` deep
link the phone can open directly (from Notes, Messages, a QR code you make
yourself, or `xcrun simctl openurl <udid> "<link>"` on a simulator). The
code is single-use and expires in 30 minutes. In the app, tap **Pair**,
enter (or arrive with) the server and code, and the phone exchanges the
code for its own permanent node credential — a random token it generates
itself, never one the daemon hands back.

### Connected, but Tasks or Chat are empty

Pair the phone to the **main that owns your data**. A separate test daemon
has its own task and conversation stores, even when its Supervisor shows
the same fleet activity. Check the server in the app's Settings and run
`openagi pair-phone --platform ios` (or `android`) on the correct main to
generate a fresh pairing link. An upstream-paired desktop node cannot issue
the main's phone enrollment codes.

Tasks has separate user and agent queues. Today shows user tasks in today's
bucket; Inbox shows pending actions and task clarifications. Fleet Supervisor
questions are a separate surface. Chat and Ask supervisor show their shared
device conversations on that main, with **Load earlier messages** on iOS
when more history is available. Owner dashboard and individual coding-agent
session histories remain separate. A history request that fails is shown
with a retry action rather than as an empty conversation.

## Reachability: the rule that will trip you up

**Cleartext `http://` only works when the daemon's host is a Tailscale
name (`*.ts.net`), a Tailscale CGNAT address (`100.64.0.0/10`), or an
RFC1918 LAN address (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) —
everywhere else needs `https://`, and loopback (`127.0.0.1` / `localhost`)
is refused unconditionally, on any scheme, because a phone can never reach
your Mac's own loopback address.** `openagi pair-phone` checks this before
it ever mints a code, and both apps re-check it independently before
dialing out — so if pairing fails immediately with an "unreachable" or
"refusing cleartext" message, the fix is almost always to bind the daemon
to its tailnet or LAN address (`OPENAGI_BIND=0.0.0.0` plus
`OPENAGI_AUTH_TOKEN` — see `src/boot.js`'s bind-safety check) and pair
against *that* address, not `127.0.0.1:43210`.

## Building and testing

### Chat when the server is unavailable

Both apps offer **Chat without server** from Chat and Settings. Choose the
phone's local model or OpenAI, Claude, OpenRouter or Gemini. Hosted modes use
your own API key, entered in a masked native field and saved in iOS Keychain
or Android Keystore-protected storage. Keys go only to the selected provider's
fixed HTTPS endpoint; redirects are refused. No server credential or provider
key is exported by the daemon.

This is a separate conversation on the phone. Existing server messages, memory
and integration data are never automatically sent to a hosted provider.
Provider usage may incur charges on your own account. The active provider and
model are always shown. Return to the server chat to retry the saved pairing.
Tasks, integrations, approvals and fleet controls still require the server;
direct chat does not pretend to perform those actions.

Android uses ML Kit's on-device Gemini Nano Prompt API and checks actual
availability. **Download local model** appears when AICore reports a download
is needed; unsupported or unready devices show that status and can use hosted
chat. iOS uses Apple Intelligence when enabled and downloaded. Neither app
silently changes provider or automatically resends a possibly completed server
turn to another model.

### iOS

Requires Xcode (this project builds against `Xcode-beta.app`) and
[XcodeGen](https://github.com/yonaskolb/XcodeGen), since the `.xcodeproj`
is generated, not checked in:

```
cd mobile/ios
xcodegen generate
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
  xcodebuild -project OpenAGI.xcodeproj -scheme OpenAGI -configuration Debug \
  -destination 'id=<simulator-udid>' -derivedDataPath /tmp/openagi-ios build
```

Swap the trailing `build` for `test` to run the unit test suite (54 tests
as of Phase 1) on the same destination. `DEVELOPER_DIR` is not optional —
without it, `xcodebuild` silently resolves against whatever Xcode is
currently the system default, which on a machine with more than one Xcode
install is rarely the one you meant.

#### Phone-only mode (agent on the iPhone)

The app can run the daemon itself, on the phone's own model, with no Mac
(docs/superpowers/specs/2026-10-15-openagi-phone-only-design.md). Before
building, fetch the embedded Node runtime once:

```
mobile/ios/scripts/fetch-node-runtime.sh
```

It downloads a pinned nodejs-mobile build into `mobile/ios/Vendor/`
(gitignored); a build phase copies it and the daemon's `src/` into the app.
Without it the app builds as before and onboarding offers only "Connect to
a server". On a simulator, port 43210 is usually your Mac's own daemon (the
simulator shares the Mac's loopback), so the embedded daemon picks another
port. The model is Apple Foundation Models: iOS 26+ on an Apple
Intelligence iPhone; elsewhere, Debug builds can finish setup without one.

### Android

There is **no JDK and no Gradle on `PATH`** in a typical dev shell here —
both must be pointed at explicitly, or the wrapper fails with an
unhelpful "unable to locate a Java Runtime" error:

```
cd mobile/android
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
ANDROID_HOME="$HOME/Library/Android/sdk" \
  ./gradlew testDebugUnitTest assembleDebug
```

That runs the unit suite (46 tests as of Phase 1; results land in
`app/build/test-results/testDebugUnitTest/*.xml`) and builds the debug
APK. The toolchain is pinned: **Gradle 8.14.3, AGP 8.13.2, Kotlin 2.3.21,
`minSdk 31`, `compileSdk 36`** — all older or newer combinations are
unsupported, not merely untested.

## How refresh actually behaves

The widget **never makes a network call**. It only ever reads the
snapshot file the host app last wrote — one versioned JSON document with
today's tasks, per-bucket counts, and the daemon's ETag. That snapshot is
refreshed by the app on foreground, on pull-to-refresh, and on a
background schedule: `BGAppRefreshTask` on iOS (best-effort, no fixed
interval the system guarantees), and a periodic `WorkManager` job on
Android with a **hard 15-minute floor** — Android will not run it more
often than that no matter what the app asks for. Practically: the widget
always shows its own staleness ("as of 14m ago") rather than silently
presenting old data as current, and if you want a guaranteed-fresh view,
open the app.

Tapping a task's checkmark — on the widget or in the app — completes it
**optimistically**: the row disappears immediately from the local
snapshot, the completion is appended to an on-device outbound queue, and
the daemon call happens in the background. If the phone is offline, the
row stays hidden and the queued completion replays automatically on the
next successful refresh (app foreground or background job). A `404` or
`409` on replay (the task was already deleted or already completed some
other way) simply discards the queued op rather than retrying forever.
Every completion that originates from a phone sends `completedVia:
"mobile"`, so the daemon's own task history can always tell a phone tap
apart from the CLI, the dashboard, or the agent itself.

## Supervisor notifications (Android)

The fleet supervisor's "needs you" questions arrive as Android
notifications, read from the paired daemon itself — still no push service.
To try it:

1. Pair the phone with a daemon that runs the supervisor (a main with
   `OPENAGI_FLEET_NODE` mirrors the coding Mac's questions; see
   `docs/setup/fleet-supervisor.md`).
2. Allow notifications when the app asks, right after pairing. Missed it?
   Settings → **Live supervisor alerts** opens the system page. A quiet
   "Watching your agents" notification means the live connection is up.
3. Wait for a question (the Supervisor tab's **Needs you**). It posts within
   a few seconds of the daemon's next `fleet` event, or 5 minutes at most.
4. Tap an option in the shade. It reads "Sending your answer…", then clears
   once the daemon confirms; the tab shows the question gone. Answering it on
   the Mac instead clears the notification on the phone's next check.

With the switch off, the 15-minute background refresh is the only check.

## Supervisor push (iOS)

iOS cannot keep a live connection in the background, so supervisor alerts
and the lock-screen Live Activity come by push: daemon → relay (`relay/`,
a Cloudflare Worker holding the APNs key) → APNs → phone. Everything is
sealed end to end with a key the phone makes and gives only to its own
daemon; the relay sees ciphertext. Spec:
`docs/superpowers/specs/2026-10-15-ios-supervisor-push-design.md`.

Setup (owner, once):

1. **Team.** Set `DEVELOPMENT_TEAM` in `mobile/ios/project.yml` and sign
   with a real profile (replace `CODE_SIGN_IDENTITY: "-"` for device
   builds). Bundle and App Group ids are global across Apple teams; if
   `sh.openagi.OpenAGI` or `group.sh.openagi.mobile` belongs to another
   team, set `OPENAGI_BUNDLE_ID` and `OPENAGI_APP_GROUP` (the extensions
   follow the bundle id). On developer.apple.com, enable Push Notifications,
   **Broadcast Push Notifications** (Live Activity updates use APNs
   channels; Xcode cannot turn this one on), App Groups and Keychain
   Sharing on the app's App ID, and App Groups on its two extensions
   (`.OpenAGIWidget`, `.OpenAGINotify`). The default ad-hoc build still runs
   on Simulator; push just never registers.
2. **APNs key.** Create an APNs auth key (.p8) and note its key ID.
3. **Relay.** Deploy `relay/` and `wrangler secret put` `APNS_KEY_P8`,
   `APNS_KEY_ID`, `APNS_TEAM_ID`, `PASS_KEY`. The app uses
   `https://push.openagi.sh`; a self-hosted relay goes in the
   `OPENAGI_PUSH_RELAY` build setting (Info.plist key `OpenAGIPushRelay`),
   **and** the daemon must set its `OPENAGI_PUSH_RELAY` env to the same URL.
   A pass only opens at the relay that issued it, so a mismatch makes every
   send fail with `bad_pass`.
   The relay's `BUNDLE_ID` (`relay/wrangler.toml`, or
   `wrangler deploy --var BUNDLE_ID:<id>`) must equal the app's bundle id:
   it is the APNs topic, and APNs rejects every push for another app.
   The app registers as `sandbox` or `production` from `aps-environment` in
   its signing profile (development profiles are sandbox; App Store and
   TestFlight are production).

Manual device checklist (needs the setup above and a real iPhone):

- [ ] Pair; allow notifications. The daemon's `<dataDir>/nodes/push.json`
      gains this node's record within a few seconds.
- [ ] Kill the app. Start a coding thread; a "Supervisor" Live Activity
      appears on the lock screen within seconds, with counts and rows.
- [ ] Change a thread's state; the row updates (about 20 s at most). End
      every thread; the activity ends about 2 minutes later.
- [ ] With the phone **locked**, the activity still shows rows, not
      "Open OpenAGI to refresh" (proves the widget reads the key while
      locked).
- [ ] Raise a question: the alert shows the real title, body and one button
      per option (long-press). Tap one; the alert clears and the question
      closes on the daemon. Tap Dismiss on another; it is dismissed.
- [ ] Turn the daemon off, tap an answer: a "Not sent" notice replaces the
      alert; tapping it opens the Supervisor tab.
- [ ] Turn Live Activities off for OpenAGI (Settings), reopen the app:
      `push.json` shows `activities: false`; alerts still arrive.
- [ ] Delete `push.json` on the daemon, foreground the app: the record comes
      back with the same pass (no new relay registration).
- [ ] Settings → Revoke: the activity ends, alerts clear, `push.json` loses
      the record.

## The protocol and the fixtures

`mobile/PROTOCOL.md` is the one written contract both apps implement —
pairing, the route allowlist, `GET /mobile/summary`'s exact shape,
completion, approvals, SSE events, heartbeat, revocation, and the
cleartext-host table above, spelled out precisely. `mobile/fixtures/` is
the machine-checked half of that document: five JSON files generated from
a real running daemon (`node scripts/generate-mobile-fixtures.mjs`), which
`test/mobile-fixtures-current.test.js` re-derives live on every `npm test`
run so a daemon response shape that has drifted from what's committed
fails within seconds — on the Node side, in CI, not months later against
a shipped phone. If you change anything about a request or response this
document describes, regenerate the fixtures and re-run both native
clients' unit tests before assuming your change is safe.

## A defect this pass found, and fixed

An in-process, LAN-bound daemon plus `xcrun simctl openurl` / `adb shell am
start -a android.intent.action.VIEW` make almost all of the manual pass
below scriptable, without ever hand-typing into a phone. Both platforms'
full happy path — pair, see seeded tasks, tap-to-complete, go offline,
complete again, come back online and watch the queued completion land with
`completedVia: "mobile"` — passes this way end-to-end.

Getting there on iOS surfaced a real bug, not a test artifact: the first
live pairing runs against a real device all failed. The daemon-side
exchange succeeded every time (a `mobile` node was created), but the app's
own `Credentials.save()` call threw `errSecMissingEntitlement` (-34018)
writing to the Keychain, leaving the phone stuck on the pairing screen
having burned its one-time code. Two things were wrong together, and
either alone was not enough to fix it:

1. `Credentials.swift` asked for `kSecAttrAccessGroup: "sh.openagi.mobile"`
   — a literal string with no Team ID prefix. Both entitlements files
   declare `$(AppIdentifierPrefix)sh.openagi.mobile`, and `$(...)` is an
   Xcode build-setting substitution that only ever resolves inside the
   `.entitlements` file at signing time; there is no API that hands the
   resolved, prefixed string back to Swift source. The fix: stop asking
   for an explicit access group at all. A process entitled to exactly one
   keychain-access-group (true here, on both the app and the widget
   extension) is placed in that group automatically when the key is
   omitted — the standard, documented pattern for this exact situation.
2. `mobile/ios/project.yml` built with `CODE_SIGNING_ALLOWED: "NO"`.
   Entitlements are only ever embedded as part of an actual code
   signature — an unsigned build carries **zero** entitlements no matter
   what the `.entitlements` file declares, so even the fixed, unqualified
   Keychain call above still failed with the same error. The fix: sign
   with the ad-hoc identity `CODE_SIGN_IDENTITY: "-"` instead of disabling
   signing. That identity needs no Apple Developer Team, certificate, or
   provisioning profile — it works on any Mac, including headless CI — and
   Simulator does not validate entitlements against an Apple-issued
   provisioning profile the way a real device does, so ad-hoc signing is
   enough to make a merely-signed process eligible for its own default
   Keychain scope.

Regression coverage: `mobile/ios/Tests/CredentialsTests.swift` calls the
real `Credentials.save()`/`load()` against the real Simulator Keychain
under this project's actual, committed signing configuration — not a
mock — so a future change that reintroduces either half of this bug fails
a fast unit test instead of surfacing only on a live phone.

## Manual verification checklist

What the automated pass above does not cover, because it needs a literal
finger on a literal home screen:

- [ ] Add the widget to the home screen on a real device; confirm it shows
      the same tasks as the app and a "can't reach OpenAGI" state when the
      daemon is unreachable.
- [ ] Tap a task's check **on the widget itself** (not the in-app list)
      with the app killed; confirm the row disappears and, on the desktop,
      the task is `completed` with `completedVia: "mobile"`. (The pass
      above verified the in-app button, which calls the identical
      `SnapshotStore`/`OutboundQueue` path the widget's `AppIntent` /
      Glance action uses — same code, not yet the same pixels.)
- [ ] Turn networking off on the phone, tap a check, confirm the row still
      disappears locally; turn it back on, open the app, confirm the
      completion lands. (Verified live on Android via `adb`; not yet
      re-run on iOS, where Simulator has no equivalent single-command
      network kill switch.)
- [ ] From `openagi nodes`, revoke the phone; confirm it can no longer
      complete tasks and returns to the pairing screen without wiping its
      local snapshot.
- [ ] Pair a real device with a real, portal-registered Apple Developer
      Team (not ad-hoc Simulator signing). App Groups and Keychain sharing
      are both capabilities a real device validates against an
      Apple-issued provisioning profile, which ad-hoc/Simulator signing
      never exercises — a from-scratch pairing on real hardware, with a
      real Team ID, is the one check this whole automated pass cannot
      stand in for.
