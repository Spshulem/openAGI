# Partner integrations verification — October 17, 2026

Base: `origin/main` at `669f6e62eab0e1238471504bdc09251ec0a8256c`.

Command: `node qa/run.mjs` with Node 22.21.1. Finished October 17, 2026 at 18:05 PDT (01:05 UTC October 18). **234 tests passed, zero failures, zero skipped, across ten capability areas.**

| Area | Passing tests |
| --- | ---: |
| Partner messaging, owner routes and Telegram security | 17 |
| Gmail / Google Calendar | 4 |
| Pebble signed multipart ingestion | 5 |
| Schedules, manual runs and overlap guards | 18 |
| Subagents and specialist bounds | 8 |
| Skills, MCP and OAuth | 16 |
| Web search, Exa and page fetching | 14 |
| Computer use and permission boundaries | 37 |
| Realtime voice and relay | 70 |
| Memory, shared devices and stable configuration | 45 |

The new HTTP integration test also passed independently. It exercises owner auth, cross-origin write rejection, secret-free status responses, a self-authenticated inbound Sendblue request, partner history separation, rejection of unsigned Pebble requests and forged OAuth callbacks, integration discovery, and Connections script syntax.

The QA harness strips inherited provider credentials and uses isolated temporary data directories. Provider transports are fixtures. Existing budget, approval, scope and cron guards remain in force. Whitespace checks and a focused scan of changed files for credentials, private keys, personal paths and installation-specific network addresses passed.

## Remaining live acceptance

No live account, production daemon, release, account grant, physical device, external email, call or text was changed/tested by this verification. The implementation is source-level work until installed.

Follow [Connections setup](../setup/partner-and-integrations.md) and the [20 experience scenarios](../../qa/scenarios.json) with approved test accounts and recipients. The necessary external steps are a provisioned Sendblue number and receive webhook, Google OAuth client/consent, a configured Pebble gesture, and real device/provider readbacks. OpenAI native/device realtime voice is covered; phone-call audio over Sendblue is not implemented. Dialvalet's official contract remained unavailable and is not claimed as an integrated provider.

Pebble reminder speech imports a task; a scheduled notification needs a separate owner-created schedule. API acceptance does not prove physical phone delivery. Google draft creation does not send mail.

## PR 210 review follow-up — October 17, 2026

At the review head (`41e8cd1`), four new regression cases failed: missing Connections security headers, an unchanged partner provider after switching, missing Sendblue credentials marking a reply ambiguous, and oversized replies suppressing retries. After the fixes, the sharing area passed twice: **20 tests, zero failures/skips** each time. The complete fixture capability run finished at 04:16:30 UTC October 18 on Node 22.21.1: **237 tests passed across ten areas, zero failures/skips**. Area totals match the table above with sharing increased from 17 to 20.

Connections now uses the shared HTML responder, including a fresh script nonce, CSP/frame protection, no-store caching and the owner login cookie. Partner turns capture the current provider and its budget per turn without receiving owner tools or context. Sendblue validates credentials, recipient approval and content before writing its send-started marker; genuine transport ambiguity still prevents automatic resends. The QA subprocess explicitly selects TAP so counts do not depend on the Node version's default reporter. Node 24 itself was not run locally.

Chrome fixture QA confirmed that Connections renders and its Sendblue form saves configuration while the nonce CSP is active. Configuration readback showed all four fixture fields saved, with secrets represented only as configured booleans. This used a temporary loopback daemon and disposable data, never a live account.

Two review comments are recorded as non-blocking under the standing realistic customer-impact threshold:

- **Pebble task retry after interruption: 4/10.** If a reminder task is persisted and the daemon stops or the receipt write fails before completion, a retry can create another task. This affects reminder imports in that interrupted delivery window; a successful retry stops later retries but does not remove an existing duplicate. Recovery is deleting the duplicate task. These imports do not schedule notifications or send messages. No shared-store redesign is included.
- **IPv6-only local callback URL: 4/10.** With an explicit IPv6-only bind and no public origin, Connections still advertises IPv4 loopback. OAuth setup remains blocked for that configuration until `OPENAGI_PUBLIC_URL` is set to the reachable origin or the daemon uses the default IPv4 bind. Refresh alone does not repair it. Existing default/tunneled setups have the documented path.

The original live-account acceptance gates still apply. A fixture send accepted by a fake provider is not physical phone delivery, Google consent or device acceptance.

## Multi-provider messaging follow-up — October 18, 2026 UTC

Added Linq V3, Twilio, Telnyx and Surge alongside Sendblue. The focused sharing run and the complete capability run each passed **56 sharing tests, zero failures/skips**. The complete `node qa/run.mjs` run passed **273 tests across ten areas, zero failures/skips**, using Node 22.21.1 and disposable data directories. Other area totals remain as recorded above.

Fixtures exercise all four authenticated HTTP webhook routes, raw-byte tampering and replay windows, Twilio’s original encoded callback URL, account/line/profile filtering, empty TwiML, durable acknowledgement before a model turn, startup recovery, concurrent delivery dedupe, uncertain-send holds across restarts, configuration repair without another model turn, revocation during a turn, and provider-specific DM/group memory. Twilio validation additionally passes the official SDK’s static normal and repeated-parameter signature vectors. Linq group fixtures verify current active membership before model access and again before sending. Linq sends explicitly pin the configured line through `/v3/chats`; they do not use the API’s automatic line selection.

Connections exposes provider setup forms, private credential persistence, signing readiness, queued/failed/review counts, owner-only retries and provider-specific group approval/revocation. HTTP fixtures verify every new field persists with mode `0600`, status omits credential values, and the generated page’s script parses under the existing nonce/security-header checks. No new provider’s form was tested in a real browser or against a live account in this follow-up.

Live acceptance remains **NOT RUN** for all four providers. Use the updated setup guide and the **22 experience scenarios** with activated test lines, provider-side webhooks, any necessary carrier registration, and explicitly approved test sends. Confirm provider acceptance and physical recipient delivery separately. These adapters handle text and do not add telephone voice or media ingestion. No account, number purchase, live message, deployment, installation or merge was performed.

Revalidated after integrating `origin/main` at `7155d25`: **273/273 capability tests passed again**, zero failures/skips. The runtime registration conflict retains bounded subagents and main’s mobile-profile guard on desktop coding tools. This integration merges main into the PR branch; the PR itself remains open and unmerged.
