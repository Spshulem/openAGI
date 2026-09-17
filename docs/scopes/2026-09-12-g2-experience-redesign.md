# OpenAGI + G2: a simpler, dependable everyday experience

Date: 2026-09-12. Status: full product and engineering scope. A bounded, reversible 0.4.18 candidate is implemented; see [candidate verification](../verification/2026-09-12-g2-experience.md) for delivered scope, exclusions and outstanding physical acceptance. The source audit below describes the pre-redesign baseline.

## Recommendation

Keep the existing OpenAGI architecture and safety boundaries. Redesign the first-run journey, information hierarchy, and interaction states as one experience across computer, phone, and glasses. The product should make three things immediately clear: what it is doing, where the result lives, and what the user can do next.

The glasses are a quiet conversation surface. The phone handles setup, browsing, and detailed controls. The main owns conversations, memory, execution, and policy; connected computers provide explicitly authorized capabilities. OpenAI is one model provider, not a second name for OpenAGI.

This pass inspected the reviewed G2 0.4.17 source at `2507228b8d41e4fa7e89513300bcb0850010b12f` in `/Users/shooby/Dev/openagi-pr101-rollout`, its main-side integration and desktop setup, and the locally available public coding-setup branch at `1f3acce6cad766b45d21cf18707360b2efb3c030`. It did not inspect the currently installed phone/glasses UI, measure latency, recheck GitHub CI, change runtime configuration, or submit anything. Historical scope documents are context, not proof of the current implementation. Existing unrelated work is untouched.

## 1. What the current source tells us

| Area | Evidence | Consequence for the scope |
| --- | --- | --- |
| First launch | [Phone pairing form](/Users/shooby/Dev/openagi-pr101-rollout/integration-clients/even-g2-overlay/src/ui/openagi-phone-companion.ts:54) starts with an HTTPS main URL and pairing code; token connection is already under an advanced disclosure. | Keep the scoped exchange, but add guided setup and connection transfer. A new user should not have to understand a main versus a node before seeing help. |
| Everyday phone UI | [Companion controls](/Users/shooby/Dev/openagi-pr101-rollout/integration-clients/even-g2-overlay/src/ui/openagi-phone-companion.ts:71) combine Listen/Lifelog/Inbox/Recent, global navigation buttons, retention, providers, transport, and listening options. | Separate primary actions from settings; remove overlapping Listen/Lifelog controls. Existing tabs and bounded lists are useful, so do not rebuild them as if absent. |
| Contradictory instructions | [Settings copy](/Users/shooby/Dev/openagi-pr101-rollout/integration-clients/even-g2-overlay/src/ui/openagi-phone-companion.ts:105) still says double-tap pauses; [root routing](/Users/shooby/Dev/openagi-pr101-rollout/integration-clients/even-g2-overlay/src/app/openagi-g2-app.ts:491) requests the native exit dialog. | Generate gesture help from the same interaction contract as the handlers. Root exit is a non-negotiable reviewer requirement. |
| First-run OpenAGI | [Setup wizard](/Users/shooby/Dev/openagi-pr101-rollout/src/setup-wizard.js:203) presents eight sections and technical credentials; a useful early Save option already exists. | Turn the minimum setup into the main journey; optional channels, tools, observation, and automation come after the first successful interaction. |
| Speech expectations | [Preferences](/Users/shooby/Dev/openagi-pr101-rollout/integration-clients/even-g2-overlay/src/openagi/store.ts:20) default to buffered OpenAI; live Deepgram and relay/direct options exist. | Identify supported, configured speech modes before presenting live transcription. A model-provider name does not establish streaming capability. |
| Recovery | [G2 ask route](/Users/shooby/Dev/openagi-pr101-rollout/src/hosted-interface.js:1565) accepts audio/text and conversation ID, but no client request key; disconnect aborts that stream. Client recovery preserves text but can report uncertain delivery. | Keep the recent recovery fixes and add a durable request receipt/resume contract. Reconnecting must not mean sending the question again. |
| History | [Main session routing](/Users/shooby/Dev/openagi-pr101-rollout/src/integrations/g2-channel.js:142) uses stable node-scoped sessions; [phone history](/Users/shooby/Dev/openagi-pr101-rollout/integration-clients/even-g2-overlay/src/openagi/store.ts:25) stores only 30 answer entries. | Main-owned history already exists. Build scoped retrieval and explicit handoff, not another independent history system. |
| Lifelog | [Companion persistence](/Users/shooby/Dev/openagi-pr101-rollout/integration-clients/even-g2-overlay/src/openagi/proactive.ts:131) batches final text; [owner page](/Users/shooby/Dev/openagi-pr101-rollout/src/lifelog-page.js:1) offers moments, analysis, corrections, and follow-ups. | Surface these existing features through a coherent History view and explicit save states. Capture, saving, and analysis are different states. |
| Computer capabilities | [Coding setup](/Users/shooby/Dev/openagi-pr101-rollout/src/coding-supervisor-ui.js:91) and [readiness guide](/Users/shooby/Dev/openagi-pr101-rollout/docs/setup/computer-use-readiness.md:1) distinguish setup, reachability, and permission. | Add capability-specific setup cards on the selected computer. A connected Mac does not imply every local session is readable or controllable. Preserve the public-setup branch's recoverability improvements. |
| Maintenance | [App controller](/Users/shooby/Dev/openagi-pr101-rollout/integration-clients/even-g2-overlay/src/app/openagi-g2-app.ts:32) coordinates many independent flags; [phone rendering](/Users/shooby/Dev/openagi-pr101-rollout/integration-clients/even-g2-overlay/src/ui/openagi-phone-companion.ts:227) infers button behavior from status text. | Introduce typed state/view models incrementally; do not make English copy part of the control API. |
| Documentation/build identity | [Setup guide](/Users/shooby/Dev/openagi-pr101-rollout/docs/setup/even-g2.md:12) says ten-minute codes while [implementation](/Users/shooby/Dev/openagi-pr101-rollout/src/node-enrollment.js:3) uses thirty; [package generation](/Users/shooby/Dev/openagi-pr101-rollout/integration-clients/even-g2-overlay/scripts/package-openagi.mjs:25) defines 0.4.17 separately from package.json. | Consolidate current instructions and release metadata. Keep historical changelogs clearly historical; make clean-checkout packaging reproducible without an undocumented local base. |

## 2. One understandable product

Recommended public name: **OpenAGI for G2**, subject to the existing store identity. Keep compatible third-party agent hosts as an advanced connection option. Do not rename package IDs or reset storage to achieve a branding change.

Use these terms consistently:

- **Home computer:** the machine hosting OpenAGI main. Show its actual user-selected name.
- **Connected computers:** other authorized execution targets. Show the target for each action.
- **Ask:** explicit conversation with the assistant.
- **Lifelog:** opted-in background conversation capture while the platform permits recording, with retained final text.
- **Inbox:** updates and items needing attention.
- **History:** Chats and Lifelog, clearly labeled and searchable.

Keep node IDs, bearer tokens, PCM, relay selection, provider permission tiers, and raw diagnostic messages in advanced settings or support details. Do not hide meaningful privacy or billing information.

## 3. First-run and connection setup

### Existing OpenAGI user

`Add glasses on home computer → transfer connection → confirm computer → pair → test speech and one answer`

1. Add **Connect glasses** to OpenAGI's visible first-run actions and Devices page, not only a technical Nodes screen.
2. Show a short-lived connection QR/link plus a manual URL-and-code fallback. The transfer includes the exact HTTPS origin and single-use enrollment material, never an owner token or permanent provider key.
3. Show the computer name, verified origin, and what access the glasses receive before confirming. Do not silently select a nearby machine or promote a node to main.
4. Verify pairing, compatible main version, configured speech capability, and connection from the phone-hosted client. Distinguish main unavailable, TLS/network failure, expired code, revoked pairing, and missing speech configuration.
5. Offer a brief microphone/gesture tutorial and a user-initiated test question. Show actual words and an answer, not merely a successful health check. State any provider usage before a paid test.

QR scanning or deep-link entry into an Even-hosted app must be proven against the supported Even SDK/app. Do not assume the phone camera can open a particular plugin or prefill its fields. If that path is unavailable, ship an explicit paste-connection flow and keep manual URL/code entry. The goal is no manually typed host/token in the recommended path, not a false promise that a six-digit code can discover any private server on the Internet.

### New OpenAGI user

`Install OpenAGI on a computer → choose home/connect existing → configure assistant → secure phone access → connect glasses`

- Offer **I already use OpenAGI**, **Set up on my computer**, and a clearly labeled, non-recording **Preview** with sample content. No-main preview is not a functioning standalone assistant.
- A phone-first install gets a short computer setup link/QR with the next step preserved. It should not dead-end at an empty server URL field.
- The computer setup asks whether this is a new home or a computer joining an existing home. Never create two mains by accident.
- Validate the selected reasoning provider/account using supported authentication. Do not imply a ChatGPT subscription automatically supplies an OpenAI API key. Defer raw model IDs and advanced reasoning controls.
- Offer a guided, explicitly authorized Tailscale/private HTTPS setup or an existing HTTPS server. Verify access from the phone, including cellular when remote use is requested. Do not expose the service publicly or weaken TLS as a shortcut.
- Configure live speech only when wanted. Reuse a configured, tested live provider after disclosing where audio goes; otherwise offer setup or honestly labeled transcription-after-stop. Never silently switch providers.
- Set a visible budget before paid background features. Introduce integrations, coding agents, and computer control after the first successful question.

Returning users land in their existing conversation or saved Lifelog mode. Recoverable connectivity failure must not trigger onboarding, erase pairing, or require a fresh code. Replacement/revoked devices use a guided owner-approved repair flow.

## 4. Phone information architecture

Use three primary destinations and a Settings button:

| Destination | Primary content | Keep out of the primary view |
| --- | --- | --- |
| Talk | One Talk/Stop action, current conversation, live words during an explicit question, current request state, Ask only/Lifelog mode selector | Provider transport, token fields, global page-navigation buttons, long lifecycle explanations |
| Inbox | Needs your attention / Updates; bounded items with source and relevant actions | Raw logs, unrelated transcript-retention settings, an unbounded task wall |
| History | Chats / Lifelog filter, search, date, recent conversation cards, exact conversation continuation | Repeated setup panels or settings above the history |
| Settings | Connection/devices, speech, talk gestures, privacy, notifications, spending, diagnostics | Daily-use actions that require hunting through settings |

Talk layout, as a hierarchy rather than a final visual design:

```text
OpenAGI                              Settings
Connected to [home computer]

[ Ask only | Lifelog ]

Current conversation / recording / answer
[ One primary action for this state ]

Talk                 Inbox             History
```

Keep a compact connection indicator; remove the permanently dominant status card. Details expand only when useful. Avoid showing New conversation, Last answer, Next page, Previous page, Disconnect, and Exit as peer controls on every tab.

Visual system: system typography, neutral surfaces, one accent for the primary action, consistent 8/16/24 spacing, at least 44 CSS-pixel phone targets, visible focus, accessible labels and contrast, system light/dark support, reduced motion, safe-area handling, and layout that survives larger text and narrow screens. Prefer one main scroll surface per destination. Replace browser prompt dialogs in the richer lifelog flows with accessible in-context forms.

## 5. Glasses interaction contract

Preserve Even's root-page exit convention. Do not reassign root double-tap to pause, sleep, or marking a moment.

| Context | Tap | Swipe | Double-tap |
| --- | --- | --- | --- |
| Ask home | Start question | Up: Inbox; down: Recent, even when either is empty | Native exit confirmation via `shutDownPageContainer(1)` |
| Quiet Lifelog root | Start question in tap mode; no accidental Talk in verified hold mode | Up: Inbox; down: listening controls | Native exit confirmation |
| Manual recording | Stop and send, or review if chosen | Do not navigate away unintentionally | Cancel recording without sending |
| Transcript review | Send | Read transcript | Return to a draft/action choice; preserve text until explicit discard |
| Request running | Toggle answer/activity | Read without moving the user's position | Explicit stop confirmation |
| Answer | Follow-up in this conversation | Read pages | Back to the prior home/Lifelog state |
| Lists/details | Open selected item/relevant actions | Browse items or detail pages consistently | Back one level |

Hold-to-talk remains optional, with tap and phone equivalents. Enable it confidently only after the device tutorial verifies press and matching release events. No release event means cancel/recover, never auto-send. Do not assign hold both Talk and task completion in the same context.

Quiet Lifelog shows the small upper-right recording dot, without standing instructional text. Preserve truthful capture indication when another screen is open. A brief, opted-in actionable notice can appear during idle, then return to the prior screen; never steal an answer's reading position or a draft's focus. Contextual help lives in controls/the phone, with short hints during first use.

Answers begin with a concise, plain-text response sized for the display. Longer detail remains reachable; do not truncate or silently discard safety-critical content. Expose actual public stages and tool activity, such as **Checking Codex sessions**, not private chain-of-thought or invented progress. “Connected” is transport status, not evidence of ongoing work.

Display blanking is not hardware sleep. Its wake behavior must remain compatible with root exit. Do not promise gesture or battery behavior based on SDK declarations alone.

## 6. One Lifelog mode, with honest state

Replace the constellation of Keep microphone listening, Quiet listening, Keep lifelog on, and retention controls with one primary Lifelog action and a compact setup sheet.

- On first enable: explain audio destination, saved final text, retention, and participant consent. Analysis and proactive notifications remain separate explicit choices, not silently enabled consequences.
- Persist the preference, but model actual capture separately: **Starting**, **Recording**, **Paused**, **Reconnecting**, **Consent needed**. Preserve the current four-hour consent limit; resuming never extends it.
- User Pause stays paused until Resume. Turning Lifelog Off disables automatic resumption. A system interruption can resume only with the existing valid grant and permitted foreground/lifecycle conditions.
- Distinguish **Listening**, **Saving**, **Saved on home computer**, and **Some text was not saved**. A visible dot is not a save receipt.
- Put transcripts, marked moments, inferred actions, and daily summaries under History → Lifelog. Label unverified speakers and inferred commitments; make source excerpts easy to inspect.
- An utterance such as “remind me to file taxes tomorrow” can produce **Reminder suggested**, with interpreted date/time and confirmation. Do not claim it is scheduled until main confirms the operation.
- Make moment edits, export, retention, and deletion discoverable while keeping owner-only operations behind owner authentication. Accepted tasks and transcript deletion have different lifecycles.

Phone-lock recording is a separate feasibility gate. Submission/developer mode, shorter packets, or changing a toggle cannot establish OS background entitlement. Keep the existing experimental path explicitly experimental and off by default unless real phone/Even/firmware combinations pass capture-and-save testing. If the host suspends capture, say so and resume honestly; any supported native companion/background solution would be a separate scoped dependency, not a promised UI fix.

## 7. Request reliability and continuity

Introduce a scoped, durable request contract shared by main and client:

`Draft → Sending → Accepted → Working / Awaiting approval → Completed / Failed / Cancelled`

**Delivery unknown** is a distinct recoverable state, not a normal failed draft.

- Generate a client request key before submission. Main persists a receipt bound to node, conversation, payload, and request key. Repeated transport submissions return the same request rather than starting another turn.
- Reconnect to request status/events using a cursor or snapshot. If acceptance was lost, query by the original key first. Do not automatically resend a possible tool action.
- Keep explicit cancellation separate from losing the phone connection. Bound server work with existing deadlines/budgets; backgrounding must never start a new microphone or grant additional authority.
- Preserve verified answer text, incomplete streamed answers, and review drafts. Existing PR #103 recovery behavior is a foundation, not missing work to redo.
- Prefer brief reasons and one next action: **Connection lost — reconnecting to your answer**, **Question saved here — review and send**, **Speech setup needed — open settings**. Put technical codes and request IDs in diagnostics.
- Keep manual-question draft persistence separate from ambient transcript retention. Any crash-surviving draft cache needs a bounded lifetime, clear disclosure, deletion rules, and storage-security review. No durable raw-audio backlog or replay is proposed.
- Use main-owned scoped chat retrieval for full history. Return to the same conversation, selection, and reading position on glasses/phone/desktop. A local history write failure must not turn a completed request into “send again.”
- Reuse desktop authentication where available. A device-scoped handoff can grant access only to its permitted conversation, with expiring, single-use exchange material; it must not convert a G2 token into owner privileges. Owner operations still require owner sign-in.

Transport deduplication is not a blanket exactly-once guarantee for external tools. Interrupted side effects still need operation receipts, reconciliation, or explicit uncertainty before any retry.

## 8. Proactivity, computer actions, and costs

Make Inbox the place for **Needs approval**, **Needs a reply**, and **Finished**. Each card identifies source, computer/session, last update, and available action. Preserve filters, selection, read state, and quiet hours. Dismiss, complete a task, and approve a computer action are different operations.

For Codex/Claude, provide a per-computer checklist: reachable, provider installed, signed in, chosen project folders, session inventory, and supported delivery route. Distinguish discovered/read-only sessions from managed/reply-capable sessions; missing or stopped sessions are not automatically “done.” Use a deliberately selected disposable session for the first end-to-end control test.

For computer use, show the exact target and next permission needed. Retain authenticated routing, user approval, expiry, cancellation, privacy exclusions, audit logs, and stale-screenshot rejection. Scanning or onboarding never changes OS permissions or sends session messages by itself.

Expose three different cost categories: assistant reasoning, speech transcription, and optional background analysis. Preserve the owner's chosen main model; recommend a supported low-cost model such as Luna for bounded background analysis, not for every role by default. Provider/CLI charges outside OpenAGI's ledger must be explicitly labeled. UI refreshes, unchanged watches, and readiness checks must not invoke a model. Do not turn on all connectors or recurring analysis during onboarding.

## 9. Engineering cleanup that enables the UX

1. Create typed connection, capture, request, and navigation states with explicit transitions and effects. Keep these separate instead of multiplying unrelated flags into a single giant mode enum.
2. Derive phone labels, glasses hints, and allowed gestures from those states. Remove status-string parsing and conflicting handwritten legends. Preserve the existing tested SDK adapter.
3. Add a versioned, scoped capability/readiness response: main role/name, protocol support, speech availability, history/resume support, and precise configuration blockers. Before authentication expose only the minimum required for safe connection, not private topology or credentials.
4. Split companion views into setup, Talk, Inbox, History, and Settings modules with shared spacing, fields, status, and empty/error components. No framework replacement is required just to split these files.
5. Keep main-owned canonical stores; add migrations and compatibility fallbacks rather than creating duplicate schedulers/history stores in the glasses client.
6. Make the G2 build reproducible from committed, pinned source and lockfiles. Keep a deliberate shared boundary with the base G2 project, preserve unrelated BuildBetter functionality, and remove dependence on an undocumented local assembly. Record one source manifest, bundle version, minimum main capabilities, and artifact checksum.
7. Consolidate current user documentation and capability-driven help. Archive historical behavior descriptions so old double-tap, expiry, and provider-key instructions do not read as current setup requirements.
8. Add a local bounded diagnostic timeline: gesture, microphone-ready, first PCM, speech-ready, first text, stop, main acceptance, last progress, save receipt, terminal result, and lifecycle transition. Default logs exclude transcripts, audio, credentials, and tool payloads. Export is previewed and user-initiated, not automatic telemetry.

## 10. Delivery order

| Batch | Scope | Completion gate |
| --- | --- | --- |
| A — Trust foundation (P0) | Typed request/capture state, durable request receipts/resume, precise failures, capability handshake, preserve current exit/recovery fixes | Network/lifecycle fault tests show no duplicate turn and no false recording/saved state |
| B — First successful use (P1) | Computer/phone setup, connection transfer feasibility, guided pairing/repair, provider readiness, first-question tutorial | Fresh installation completes without engineering help or raw owner-token entry on glasses |
| C — Everyday experience (P1) | Three phone destinations, minimal glasses screens, unified Lifelog control, consistent gestures, shared history/handoff, contextual activity | Full ask/follow-up/history/Lifelog loop passes on actual glasses |
| D — Proactive polish (P1/P2) | Clear coding/computer capability setup, evidence-linked inbox actions, moment review, cost controls, diagnostics | Explicit-action and quiet/cost tests plus targeted computer dry run |

Treat these as dependent engineering slices, not a new public version for every slice. Ship compatible main changes first, then one coherent G2 candidate after integrated testing. Do not bump or relabel the existing 0.4.17 artifact during scoping. Pin a candidate for hardware feedback; batch fixes before the next candidate. Clean up modules as their behavior moves, not in a simultaneous full rewrite.

## 11. Acceptance criteria and physical testing

The following are proposed targets, not measured results:

- With an already configured, reachable main, a first-time tester pairs and receives an answer within two minutes without help. Fresh computer setup has its own measurement excluding installer/provider-login waits; target five minutes of active setup effort.
- At least four of five new testers can find Talk, Lifelog history, Pause, follow-up, and Exit without verbal instructions.
- A recognized gesture gets visible feedback within 250 ms, excluding native double-tap disambiguation. On the agreed healthy live-speech test network, target p95 first interim text within 1.5 seconds of speech onset and Stop-to-main-acceptance within two seconds. Measure these stages separately from model/tool time.
- No recorded draft/partial answer disappears solely because of navigation or a stream interruption. An uncertain delivery never causes an automatic duplicate action.
- Fifty automated interruption/reopen state sequences preserve credentials and valid preferences; explicit Off, pause, revocation, expired consent, or changed main never silently starts recording.
- Ten minutes of quiet foreground Lifelog shows only the recording indicator, except genuine errors or eligible notices. A marked phrase is verified in main's saved history. Longer endurance testing checks actual saved segments and resource use, not only a dot.
- Eighty-item inbox fixtures remain browsable with swipes, preserve selection, and keep task completion separate from dismissal. New arrivals cannot change a pending action's target.
- Root double-tap opens native exit; cancelling preserves the session. Child Back, hold/release cancellation, re-entry, and continued pairing all pass on the installed candidate.
- Phone layouts pass narrow/wide widths, larger text, keyboard navigation and screen-reader checks; glasses text is readable, plain text, and not clipped while streaming or paging.
- Revocation, scope isolation, permission expiry, stale screenshots, provider failure, denied microphone access, dropped final transcript, lost acceptance/result, budget refusal, and interrupted side effects are covered by focused tests.

Physical test session with the user: pair a clean install; ask a 15-second question; make two follow-ups; browse old answers; try the optional hold gesture on the actual glasses/ring; cancel and dismiss the native exit dialog; record/mark a Lifelog phrase; interrupt Bluetooth/network and recover; verify saved text on main; then test phone lock and another foreground app separately. Use one disposable Codex/Claude session for an explicitly approved read/reply and one harmless, approved action on the selected Mac.

Phone-lock acceptance must include a baseline phrase, a distinct phrase each minute while locked for five minutes, app switching, unlock, and verification of every expected phrase in main history. Repeat per supported phone OS, Even app version, and firmware. A failed run means that combination is not marketed as continuous background recording.

Automated checks, CI, packaged artifact, installed build, device behavior, and store approval remain separate gates. Use remote build infrastructure for production builds; no heavy local build or live service is needed to finish this scope.

## 12. Boundaries

This is a source-backed scope, not a complete security audit or a pixel-accurate assessment of the installed app. Remaining feasibility decisions are Even connection-link/camera support, reliable hold/release delivery, and supported lock-screen behavior. Test those early; keep a viable manual/foreground path regardless.

Not included: a hosted multi-tenant OpenAGI service, accounts/subscriptions, standalone on-glasses reasoning, recording without consent, unrestricted computer control, automatic outbound actions, a replacement transcription company, or a full redesign of unrelated OpenAGI subsystems. The next implementation should begin with the trust foundation and a small set of approved screen/state designs, not more settings.
