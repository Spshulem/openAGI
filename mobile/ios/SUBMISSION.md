# iOS submission candidate

## Product description

OpenAGI is a personal agent that runs on iPhone with Apple Intelligence.
Chat, memory and task tools can run on device without an account, API key or
server. Optional cloud models send requests to the chosen provider. Optional
integrations contact their services. Connecting to an existing OpenAGI main
uses that main's data and model through the paired server.

Use this description until device acceptance supports more specific claims.
This is OpenAGI's agent runtime, not Hermes. Do not claim market priority,
unlimited background operation, or that online integrations are offline.

## Required acceptance

- Fresh install: choose this iPhone, check real model availability, name the
  agent, explicitly select Apple Intelligence, finish without an account.
- Physical supported iPhone: airplane mode, multi-turn chat, remember/recall,
  create/update/complete tasks, history after relaunch. A saved cloud key must
  not change an explicit local selection.
- Disabled/downloading/unsupported Apple Intelligence: explain the state;
  offer optional cloud setup or server pairing without a dead end.
- Main/worker: main-issued phone credential through a worker shows main's
  Today, task queues, approvals, questions, shared history and model settings.
  An upstream error shows a failure, preserves pairing and keeps cached work.
- Native settings: each row opens one destination and one Back returns to
  Settings. Chat keeps a draft and streaming reply across tabs, keyboard and
  size changes. Test accessibility text and dark appearance.
- Integrations: save, test sync, imported tasks, revoked/invalid key and remove
  API key. Linear and BuildBetter have native task-source forms. Gmail, Google
  Calendar and messaging setup from iOS remain unavailable; desktop setup
  must not be advertised as completed native iOS onboarding.
- Duo: folded, expanded, book and tabletop; native reserved regions, composer
  above the keyboard, navigation and draft continuity through transitions.
  Simulator layout checks do not prove physical hinge behavior.
- Distribution-signed archive: launch, App Group/widget, notification service,
  APNs, Live Activity, pairing, model sign-in, foreground resume and data
  retention across upgrade. Unsigned artifacts do not satisfy this gate.

Debug builds accept `--local-agent-acceptance` to check real Apple inference,
the embedded task tool and local history without changing the active server
pairing. A private `Documents/openagi-device-acceptance.json` records the
result; never commit it. This check does not replace the offline/memory/UI
acceptance above. It restores model preference and removes its synthetic task.

## Store assets and account configuration still required

- Registered app and extension identifiers, distribution profiles, App Group
  and Push Notifications capability in the intended Apple Developer account.
- App Store Connect record, age rating, encryption questionnaire, support URL
  and publicly reachable privacy policy. Review notes must describe the
  account-free local path, supported devices/model availability and the
  optional server/cloud paths. A reviewer must not need a private server.
- Privacy labels based on actual provider and relay retention: local storage,
  cloud user content, connected-service credentials, APNs device identifiers,
  encrypted supervisor payloads and any optional diagnostics. The required
  reason API manifest covers app preferences, sandbox timestamps and elapsed
  timing. Reconcile its declarations with the final archive's privacy report.
- Screenshots from this exact build, using synthetic data, for the supported
  iPhone/Duo sizes. Review every image before upload.
- External OAuth registrations and redirect URIs before claiming native
  Google/integration sign-up. No OAuth client secret may ship in the app.

Version is 1.0, candidate build 2111. Keep app and extensions aligned.
Prepare a Release archive on a remote Xcode runner; run distribution
validation before submission. This document does not authorize uploading or
submitting a release, and passing fixtures alone is not submission readiness.
