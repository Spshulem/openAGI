# OpenAGI onboarding handoff: Mac, iPhone, Assistant and Supervisor

**Status:** implementation plan for review (website and README changes are in
the companion PR; this document does not change a Mac app, iOS app, Store
submission, release, or deployment).

**Success criterion:** a new user takes one real thing off their plate. The
first session should end with a real reply and one verified outcome, such as a
saved preference, a visible project status, or a tested notification. A tour,
an installed binary, or a checked checkbox is not a success by itself.

## Ownership and boundaries

| Workstream | Current evidence | Owner boundary for this handoff |
| --- | --- | --- |
| Website / GitHub quickstart | Existing static companion site recovered from the website-owner checkout; v0.0.83 release assets are public | This PR owns static copy, links, availability labels, and the GitHub-first quickstart. It does not deploy the site. |
| Mac / Supervisor | Mac menu-bar app and `/fleet` are on `main`; active implementation work is in PRs [#325](https://github.com/Spshulem/openAGI/pull/325), [#327](https://github.com/Spshulem/openAGI/pull/327), [#331](https://github.com/Spshulem/openAGI/pull/331), and [#332](https://github.com/Spshulem/openAGI/pull/332) | This PR documents the target flow and links the shipped controls. It does not edit those files or duplicate their implementation. |
| iOS native app | Source includes server pairing, phone-only mode, Apple Intelligence readiness, hosted fallback, and notification setup; pairing/build work is in [#334](https://github.com/Spshulem/openAGI/pull/334), [#335](https://github.com/Spshulem/openAGI/pull/335), [#253](https://github.com/Spshulem/openAGI/pull/253), and [#264](https://github.com/Spshulem/openAGI/pull/264) | This PR keeps iOS source/QA status explicit. It does not modify Swift, signing, build numbers, or Store submission metadata. |
| Local models | Setup supports OpenAI-compatible local servers; iOS and Android source include on-device readiness/download states | This PR records the no-key/offline contract and acceptance tests. It does not add a model runtime or silently select a provider. |

## What is shipped and verified today

### Public distribution

- GitHub is the canonical source, documentation, release, and issue surface.
- Public release **v0.0.83** (published 2026-11-20) has a Mac DMG,
  `OpenAGI-Windows-x64.zip`, `OpenAGI-Linux-x64.tar.gz`, and
  `OpenAGI-Linux-arm64.tar.gz`, each portable archive with a checksum where
  provided. The website should link to the latest release page and its assets;
  it must not imply that a source archive is a native app.
- `https://openagi.sh/download` currently redirects to the Mac DMG. The
  all-platform release page is the reliable public download index.
- The iOS and Android apps are source/QA builds. No App Store, TestFlight, or
  Play Store download is advertised. An uploaded artifact or Store submission
  is not the same as a publicly installable app.

### First-run behavior

- The cross-platform web setup wizard is deterministic: choose a provider,
  connect it, verify a real response, save dashboard access, then enter chat.
- Cloud providers, an OpenAI-compatible local server (Ollama/LM Studio), and
  the native Apple Intelligence path on compatible Mac/iPhone builds are
  supported by the current code. The browser runtime does not provide Apple's
  native model bridge.
- Without a usable model, deterministic help and the setup UI remain
  available, but ordinary model reasoning cannot be claimed. A key saved in a
  field is not proof that a provider works.
- `Get started` has concrete guides for first chat, memory, coding-agent
  monitoring, screen/computer use, device pairing, and building on the runtime.
  A guide explains and links to controls; it does not grant permissions.

### Supervisor behavior

Supervisor groups supported coding conversations by project and shows work
that is running, waiting on checks, blocked, or waiting for the owner's
decision. It attaches the relevant question, PR, and verification evidence so
the owner can decide from the Mac, browser, or paired phone. Observe mode is
the safe starting point; Propose requires a user send, and Auto is an explicit
bounded setting. Discovery alone never sends a message or runs an action.

The existing supervisor source readers are not universal app discovery. They
read supported local session stores and only expose the capabilities the
current node advertises. A discovered conversation is not automatically a
managed project, and an agent's “done” text is not proof of passing CI,
merging, or shipping.

## Target onboarding: two combinable, skippable paths

The first screen should offer three quick taps:

1. **Personal Assistant** — remember useful preferences, optionally observe
   Mac activity, and complete one concrete task.
2. **Agent Supervisor** — monitor coding work, then inspect one real project
   status, blocker, or watched update.
3. **Both** — run the two short paths in either order.

Each path can be skipped and resumed from the same checklist. The app asks two
questions before choosing a default: *Do you code or vibe-code?* and *Do you
already use an agent on this device or another one (Codex, Claude Code, T3,
Paseo, or something else)?* It verifies the actual support and authentication
state instead of assuming a CLI, project, model, or host exists.

### Part 1: deterministic setup and first success

#### Assistant path

1. Run the existing setup wizard. Keep provider keys and sign-in in Settings,
   never in chat.
2. Explain that optional Mac activity observation is separate from chat. Ask
   for Screen Recording only when the user chooses it, show what is captured,
   and provide Pause, exclusions, delete, and local-model guidance.
3. Offer one concrete first task (for example, a three-item brief or a saved
   non-sensitive preference). Show the real reply, then ask whether the user
   wants to save the preference. Corrections should be explicit and reviewable.
4. Offer integrations one at a time and say what each unlocks. Settings is the
   only place for keys and account authorization.

#### Supervisor path

1. With explicit opt-in, perform a **read-only prescan** of installed apps and
   supported local Codex/Claude Code/other coding-session stores. Show the
   discovered projects, source, last activity, and what can be managed.
2. Ask the user which project(s) to manage. Do not grant blanket access, send
   an agent message, start a session, or take an action from discovery alone.
3. Demonstrate one real outcome: a project status, a blocker that needs a
   decision, or a watched update. Link to the exact session/PR/evidence and
   keep Observe as the default.
4. Explain the difference between an existing conversation being watched and a
   Supervisor-managed session. A watch is read-only; sending requires the
   normal user approval or an explicit bounded Auto setting.

#### Both paths and recovery

- The first message must receive a real reply before the path is marked
  successful.
- Offer **Test notifications** and record whether the device received one.
  A notification permission denial becomes a visible “you can enable this
  later” state with a retry link, never a dead end.
- Verify one genuine setup outcome: model test, saved-and-recalled preference,
  reachable paired host, visible project status, or notification receipt.
- Allow skip/resume at every optional step. Explain recovery for no model,
  no coding agents, denied screen/notification permissions, unreachable host,
  expired pairing code, and a failed provider test.

### Mac-specific route

1. Download the signed Mac app or use the shell/source installer.
2. Ask whether this is the user's main computer or a remote/always-on host.
   If remote, guide a separate node and a private route (Tailscale or
   authenticated HTTPS); never treat a LAN announcement as a secure tunnel.
3. Offer the iPhone companion with a one-time QR/deep link and a manual
   address/code fallback. Verify reachability and capabilities after pairing.
4. Keep solo Mac operation first-class. Pairing is optional and does not create
   an account or require a cloud key.

### iPhone-specific route

1. Let the user connect an existing computer or stay entirely on the phone.
2. Check actual Apple Intelligence availability (hardware, OS, enabled feature,
   and downloaded model) and show downloading, unavailable, and unsupported
   states. Offer a compatible hosted provider or downloadable on-device model
   where the build supports it.
3. State which features require a host: shared tasks, integrations, coding
   Supervisor, and host computer use. Phone-only chat, memory, and local tasks
   remain useful without pairing.
4. Pair over the reachable address with a one-time code/QR and manual fallback,
   then verify one host request. A phone's `localhost` is never the Mac.

## Part 2: continuity, offline and no-key fallback

This is the next implementation milestone, separate from the website copy.

- Add a versioned, bundled OpenAGI setup/help skill that supported local models
  can use to explain the app and, only after explicit permission, help configure
  it. The skill must be inspectable and work without cloud credentials.
- Add a deterministic help path for “no model” that answers installation,
  navigation, permissions, pairing, and recovery questions from local bundled
  content. It must not pretend to reason or take an external action.
- When credits or daily/monthly caps are reached, the network drops, or a
  provider is unavailable, preserve the conversation and explain the boundary.
  Offer a manual retry or an opted-in local fallback; do not silently resend a
  possibly completed turn or send local-only context to a cloud provider.
- Keep local-only data local. A fallback choice must display the active model,
  destination, and limitations before sending.
- Verify these paths on a supported Mac and a physical supported iPhone. A
  simulator, uploaded artifact, or a Store submission is evidence of build
  availability, not device acceptance.

## Acceptance matrix and blockers

| Check | Evidence required | Current status |
| --- | --- | --- |
| Standalone Mac | Fresh app/source install, deterministic setup, real reply, local/no-key fallback | Web/runtime and release CI coverage exist; a fresh native Mac walkthrough is not part of this PR. |
| Standalone iPhone | Physical phone-only setup, Apple/on-device availability state, real reply, notification test | Blocked on a usable physical device/mirroring session; source flow is documented. |
| Mac → iPhone pairing | QR/deep link and manual code, reachability, one host request | Source and CLI pairing exist; physical acceptance remains open. |
| iPhone → Mac pairing | Same as above from phone setup | Source flow exists; physical acceptance remains open. |
| Read-only discovery | Opt-in scan, project selection, no sends/actions, real status shown | Supervisor source readers and Observe mode are shipped; the unified prescan UX is planned. |
| Offline/no-key | Deterministic help and opted-in local fallback on supported devices | Parts exist in current setup/mobile code; unified help skill and device proof are planned. |
| Notifications | Test notification and denied-permission recovery | Platform-specific paths exist; cross-platform onboarding handoff is planned. |

The current physical-device blocker is Mirroring/device access, not a claim
that Windows or Linux release packaging is unavailable. The website must keep
these distinctions visible: **verified locally**, **passed in CI**, **uploaded**,
**publicly downloadable**, and **planned** are different states.
