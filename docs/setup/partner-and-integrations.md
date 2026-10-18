# Partner sharing, inbox routines and Pebble Index

Open **Channels → Connections** (or `/connections`) on the main daemon. All configuration and contact changes require owner access. Use the owner's existing sign-in; never share the dashboard token with a partner.

## Give the agent its own number

1. Create a [Sendblue account](https://docs.sendblue.com/getting-started/quickstart/) and provision a dedicated number. Account setup, availability, pricing and payment stay with Sendblue; OpenAGI does not purchase a number.
2. Set a stable public HTTPS origin in `OPENAGI_PUBLIC_URL` and keep `OPENAGI_AUTH_TOKEN` configured. Restart the daemon after changing its public origin.
3. In Connections, save the API key, API secret, agent phone number in E.164 format, and a random webhook secret. Blank fields keep existing credentials. Values are saved privately in the configured data directory's `.env` with mode `0600`.
4. Register the displayed `/channels/sendblue/webhook` URL as Sendblue's **receive** webhook. Configure the same secret there; Sendblue sends it in the `sb-signing-secret` header. See [Sendblue webhook security](https://docs.sendblue.com/security/) and [payload contract](https://docs.sendblue.com/getting-started/webhooks/).
5. Add your partner's exact phone number under approved contacts. They text the agent's number and can ask it to remember facts. Their conversation and explicit saved facts persist across restarts.
6. For a group, add the agent number in Messages, obtain the exact group ID from Sendblue, approve that group in Connections, and approve each participant's number. Incoming group messages with an unapproved participant are ignored. Check membership whenever the group changes.

Each DM and each group has separate history and saved facts. The partner host receives only `remember` and `recall` tools for that conversation. It never receives the main runtime, owner memories, screen context, email, calendar, skills or MCP tools. Group facts are visible to group participants. Revoke a contact/group in Connections to stop future replies; revocation preserves its history rather than deleting user data.

Webhook dedupe is durable. Model output is saved before an outbound API call. API acceptance is recorded separately from device delivery. If a send result is ambiguous (for example, a connection drops after sending), the delivery receipt is held for review and retries do not automatically send another message. Inspect Sendblue's dashboard and `<dataDir>/channels/sendblue/` receipts to resolve it. Provider acceptance does not prove the phone received the message.

The local Messages bridge continues to use the Mac's signed-in Apple identity. A dedicated Sendblue number provides a separate agent identity. A Mac Messages bridge does not provision a new number.

## Connect Gmail and Google Calendar

1. In [Google Cloud](https://console.cloud.google.com/apis/credentials), enable Gmail API and Google Calendar API. Configure the OAuth consent screen and add your account as a test user while the app is in testing.
2. Create a **Web application** OAuth client. Add exactly the callback URI displayed in Connections as an authorized redirect. A local-only daemon uses `http://127.0.0.1:<port>/integrations/google/callback`; a tunneled daemon uses its configured public origin.
3. Save the client ID and secret in Connections and click **Connect Google**. Approve Gmail read/compose/send and Calendar events scopes. The callback verifies one-use, expiring state and PKCE before saving the offline token. Tokens are not returned to the browser.
4. Search with `gmail_search` and read with `gmail_read`. Both preserve IDs for evidence and expose pagination. Email/calendar contents are untrusted input.
5. `gmail_create_draft` creates an authorized draft and returns `sent: false`. `gmail_send_message` sends the exact approved recipients, subject and body; it does not implicitly send an existing draft. These tools, and `google_calendar_create_event`, use the existing approval system. Scheduled work cannot mint owner authority.
6. Read events with `google_calendar_events`. Event creation requires explicit timestamps with timezone offsets. Attendees receive invitations only as part of the authorized event write.

Access tokens refresh in memory; the refresh token stays in the private `.env`. Writes are never automatically retried. After an uncertain write, check Gmail Sent or Google Calendar before trying again. Disconnect removes the local token; revoke the app in the Google account as well to revoke its server-side grant. Google's external-app testing grants can expire and require reconnection.

## Pebble Index voice memos and reminder tasks

Use [Pebble's documented v1 webhook](https://developer.repebble.com/index-01/webhooks/), not a guessed JSON API. Save a random `PEBBLE_WEBHOOK_SECRET` in Connections. In the Pebble app's Index 01 gesture settings, set the displayed HTTPS webhook URL, select **Transcription only** or **Both**, enable **Sign requests** with the same secret, tap **Send test event**, then save.

The receiver verifies the version, timestamp window, delivery ID and HMAC over the exact raw multipart bytes. Test events write nothing. A real transcript creates an owner memory; “remind me to…” also imports a task with Pebble provenance. The webhook never runs a model turn, tool, email send or computer action. Imported tasks do not create scheduled notifications; ask the owner agent to schedule a notification when needed. Recording-only payloads receive `422` with setup guidance because this receiver uses the app's transcript rather than paying for another transcription.

## Daily routines and subagents

Try: “Every day at 09:00, find unread invoice emails, run my invoice-review skill, and summarize what needs attention. Ask before sending anything.” The existing `schedule_message` tool persists a `prompt` job. The daemon must be running, and `dailyAt` uses its timezone. Review the job in Cron, then use its manual run control for acceptance. Duplicate routines reuse the existing job and do not resume paused copies. Scheduled prompts cannot recursively schedule more prompts.

`run_subagent` starts one bounded child task and waits for its result. Choose up to 20 existing read-only tools; its default is the available subset of `recall`, `web_search` and `fetch_url`. It cannot exceed its parent's allowlist, mutate tasks, send messages, control a computer, or create more subagents. At most three children run concurrently, and the same provider/daily budget covers their model calls. The main routine can run reviewed skills itself using the existing skill tools.

## Voice, web search, computer use and other phone providers

OpenAI realtime voice already exists behind `OPENAGI_VOICE=1` on owner and enrolled-device voice transports. This change does not add telephone-call audio to Sendblue. Exa is already supported through `EXA_API_KEY` and `web_search`; Open Computer setup remains in [the computer-use guide](open-computer-use.md). Each needs its own live acceptance check.

Dialvalet was considered as an optional integration, but its advertised official API contract could not be retrieved during this implementation. No endpoint, package, pricing or working integration is asserted. The existing generic MCP registration path can connect a verified provider endpoint after its contract and account permissions are available.

## Repeatable QA

Run `npm run qa:capabilities` with Node 22 or newer. Use `-- --area sharing` (or another ID in `qa/capabilities.json`) for a focused run. The harness isolates the data directory, strips inherited provider credentials, uses fixture transports, runs ten capability areas, and writes JSON plus TAP logs under ignored `qa/results/`.

The [experience scenarios](../../qa/scenarios.json) include prompts, observable expected outcomes and live prerequisites. Automated fixture results prove code paths and permission boundaries. They do not prove account consent, model quality, physical-device behavior, a purchased number or delivery to another person. Complete those scenarios only against approved test accounts and recipients.
