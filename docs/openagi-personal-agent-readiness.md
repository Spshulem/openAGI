# OpenAGI personal-agent readiness

This is an implementation and acceptance map, not a claim that every capability
is shipped or working on a particular machine. Keep account details, hostnames,
session contents, tokens, and local paths out of public evidence.

## Recovery before onboarding

- An unreachable daemon means configuration is unknown, not that credentials
  are missing. Show setup only after a successful health response explicitly
  reports an unconfigured provider.
- Uncaught synchronous exceptions must terminate non-zero so a supervisor can
  recover. Do not repeatedly log a formatted stack and retain the listener.
- The desktop daemon inherits its log file directly rather than depending on
  parent-owned pipe readers. Preserve external processes unless ownership is
  verified; do not broaden automatic process-killing to arbitrary app copies.
- Reconcile approvals and the brief when health recovers. Missed SSE events
  must not leave stale failure banners on screen.
- Release acceptance: install the signed candidate, verify recovery with a
  disposable daemon fault, and confirm both the API and visible UI recover.
  Source tests alone do not prove an installed app contains the changes.

## One orchestrator, several interfaces

The intended architecture is G2 / desktop / chat -> OpenAGI -> bounded coding
supervisor adapters -> Claude Code and Codex. The existing supervisor has
discovery, attention classification, and delivery-route selection; reuse those
contracts instead of adding a second LLM just to relay notifications.

The G2 work lives in `src/integrations/g2-channel.js` and
`integration-clients/even-g2-overlay/` on its feature branch. Preserve node-scoped
enrollment: glasses receive no owner token, provider credential, or arbitrary
access to another conversation.

The coding-supervisor bridge is not implemented in this change. Its contract:

1. Explicitly opt in to an adapter configured by the operator, not an agent-
   supplied command or repository path. Discovery has deadlines, bounded
   output, and provider/session/project identifiers with observed timestamps.
2. List states and attention reasons, distinguish heuristic `waiting` from
   provider-confirmed approval requests, and expose only recent context for
   the selected session. Do not import every transcript into long-term memory.
3. Bind each reply/delegation to one exact session and project. Keep provider
   writer locks intact; never turn an ambiguous project name into fan-out.
   Send message text over stdin or an authenticated transport, not command-line
   arguments. Do not resume a session merely to inspect it.
4. Route permission requests into OpenAGI's durable approval queue. Show the
   target, proposed action, expected cost, and risk. Untrusted transcript text
   cannot approve itself, change the routing policy, or escalate permissions.
5. Send deduplicated transition notifications to the desktop and G2. Persist
   delivery state, reconcile after disconnect, and require verified completion
   rather than treating a queued send as success.
6. Choose model/provider effort within declared capability and cost limits;
   intelligence selection must never change approval requirements.

Acceptance requires fixture tests for stale sessions, ambiguous IDs, writer
conflicts, timeouts, duplicate notifications, and approval expiry; then a live
round trip for each provider through G2 and desktop, with the operator choosing
the test session. A successful CLI status scan is not that round trip.

## Computer use

OpenAGI already contains a signed native helper, session leases, approvals,
screenshots, coordinate input, semantic Accessibility actions, and a Cua Driver
adapter. Readiness must report the selected executor's *measured* operations;
the enabled toggle is not proof of control. Capture and input permissions are
different. Secure Input can block typing even with both permissions granted.

Use the native helper for the existing path; evaluate Cua as an optional backend
against the same contract, not as a substitute for approvals or verification.
The upstream [Cua Driver documentation](https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md)
describes background app control and replayable trajectories. Pin and validate
the selected driver version before relying on those capabilities.

Acceptance: approve one session on an unlocked test machine, capture a fresh
frame, perform click/type/scroll/drag and semantic actions where advertised,
verify the rendered result after each action, then prove Stop prevents further
input. Repeat over a node relay, including offline/locked/Secure Input cases.
Do not disable macOS security protections automatically.

## Mail and calendar

The existing calendar integration reads ICS feeds; it does not manage events.
The folder inbox watcher is not an email connector.

The catalog now includes the official Superhuman Mail OAuth MCP. According to
[Superhuman's documentation](https://help.superhuman.com/hc/en-us/articles/46005696690317-Superhuman-Mail-MCP-Server),
it supports email search, drafts, sending, availability, and event management;
it requires an eligible Mail plan, Ask AI, and its Chrome extension for sign-in.
An endpoint in the catalog is not a connected account or tested OAuth flow.

Acceptance: complete sign-in in OpenAGI, verify discovered tools, read a chosen
test message/event, create a test draft, and prove send/delete/event mutation
approval behavior. Keep drafts separate from sent messages. Verify disconnect
and token refresh. If using Google APIs directly instead, request only the
necessary scopes and complete the required public-app OAuth review.

## Memory, review, and outcomes

- Present tasks, drafts, clarifications, and skill suggestions separately.
  Large suggestion counts must not masquerade as overdue tasks.
- Suppress repetitive app-switching suggestions before they enter review;
  merge near-duplicate workflows and retain only actionable, grounded skills.
- Track recall usefulness, corrections, and tier pressure independently.
  Recall coverage alone is not accuracy, and zero exact duplicates does not
  establish semantic uniqueness.
- Distinguish user ratings, verified task results, and inferred housekeeping
  scores. Do not present a default inferred score as user satisfaction.
- Acceptance: compare a representative bounded sample before/after, preserve
  actionable user work, show why an item was retained or suppressed, and
  measure verified outcomes over subsequent use.
