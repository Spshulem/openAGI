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

## Foldable and resizable layouts

Target devices are Android foldables generally, including Galaxy Z Fold 8, and iPhone Duo. Sizes are derived from the current app window rather than a model-specific screen resolution.

Android follows the [Android fold-aware guidance](https://developer.android.com/develop/ui/compose/layouts/adaptive/foldables/make-your-app-fold-aware) and [Material adaptive navigation](https://developer.android.com/develop/ui/compose/layouts/adaptive/build-adaptive-navigation). Layout decisions use the current window and separating/occluding folding features, including flat dual-screen hinges. Hinge bounds are translated into each pane's coordinates after navigation and system insets.

| State | Navigation | Content |
| --- | --- | --- |
| Compact cover screen or narrow split window | Bottom bar | One destination; chat drafts remain available when reopened |
| Medium window | Rail when height permits | One readable content column |
| Expanded flat window | Rail | Current work and a related chat side by side |
| Book / vertical separating hinge | Rail when space permits | Work and chat on opposite sides of the hinge; RTL keeps the physical gap fixed |
| Tabletop / horizontal separating hinge | Bottom bar | Work above the fold, related chat below; the Chat tab puts history above and its composer below |
| Short landscape window | Bottom bar | One pane to preserve usable content height |

Settings and pairing use a single safe region when spanning a hinge. Pairing scrolls on short windows. Resizing retains the selected tab, shared conversations, and saved Android drafts. Supervisor polling continues while its chat is visible alongside it.

iOS follows [Apple's Duo guidance](https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo) and [adaptive layout guidance](https://developer.apple.com/videos/play/tech-talks/111463/). CI builds with the iOS 27.1 SDK so native tabs/toolbars can move to the sides. Adaptive tabs and Supervisor split navigation use system size classes and safe areas. On iOS 27.1, the chat composer uses active division reserved regions and their margins: trailing page in book posture, lower surface in tabletop. Scrolling history remains continuous in book posture. Earlier iOS versions use the same chat in one column. Drafts belong to the shared conversation, and the input keeps its view identity through layout changes.

CI runs Android geometry regressions and four emulator UI tests with synthetic content, covering cover-to-expanded continuity, book, tabletop, and chat draft/focus retention. It publishes synthetic screenshots and instrumentation reports. Injected posture tests verify layouts; they do not prove a manufacturer's physical hinge reporting.

- [ ] On a physical foldable, fold/unfold while reading Tasks, answering Inbox, and typing in both chat threads. Confirm the selected work, drafts, and active replies survive.
- [ ] In book and tabletop states, confirm no text or controls cross the hinge; repeat in RTL and with a keyboard open.
- [ ] Resize into narrow split-screen and short landscape windows, then reopen the full display; confirm all destinations and pairing controls remain reachable.
- [ ] On iPhone Duo, check outer, inner flat, book, tabletop, and 50/50 Split View; verify side controls and camera safe areas, and retain a half-written draft through each transition.
