# OpenAGI

An always-on local agent host with a real chat UI, scheduled prompts, MCP tool execution, skills, and SMS/Telegram channels — built on a directional-adaptive-scrutiny + tiered-memory + propagation core.

OpenAGI takes the daemon-first, channel-first, persistent shape of OpenClaw / PicoClaw / TinyAGI and pairs it with an opinionated decision layer:

```text
Channels -> Signals -> Workflows -> Directional Adaptive Scrutiny
-> Agent Layer + Tools -> Multi-Tiered Memory -> Propagation
-> Outputs -> Feedback
```

## Quick start

```bash
npm install      # no deps yet (Node 22+)
cp .env.example .openagi/.env   # paste your keys
npm run serve    # http://127.0.0.1:43210
```

Open the dashboard, send a message, or:

```bash
curl -s http://127.0.0.1:43210/message \
  -H 'content-type: application/json' \
  -d '{"text":"remind me in 60 seconds to drink water","from":"me"}'
```

The daemon ticks every 10s by default (`OPENAGI_TICKER_MS`) so scheduled prompts fire on time without external pokes.

## What's wired

- **Chat UI on `/`** — sessions sidebar, message thread, tabs for Memory / Cron / Skills / MCP / Agents / Channels. SSE event stream so the UI updates live.
- **Tool-use loop** — when `OPENAI_API_KEY` is set, the agent uses the Responses API with `tools` and structured args. Default model: `gpt-5`.
- **Internal tools** — `remember`, `recall`, `schedule_message`, `list_sessions`, `list_skills`, `run_skill`, `list_mcp_tools`, `run_mcp_tool`.
- **Skills** — drop a `SKILL.md` (frontmatter + body) under `.openagi/skills/<name>/` and it shows up as a first-class tool the agent can invoke.
- **MCP execution** — register stdio MCP servers in `.openagi/mcp.json` (or via the UI). On connect, every tool the server advertises becomes a callable agent tool (`mcp_<server>_<tool>`).
- **Cron prompts that ping you back** — the agent can call `schedule_message({prompt, delaySeconds | intervalSeconds | dailyAt, channel, target})`. When the job fires, the daemon runs the prompt through the agent and routes the reply to the originating channel (SMS via Twilio, Telegram, or local).
- **SMS bidirectional** — Twilio inbound webhook → agent reply via TwiML. Twilio outbound REST for proactive sends and scheduled-prompt fires.
- **Telegram** — webhook (`/channels/telegram/webhook`) or long polling (`TELEGRAM_POLLING=1`).
- **Persistent state** under `.openagi/`: memory (JSONL audit + atomic snapshot), cron jobs, agent/session store, specialist workspaces, MCP logs.

## Twilio bidirectional SMS

> Full step-by-step including tunnel + auth + Telegram + launchd: [`docs/setup/remote-channels.md`](docs/setup/remote-channels.md). Quick version below.

You'll need a Twilio account, a phone number, and a public URL for the webhook. Spin one up with:

```bash
npm run tunnel    # cloudflared (preferred) or ngrok, auto-detected
```

1. Drop credentials into `.openagi/.env`:
    ```bash
    TWILIO_ACCOUNT_SID=AC...
    TWILIO_AUTH_TOKEN=...
    TWILIO_FROM_NUMBER=+15551234567
    ```
2. Tunnel a public URL: `ngrok http 43210` → copy `https://abcd1234.ngrok-free.app`.
3. In the Twilio console for your number, set the **A MESSAGE COMES IN** webhook to:
    ```
    https://abcd1234.ngrok-free.app/channels/twilio/webhook
    ```
4. Text your number. The reply comes back as TwiML.
5. To test outbound: from the dashboard's **Channels** tab, send a test SMS, or:
    ```bash
    curl -s http://127.0.0.1:43210/channels/sms/send \
      -H 'content-type: application/json' \
      -d '{"to":"+15555550123","text":"Hi from OpenAGI"}'
    ```
6. Schedule an SMS ping:
    ```bash
    curl -s http://127.0.0.1:43210/cron \
      -H 'content-type: application/json' \
      -d '{"name":"morning-nudge","prompt":"Write me a one-line motivational sentence.","dailyAt":"08:00","channel":"sms","target":"+15555550123"}'
    ```

## MCP servers

Drop a config at `.openagi/mcp.json`:

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "trustLevel": "trusted"
    }
  }
}
```

Restart the daemon and click **Connect** in the MCP tab — or:

```bash
curl -s -X POST http://127.0.0.1:43210/mcp/connect/filesystem
```

On connect, each MCP tool becomes a first-class agent tool (`mcp_filesystem_read_file`, etc.) and the model can call it directly.

## Integrations

Integrations are plug-in modules in `src/integrations/<name>.js`. Each one self-registers tools on the runtime when its credentials are present in env, and silently no-ops otherwise. **No keys live in source.**

Bundled:

| Integration | Env | Tools | Use |
|---|---|---|---|
| Rize.io (time tracking) | `RIZE_API_KEY` | `rize_query`, `rize_today_summary`, `rize_recent_sessions` | "What did I work on today?" |

To add another (e.g. Toggl, Linear, GitHub via API), copy `src/integrations/rize.js` as a template:

```js
export function registerYourIntegration(runtime, options = {}) {
  const client = options.client ?? new YourClient(options);
  if (!client.isConfigured()) return { registered: false, reason: "API key not set" };
  runtime.tools.register({ name: "your_tool", parameters: {...}, handler: async (args) => client.something(args) });
  return { registered: true };
}
```

Then add one line to `src/abi-runtime.js` constructor: `registerYourIntegration(this);`

For SaaS that ships an MCP server, you don't need an integration module — just point at it from `.openagi/mcp.json` and the agent gets every tool automatically.

## Skills

Skills are markdown templates the agent can run as sub-prompts. Three are bundled (`recap`, `morning-brief`, `remind`). Add your own at `.openagi/skills/<name>/SKILL.md`:

```markdown
---
name: weekly-review
description: Summarize the past 7 days of memory and propose 3 follow-ups.
---

You are running a weekly review.

1. Call `recall` with query "this week" to pull recent items.
2. Group by tag, summarize each cluster in one bullet.
3. Propose three follow-ups the user should schedule.

User asked: {{input}}
```

The skill becomes the `skill_weekly_review` tool and is also runnable from the UI's Skills tab.

## Auth

When `OPENAGI_AUTH_TOKEN` is unset, the dashboard is open (fine for `127.0.0.1` only). When set, every route except `/health`, `/channels/twilio/webhook`, and `/channels/telegram/webhook` requires:

- header `Authorization: Bearer <token>`, or
- a `?token=<token>` query (browser convenience — sets a cookie, then redirects), or
- the `openagi_token` cookie.

Generate a strong token:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Webhooks self-validate instead:

- **Twilio:** when `TWILIO_AUTH_TOKEN` and `OPENAGI_PUBLIC_URL` are set, the daemon verifies the `X-Twilio-Signature` HMAC against the incoming form body.
- **Telegram:** set `TELEGRAM_WEBHOOK_SECRET` and pass the same value as `secret_token` to `setWebhook` — the daemon checks the `X-Telegram-Bot-Api-Secret-Token` header.

## Run as a daemon (macOS)

```bash
./scripts/install-launchd.sh             # installs ~/Library/LaunchAgents/app.openagi.daemon.plist and starts it
./scripts/install-launchd.sh uninstall   # stop + remove
tail -f .openagi/launchd.err.log         # watch
```

The launch agent runs at login, restarts on crash (10s throttle), and uses your project's `.openagi/.env`.

## Endpoints

| Method | Path                              | Notes                                  |
| ------ | --------------------------------- | -------------------------------------- |
| GET    | `/`                               | Chat UI                                |
| GET    | `/health`                         | Runtime status                         |
| GET    | `/events`                         | SSE event stream                       |
| POST   | `/message`                        | Local channel message                  |
| GET    | `/sessions`, `/sessions/:id`      | Conversation transcripts               |
| GET    | `/memory`                         | Tiered memory snapshot                 |
| POST   | `/cron`                           | Create a job                           |
| DELETE | `/cron/:id`                       | Remove a job                           |
| POST   | `/cron/:id/run`                   | Run a job now                          |
| GET    | `/skills`                         | List skills                            |
| POST   | `/skills/reload`                  | Re-scan skill directories              |
| POST   | `/skills/:name/run`               | Run a skill                            |
| GET    | `/mcp`, `/mcp/tools`              | MCP server + tool inventory            |
| POST   | `/mcp/register`                   | Register a server at runtime           |
| POST   | `/mcp/connect/:name`              | Spawn the server, fetch tools          |
| POST   | `/mcp/disconnect/:name`           | Kill it                                |
| POST   | `/mcp/call`                       | `{server, tool, args}`                 |
| POST   | `/channels/twilio/webhook`        | Twilio inbound SMS                     |
| POST   | `/channels/telegram/webhook`      | Telegram inbound                       |
| POST   | `/channels/sms/send`              | Twilio outbound (`{to, text}`)         |
| POST   | `/tick`                           | Manually run due cron jobs             |

## Environment

See `.env.example`. All keys read from `.env` and `.openagi/.env`.

## Tests

```bash
npm test
```

## Project layout

```
src/
  abi-runtime.js              orchestrates signals → scrutiny → memory → propagation
  agent-host.js               turn loop, threads tool registry into model provider
  agent-store.js              persistent agents and sessions
  channels.js                 local + Telegram + Twilio (SMS) channels
  cron-scheduler.js           interval/dailyAt jobs (incl. the "prompt" job type)
  directional-adaptive-scrutiny.js  decision layer
  file-backed-*.js            durable JSONL+snapshot stores
  hosted-interface.js         HTTP server, SSE, chat UI
  mcp-client.js               stdio JSON-RPC MCP transport
  mcp-registry.js             config + live clients, tool exposure
  memory-system.js            short/medium/long tiers with decay
  model-provider.js           DeterministicModelProvider + OpenAI Responses tool loop
  propagation-controller.js   bounded specialist creation
  skills.js                   SKILL.md loader, exposes each skill as a tool
  tool-registry.js            internal tools the agent can call
examples/
  hosted-server.js            entrypoint for `npm run serve`
  abi-demo.js                 deterministic ABI signal demo
  skills/                     bundled starter skills
test/
  abi-runtime.test.js
```

## Roadmap

- Auth/pairing for remote access (currently `127.0.0.1` only).
- HTTP / SSE MCP transport (stdio is in).
- Specialist routing — when a message matches a specialist's bounded scope, route to it instead of always `main`.
- Embeddings-backed memory search alongside the current keyword overlap.
- Per-channel delivery policies and retry queues.

## License

MIT.
