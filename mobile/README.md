# OpenAGI mobile (iOS + Android)

Phase 1 turns a phone into a first-class OpenAGI node: pair it once, and a
home-screen widget shows today's tasks with tap-to-complete. That's the
whole surface. There is no chat, no approvals, no voice, and no daily
brief on the phone yet — those are Phase 2 and Phase 3. What Phase 1 ships:

- A Swift/SwiftUI iOS app (bundle `sh.openagi.OpenAGI`) and a Kotlin/Compose
  Android app (package `sh.openagi.mobile`), built from two completely
  separate codebases that never share code.
- A WidgetKit widget (iOS) and a Glance widget (Android) that render
  today's bucket and complete a task with one tap, entirely from a local
  on-device snapshot.
- A new `mobile` node platform on the daemon, scoped by an explicit route
  allowlist, plus `GET /mobile/summary` — one round trip for a widget
  refresh, with an ETag so an unchanged poll costs almost nothing.
- The `openagi pair-phone` CLI command, which mints a one-time code and
  prints both a manual server/code pair and an `openagi://pair` deep link.

**What this deliberately does not do.** The phone reaches the daemon
directly over your own Tailscale tailnet or LAN — never through a hosted
relay, a push-notification service, or any OpenAGI-operated server. If your
daemon is asleep, off-network, or the phone has no path to it, the widget
just shows itself as stale or unreachable. That is the tradeoff of staying
local-first, and Phase 1 does not paper over it.

## Pairing a phone

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

Swap the trailing `build` for `test` to run the unit test suite (52 tests
as of Phase 1) on the same destination. `DEVELOPER_DIR` is not optional —
without it, `xcodebuild` silently resolves against whatever Xcode is
currently the system default, which on a machine with more than one Xcode
install is rarely the one you meant.

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

## Known issue and manual verification checklist

An in-process, LAN-bound daemon plus `xcrun simctl openurl` / `adb shell
am start -a android.intent.action.VIEW` make almost all of the above
scriptable without ever hand-typing into a phone. Android's full happy
path — pair, see seeded tasks, tap-to-complete, go offline, complete
again, come back online and watch the queued completion land with
`completedVia: "mobile"` — passes this way end-to-end.

**iOS pairing currently fails on a real run.** The daemon-side exchange
succeeds (a `mobile` node is created), but the app's own
`Credentials.save()` call throws `errSecMissingEntitlement` (-34018) when
writing to the shared Keychain access group, because this project builds
with `CODE_SIGNING_ALLOWED: NO` (`mobile/ios/project.yml`) — entitlements
are only ever embedded as part of a real code signature, so an unsigned
build carries none at all, on Simulator or (since a real device refuses to
install an unsigned app in the first place) on hardware either. As of this
writing that fix is in progress but not yet landed and verified; check
`mobile/ios/Tests/CredentialsTests.swift` and `git log` on
`mobile/ios/project.yml` / `Sources/Store/Credentials.swift` before relying
on iOS pairing, and until it's resolved, treat the iOS half of the pass
below as manual:

- [ ] Build and install the iOS app on a simulator or a real, signed device.
- [ ] Mint a code (`openagi pair-phone --platform ios`) and pair.
- [ ] Confirm the phone's task list matches `openagi tasks --bucket today`.
- [ ] Add the widget to the home screen; confirm it shows the same tasks
      and a "can't reach OpenAGI" state when the daemon is unreachable.
- [ ] Tap a task's check on the widget with the app killed; confirm the
      row disappears and, on the desktop, the task is `completed` with
      `completedVia: "mobile"`.
- [ ] Turn networking off on the phone, tap a check, confirm the row still
      disappears locally; turn it back on, open the app, confirm the
      completion lands.
- [ ] From `openagi nodes`, revoke the phone; confirm it can no longer
      complete tasks and returns to the pairing screen without wiping its
      local snapshot.
