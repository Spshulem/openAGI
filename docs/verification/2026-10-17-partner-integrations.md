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
