# Combined mobile acceptance

[PR #211](https://github.com/Spshulem/openAGI/pull/211) is the single open
integration and QA PR for the iOS Supervisor push work from #208 and phone
onboarding/workspace work from #209. Both original PRs are already on main.
The integration branch also carries the push follow-up fixes from #211.

iOS covers a local phone agent and a paired server. Android covers its
existing paired-server app. Android phone-only mode is a separate project.

## Automated gates

All results must identify the tested PR head. A new source change needs new
results. Download artifacts from that same run when doing interactive QA.

| Gate | Coverage | Evidence |
| --- | --- | --- |
| iOS mobile | Native tests; real embedded Node enrollment and model bridge; built-in skills; interrupted onboarding; model readiness; paged offline upload; push cancellation, cleanup, encryption, categories and actions | Test-result bundle, simulator app, unsigned device app; bundled Node asserted in both app builds |
| Android mobile | Native unit tests, Android lint, debug APK build; pairing, transport, protocol, offline snapshots and outbox regressions | XML/HTML reports and debug APK |
| G2 experience | Daemon tests including mobile fixtures, model fallback, mirror/workspace routes and push delivery; G2 typecheck, lint, tests, packaging, bundle and secret checks | CI job log |
| Push relay | Relay registration, encrypted payload handling, pass retirement and delivery failures | Relay CI test log |

The integration must retain both background behaviors: start the embedded
daemon before refreshing a phone agent, and cancel push synchronization and
complete background refresh once when its time expires. An embedded phone
agent must not register a server push channel.

## Interactive acceptance

These boxes are acceptance criteria, not claims of completed testing. Record
the head, artifact run, device/OS, steps and observed result in the PR. Use an
isolated daemon, disposable tasks/questions and a controlled agent fixture.

- [ ] iOS fresh install with Apple Intelligence: start on the phone, name
      the agent, send a message, observe real generation and restart the app.
- [ ] iOS interrupted onboarding: terminate during setup, relaunch and
      confirm the embedded daemon starts and the app remains usable.
- [ ] iOS without a local model: dismiss model settings with no provider
      and confirm setup stays blocked; configure a cloud provider, finish
      setup and confirm a real reply. Exercise key-based and ChatGPT paths.
- [ ] iOS workspace: edit instructions, create a skill, schedule a job and
      verify their saved state after relaunch.
- [ ] On iOS and Android, pair to the isolated server; verify Today, Tasks,
      Inbox, Chat, Supervisor and Settings against the daemon's durable state.
- [ ] Start with the server unavailable, then restore the connection without
      relaunching or pulling to refresh. Today, Tasks, Inbox and its badge
      must recover. Repeat after backgrounding the app and changing server data.
- [ ] On both platforms, complete a task offline, restart, reconnect and
      confirm exactly one durable completion with `completedVia: mobile`.
- [ ] On iOS, continue with the phone agent from an offline server copy;
      add enough work to span multiple upload pages, reconnect and confirm
      all additions arrive before switching back. Interrupt an upload and
      confirm retry preserves the remaining additions.
- [ ] On both platforms, revoke the pairing and confirm old credentials
      cannot read or mutate server data; pair again without replaying old work.
- [ ] On real iOS and Android hardware, add the home-screen widget, complete
      a task while the app is killed and confirm durable delivery on reconnect.
- [ ] On a signed iPhone, verify shared Keychain/App Group access while
      locked, encrypted APNs alerts, answer/dismiss actions and durable answers.
- [ ] On that iPhone, verify Live Activity start, update and end, including
      a quiet fleet, a transient relay error and a revoked pairing.

Simulator signing and unsigned device builds do not establish APNs,
Live Activity, shared entitlement or real Apple Intelligence acceptance.
Physical-device checks require a connected, available device and valid
development signing. Keep the PR draft until the applicable checks above
have actual evidence; mark an unavailable prerequisite explicitly.
