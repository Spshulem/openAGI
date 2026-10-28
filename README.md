<p align="center">
  <img src="assets/logo.png" alt="OpenAGI" width="128" height="128" />
</p>

<h1 align="center">OpenAGI — an agent that keeps context and keeps working</h1>

Run a personal agent on a computer you control. Chat with it, teach it your
preferences, monitor coding agents, and connect your tools and devices. Add
screen observation or approved computer interaction when you need them.

**[Download for macOS](https://github.com/Spshulem/openAGI/releases/latest)** ·
**[Windows install](docs/INSTALL.md#windows-from-source-powershell)** ·
**[Linux / Raspberry Pi install](docs/INSTALL.md#linux-and-raspberry-pi)** ·
**[First-use guide](docs/GETTING_STARTED.md)** ·
**[Website](https://openagi.sh)**

## Pick your install

| Platform | Start here | Includes |
| --- | --- | --- |
| **macOS** | [Download the latest DMG](https://github.com/Spshulem/openAGI/releases/latest), drag to Applications, launch | Native menu bar app, bundled runtime, updates, optional screen capture and Computer Use |
| **Windows** | [Download source ZIP](https://github.com/Spshulem/openAGI/archive/refs/heads/main.zip), then [follow the PowerShell steps](docs/INSTALL.md#windows-from-source-powershell) | Browser dashboard and CLI; Node.js 22+ required for source installs |
| **Linux / Raspberry Pi** | [Install guide](docs/INSTALL.md#linux-and-raspberry-pi) or [download source archive](https://github.com/Spshulem/openAGI/archive/refs/heads/main.tar.gz) | Browser dashboard, persistent runtime, optional systemd service; Linux x64/arm64 Docker image |
| **iPhone / Android** | [Companion app and pairing](mobile/README.md) | Mobile source with tasks, chat, approvals, and supervisor views; no public store download linked |

The latest release currently has a Mac installer. Releases built with the new
portable-download workflow also attach Windows x64 and Linux x64/arm64 bundles
with Node included. See [download availability and launch instructions](docs/INSTALL.md#downloads).
Source ZIP/archive links above track `main`; each GitHub release also offers its
exact source under **Assets → Source code**.

## Your first five minutes

1. Install and open **http://127.0.0.1:43210/**. The Mac app opens setup for you.
2. Choose a cloud API, ChatGPT sign-in, a local model server, or Apple Intelligence
   on a compatible Mac or iPhone. Click **Continue**, then **Connect & verify**.
   Setup saves the model after a real response succeeds.
3. Save your dashboard access token and choose **Meet your agent**. Other
   integrations are optional.
4. Open **Get started**, choose a goal, and click **Try it in chat**. Read or
   edit the starter message, then press Send. The agent teaches one step at a
   time and helps you verify a small result.
5. Come back for another flow when you need it. Checklists mean you tried a
   flow; they do not automatically connect accounts or grant permissions.

For a source install with Node.js 22+:

```sh
git clone https://github.com/Spshulem/openAGI.git
cd openAGI
npm ci --ignore-scripts
npm run serve
```

Windows PowerShell users can use `npm.cmd ci --ignore-scripts` and
`npm.cmd run serve`. Source/portable users should relaunch after setup asks for
a restart. See [all install paths, Docker, updates, and troubleshooting](docs/INSTALL.md).

## What you can do

| Goal | Where to start | What to verify |
| --- | --- | --- |
| **Talk to one persistent agent** | Chat; connect only the integrations you need | The configured model answers and uses the tools actually connected |
| **Remember preferences and corrections** | Memory, then Skills | Ask it to remember a non-sensitive preference, recall it in another chat, and correct it |
| **Supervise a coding fleet** | [Supervisor / Fleet](#supervisor-keep-coding-work-moving); More → Coding Agents | Codex, Claude Code, Conductor and Antigravity sessions, open questions, PRs and verification evidence; begin in observe mode |
| **Talk to the Supervisor** | [Voice setup](docs/setup/fleet-supervisor.md#voice) on Mac, Android or Even G2 | Enable voice, start with a gesture, and confirm actions with the spoken approval code |
| **Learn from routines** | Optional Mac Capture, Computer History, Skills suggestions | Review captured context and suggested workflows before adopting them |
| **Watch a screen or take action** | More → Computer Use | A selected supported node, fresh readiness, required OS permissions, and your explicit session approval |
| **Connect several computers** | More → Nodes | Your main host, scoped pairing, fresh heartbeats, and each node's actual capabilities |
| **Connect an iPhone or Android phone** | [Pair a companion app](mobile/README.md) | The phone can reach the main host and perform the flow you need |
| **Use glasses or build onto hardware** | Connect glasses; [G2 guide](docs/setup/even-g2.md); Linux/arm64 runtime | Compatible client software, transport, and advertised capabilities |
| **Connect your inbox, calendar or an agent phone number** | [Channels → Connections](docs/setup/partner-and-integrations.md) | Connect your own accounts, approve contacts, and review email/calendar writes |
| **Extend the agent** | Skills and Integrations / MCP | Review the code, tools, accounts, and permissions you add |

**[Walk through these flows in chat →](docs/GETTING_STARTED.md)**

## Supervisor: keep coding work moving

Supervisor brings supported coding sessions into one view on the Mac, web
dashboard and paired phones. See what is running, waiting on CI, blocked, or
waiting for your decision, with the thread and PR behind each item. It reads
verification evidence rather than treating an agent's "done" as a passing check.

- **Keep approvals visible.** Review open questions, inspect the affected
  thread, and answer through a supported route or open the coding app.
- **Choose how work resumes.** Observe plans without sending, Propose asks
  you to send, and Auto sends bounded nudges after you explicitly enable it.
- **Ask by voice.** Mac, Android and Even G2 clients can use the configured
  voice service. Actions require a readback and your spoken approval code.
- **Diagnose and repair.** Fleet health metrics surface delivery failures,
  repeated nudges and other anomalies. With a configured coding worker, the
  self-fix runner can open, review and revise a bounded repair PR. You merge it.

Automatic scanning and voice require setup. Start in Observe; sending nudges,
using Computer Use and running repairs have their own controls. See the
[Supervisor guide](docs/setup/fleet-supervisor.md),
[voice setup](docs/setup/fleet-supervisor.md#voice) and
[self-fix setup](docs/setup/fleet-supervisor.md#self-fix-runner).

## Availability

This README describes the repository's current capabilities. Check the
[release assets](https://github.com/Spshulem/openAGI/releases/latest) for the
installers actually published. The latest Mac release is **v0.0.58**; newer
source includes iOS phone-agent/offline-workspace work, additional messaging
and Google integrations, and the latest provider, cost and approval fixes.
The mobile apps are source/QA builds; no public store release is linked here.
Windows/Linux portable downloads depend on a release publishing those assets.

## Why a persistent runtime helps

OpenAGI connects work across conversations. Its scrutiny loop evaluates incoming
signals, its tiered memory keeps and consolidates useful context, and bounded
specialists can handle recurring work. Corrections can update stored facts.
Scheduled prompts and enabled integrations let work happen between chats, while
reviewed skills make useful routines repeatable. The [whitepaper](WHITEPAPER.md)
and [architecture guide](docs/abi-architecture.md) explain the design.

These are capabilities to configure and verify, not a promise that installing
an app will make it autonomously learn or finish work. Useful results depend on
the model, inputs, connected tools, running host, and permissions you choose.

## Your data, devices, and control

State defaults to `~/.openagi` on the host (`%USERPROFILE%\.openagi` on Windows).
You choose the main computer, model, and integrations. Selected prompts, tool
results, and screen context may be sent to your configured provider and services;
local storage does not mean inference always stays on-device.

Observation, live computer control, coding-agent instructions, and automatic
nudging have separate setup and approval boundaries. Paired phones and glasses
reach the main over a network you configure; that host needs to be awake and
reachable. The iOS source also supports a phone-agent mode on compatible
devices. Optional iOS push alerts use a relay and Apple's notification service;
they do not make the main host available offline. An online device only
supports the capabilities it advertises.

The code is **source-available under [PolyForm Noncommercial 1.0.0](LICENSE)**.
You can inspect and build within its terms. It is not an OSI open-source license;
commercial use requires separate permission. We do not change the license or
claim universal hardware support.

## Guides

- [Install, downloads, updates, and troubleshooting](docs/INSTALL.md)
- [Guided first-use flows](docs/GETTING_STARTED.md)
- [Coding Agents](docs/setup/coding-supervisor.md) and [Fleet supervisor](docs/setup/fleet-supervisor.md)
- [Computer Use readiness](docs/setup/computer-use-readiness.md) and [optional backend](docs/setup/open-computer-use.md)
- [Mobile setup](mobile/README.md) and [mobile feature surface](mobile/FEATURES.md)
- [Even G2](docs/setup/even-g2.md), [remote channels](docs/setup/remote-channels.md), and [integrations](docs/setup/partner-and-integrations.md)
- [Architecture](docs/abi-architecture.md), [whitepaper](WHITEPAPER.md), and [release process](docs/RELEASE.md)

---

## What's wired

| Capability | Detail |
|------------|--------|
| **Chat UI** | `/` — sessions sidebar, message thread, tabs for Memory / Cron / Skills / MCP / Agents / Channels / Activity. SSE event stream so the UI updates live. |
| **Supervisor / Fleet** | `/fleet` and native Supervisor views — coding threads, owner questions, PR/check evidence and Observe / Propose / Auto modes. [Setup](docs/setup/fleet-supervisor.md). |
| **Supervisor voice** | Opt-in voice on Mac, Android and Even G2, with shared history, spoken-code approvals and a daily voice budget. [Setup](docs/setup/fleet-supervisor.md#voice). |
| **Diagnosis and repair PRs** | Fleet health metrics plus a configured self-fix worker that opens and reviews bounded repairs; owner merge remains separate. [Setup](docs/setup/fleet-supervisor.md#self-fix-runner). |
| **Tool-use loop** | When `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` is set, the agent uses tool calling with structured args. Default model: `gpt-5`. |
| **Internal tools** | `remember`, `recall`, `schedule_message`, `list_sessions`, `list_skills`, `run_skill`, `list_mcp_tools`, `run_mcp_tool`, `register_mcp_server`, `connect_mcp_server`, `disconnect_mcp_server`, `list_cron_jobs`, `cancel_cron_job`, `get_audit`, `get_budget`, `set_provider`, `retire_specialist`, `replay_skill`. |
| **Skills** | Drop a `SKILL.md` (frontmatter + body) under `.openagi/skills/<name>/` — it shows up as a first-class tool the agent can invoke. |
| **Auto-skill mining** | Pattern-miner checks hourly, detects repeatable action workflows across action/hour/day/week horizons, and proposes a skill in `.openagi/skills-suggested/` for one-click accept. A nightly deep pass revalidates longer trends. Session-miner does the same on chat history. |
| **Skill replay** | Action vocabulary (`open_app`, `keyboard_shortcut`, `applescript`, `shortcut`, `type`, `wait`, `say`, `browser`, ...) — Mac executor confirms first run with a modal, persists trust. |
| **MCP execution** | Register stdio or HTTP+OAuth MCP servers in `.openagi/mcp.json` (or via the UI). On connect, every tool the server advertises becomes a callable agent tool (`mcp_<server>_<tool>`). |
| **Cron prompts** | The agent can call `schedule_message({prompt, delaySeconds | intervalSeconds | dailyAt, channel, target})`. When the job fires, the daemon runs the prompt and routes the reply to the originating channel (Telegram, local). |
| **Telegram** | Webhook (`/channels/telegram/webhook`) or long polling (`TELEGRAM_POLLING=1`). |
| **Partner sharing** | `/connections` — dedicated Sendblue, Linq, Twilio, Telnyx or Surge number; approved contacts, Sendblue/Linq groups, isolated conversation memory. |
| **Gmail + Google Calendar** | `/connections` — Google OAuth, inbox search/read, approved drafts/sends and event creation. |
| **Pebble Index** | Signed multipart `/webhooks/pebble` — voice memos into memory and reminder tasks. |
| **On-demand subagents** | `run_subagent` — bounded read-only delegation; use existing scheduled prompts for daily routines. |
| **Capability QA** | `npm run qa:capabilities` — ten offline capability areas plus [live test prompts](qa/scenarios.json). |
| **Even Realities G2 node** | Enroll from the Nodes tab, speak through the glasses microphone, and read OpenAGI's answer on the display. G2 gets a constrained, revocable node credential; question audio is transcribed transiently and is not saved. [Setup guide](docs/setup/even-g2.md). |
| **Mobile apps (iOS + Android)** | Today, tasks, Inbox approvals, chat, Supervisor and task widgets. Paired mode reaches your main host; iOS source also includes phone-agent/offline workspace and optional encrypted push/Live Activity support. [`mobile/README.md`](mobile/README.md). |
| **Persistent state** | All under `.openagi/`: memory (JSONL audit + atomic snapshot), cron jobs, agent/session store, specialist workspaces, MCP logs. |

### Credits

The **Credits** dashboard tab shows today's LLM spend vs the daily cap (`OPENAGI_DAILY_USD_LIMIT`), totals broken down **by activity** (chat / autopilot / cron / overlay) and **by model**, a **30-day spend chart**, and a per-call **audit log** — each row records time, model, activity type, agent, cost, and tools called, so you can see exactly what cost credits and why.

Ask the agent in chat via the **`recall_spend`** tool ("why did I spend $4 today?") — it reads the same ledger.

Data is a local rolling 30-day ledger at `~/.openagi/budget/ledger.jsonl`. It stores cost + attribution only — **no message content**.

Daily and per-turn model spend limits bound long runs. OpenAI and Anthropic
also have an estimated input-token cap; requests that still exceed it after
trimming stop before the next provider call. Spend/input-limit stops retain
bounded, redacted progress so a continuation can see completed actions. Token
estimates, especially for images, are approximate; see `.env.example` for the
controls and review an uncertain external action before repeating it.

---

## Remote access (Telegram, tunneling)

Once the daemon is running locally, you can reach it from anywhere via Telegram by pairing it with a public tunnel.

> Full step-by-step including tunnel + auth + Telegram + launchd: [`docs/setup/remote-channels.md`](docs/setup/remote-channels.md). Quick version below.

### Tunnel

```bash
npm run tunnel    # cloudflared (preferred) or ngrok, auto-detected
```

### Telegram

Create a bot via [@BotFather](https://t.me/BotFather), drop the token in `~/.openagi/.env`:

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_POLLING=1               # or set up a webhook to /channels/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=...      # only if using webhooks
```

---

## Screen capture & pattern mining (macOS)

Off by default. To enable on the macOS native app:

1. Launch `OpenAGI.app`.
2. Click the menu-bar icon → **Capture** → **Enable capture**.
3. macOS prompts for **Screen Recording** + **Accessibility** permissions — grant once.
4. Click **Capture → Privacy settings…** to tune frequency, retention, app/regex exclusions, and disk budget.

Once running:
- Every ~30 seconds the Mac batches activity (window titles + frame OCR) and pushes to the daemon's `/observations` endpoint — `127.0.0.1:43210`, unless you deliberately point capture at another machine's daemon.
- Hourly, the **workflow miner** looks for repeated semantic action sequences—including two-step and same-app/window flows—and compares support across hours, days, and weeks. A deeper pass still runs nightly at 02:30 local time.
- Nearby window/OCR evidence grounds proposals so a sequence can become “sales call → contract → follow-up,” rather than merely “Zoom → Chrome → Mail.”
- Suggested skills land in `.openagi/skills-suggested/` and surface in the dashboard's **Skills → Suggested** section.
- Accept → writes a real `SKILL.md`. If the skill includes a `replay:` block, `replay_skill` invokes it (Mac shows a confirmation modal first run).

### What capture does with your screen

Worth reading before you grant Screen Recording. The pictures and the text pulled out of them are handled differently, and that difference is the whole story.

**The images stay here.** Frames are OCR'd on-device by Apple's Vision framework. Frames and thumbnails are written to `~/Library/Application Support/OpenAGI/capture/` and never leave the Mac — they are never uploaded and never sent to a model. The 30-second push to the daemon carries timestamp, app name, window title and OCR text only, with no image bytes ([`CaptureBridge.swift`](mac/Sources/OpenAGI/Capture/CaptureBridge.swift)). **Delete all captured data** in the privacy panel wipes the local copy; the daemon's copy is cleared separately.

**The text goes to your model provider.** OCR text and window titles are what the agent reasons over, so excerpts of them are placed in prompts sent to whichever provider you configured (OpenAI, Anthropic, a local model — your choice, and a local one keeps this on your machine too):

| When | What is sent |
|---|---|
| Every chat turn you send | Up to 6 OCR snippets (≤280 chars each) from the last 10 minutes, each labelled with its app **and window title** (`src/agent-host.js`) |
| Quick Ask (⌥Space) | The OCR text of the window you're looking at, plus its title |
| Proactive observer — every 10 min, unattended | Up to 8 OCR snippets from the last 15 minutes (`src/proactive-observer.js`) |
| Mid-horizon observer — daily 17:30, unattended | Up to 20 OCR snippets across a 7-day lookback |
| Task activity scan — every 15 min, unattended | Up to 10 OCR snippets from the last 30 minutes |
| Workflow miner — hourly + nightly | Up to 6 OCR excerpts (200 chars each) around a detected routine, when it drafts a skill |
| Whenever the agent calls `recall_activity` | The matching rows from your capture log — window titles + OCR snippets |

The unattended rows run on a cron whether or not you're in a conversation. If that's more than you want: capture is off until you turn it on, **Pause** stops it, and pointing OpenAGI at a local model keeps the text on your machine.

**What the exclusion list can and can't do.** It is two lists you can read and edit in **Capture → Privacy settings…**: app bundle IDs, and regexes matched against window titles. Every window on the display is checked against both, case-insensitively, and a matching window is cut out of the picture before the screenshot is taken — so a password manager open beside the document you're working on isn't captured either. A listed bundle ID also covers that app's helpers (`com.1password` covers `com.1password.browser-helper`). Defaults cover password managers and vaults, secure messengers (Messages, Signal, WhatsApp, Telegram), Keychain Access, Apple Passwords and Wallet, and system password prompts; the title rules cover private/incognito windows, passwords and passkeys, 2FA / OTP / authenticator screens, recovery phrases, API keys, card numbers and online banking. Add your own for anything else you care about.

What it can't do is see a **URL** — nothing in OpenAGI reads a browser's address bar, so exclusion is by app and window title only. Your bank's site is recognised only if its window title happens to say so (the default rules do match "online banking"); a tab titled "Chase — Accounts" matches nothing, and a rule of your own is the only thing that would catch it. Two things worth knowing about how this fails: it fails **closed** — if the window list can't be read, or title rules are configured and not one on-screen window has a readable title, that capture is skipped entirely and the panel tells you why, rather than capturing something it couldn't check. And **Accessibility** permission is what supplies window titles for the activity log; the capture decision reads titles from the window list, so exclusions keep working without it.

Privacy posture:
- No keystroke logging, no audio, no camera — screenshots, app focus, and window titles only
- Off by default; one-click pause and one-click wipe in the privacy panel
- Frames and thumbnails never leave the Mac; OCR text and window titles go to the daemon and, in excerpts, to your model provider (table above)
- The exclusion list is yours to inspect and edit, applies per window before the screenshot is taken, and fails closed when the screen can't be evaluated

---

## Floating widget — Quick Ask

Press **⌥Space** (or click the tray icon → **Quick Ask**) to summon a small always-on-top pill that expands into an ask box over any app.

**Screen context.** On each ask, the widget does an on-device OCR grab of the focused window using the same ScreenCaptureKit pipeline as the pattern miner. Your [capture exclusion list](#what-capture-does-with-your-screen) applies first: if the front app's bundle ID or its window title matches, the widget grabs nothing and the panel shows "no screen context". Matching is by bundle ID and window title only — there's no URL awareness, so a banking page in a browser tab isn't recognised as one. The OCR'd **text** is sent to your model provider along with your question and the window's title; the screenshot itself is not. Requires **Screen Recording** permission; without it, the ask still works but the panel shows "no screen context."

**Proactive nudges.** Suggestions from the agent's scrutiny layer surface as a badge on the pill. Open the nudge list to send it to chat or dismiss it.

**Toggle.** Enable or disable the whole feature from the tray via **Enable Quick Ask** (on by default).

---

## MCP servers

Drop a config at `.openagi/mcp.json`:

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "trustLevel": "trusted"
    },
    "my-hosted": {
      "url": "https://mcp.example.com/mcp",
      "auth": "oauth",
      "trustLevel": "trusted"
    }
  }
}
```

Three transport+auth shapes are supported: **stdio** (spawn local process), **http+bearer** (URL with static API key), **http+oauth** (URL with browser-based OAuth — supports both dynamic registration and pre-registered clients).

For the bearer shape, reference your secrets via `~/.openagi/.env` only — `${VAR}` substitution is allowlisted to keys defined in that file (closes the env-var exfiltration class). Restart the daemon and click **Connect** in the MCP tab — or:

```bash
curl -s -X POST http://127.0.0.1:43210/mcp/connect/filesystem \
  -H "authorization: Bearer $OPENAGI_AUTH_TOKEN"
```

On connect, each MCP tool becomes a first-class agent tool (`mcp_filesystem_read_file`, etc.) and the model can call it directly. HTTP request deadlines cover response bodies, including streaming responses; disconnecting cancels pending body reads. Streaming replies accept LF, CRLF, and CR line endings, including line endings split across transport chunks. Matching streaming tool errors are returned immediately and completed response streams are released.

---

## Skills

Skills are markdown templates the agent can run as sub-prompts. Three are bundled (`recap`, `morning-brief`, `remind`). Add your own at `.openagi/skills/<name>/SKILL.md`:

```markdown
---
name: weekly-review
description: Summarize the past 7 days of memory and propose 3 follow-ups.
replay:
  - say: "Running your weekly review."
  - applescript: |
      tell application "Calendar" to activate
---

You are running a weekly review.

1. Call `recall` with query "this week" to pull recent items.
2. Group by tag, summarize each cluster in one bullet.
3. Propose three follow-ups the user should schedule.

User asked: {{input}}
```

The skill becomes the `skill_weekly_review` tool and is also runnable from the UI's **Skills** tab. The `replay:` block (optional) makes it executable on the Mac via `replay_skill` with a confirmation modal.

### Agent-authored report workflows

OpenAGI can create a reusable skill from a normal conversation. Ask it to design the workflow, name it, and save it; the approval-gated `create_skill` tool writes the resulting instructions under `.openagi/skills/` and reloads the registry immediately. The saved skill can use any connected MCP tools and can be scheduled later with `schedule_message`.

For example, a user can ask:

> Create a reusable weekly product report. Gather evidence from my connected analytics and project tools, compose a printable HTML report, save it as PDF with Playwright, and upload it to my connected document destination. Mark missing sources instead of failing the whole run. Show me the skill before saving it.

This is intentionally not a bundled report template. The user's prompt defines the sources, layout, failure policy, delivery target, and cadence. Connect Playwright from the catalog for generic HTML-to-PDF output and reMarkable when that is the desired destination; another skill can use different source and delivery MCPs without changing OpenAGI.

---

## Integrations

Integrations are plug-in modules in `src/integrations/<name>.js`. Each one self-registers tools when its credentials are present in env, and silently no-ops otherwise. **No keys live in source.**

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

Then add one line to `src/abi-runtime.js`: `registerYourIntegration(this);`

For SaaS that ships an MCP server, you don't need an integration module — just point `.openagi/mcp.json` at it and the agent gets every tool automatically.

---

## Auth & security

When `OPENAGI_AUTH_TOKEN` is unset, the dashboard runs unauthenticated (fine for `127.0.0.1` only). When set, every route except `/health` and the webhook endpoints requires:

- header `Authorization: Bearer <token>`, or
- a `?token=<token>` query (browser convenience — sets a cookie, then redirects), or
- the `openagi_token` cookie.

Generate a strong token:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Webhooks self-validate instead:

- **Sendblue / Pebble:** receive webhooks fail closed without their configured secret/signature. Partner contacts and groups require owner approval; partner memories and tools are isolated. See [Connections setup](docs/setup/partner-and-integrations.md).
- **Telegram:** set `TELEGRAM_WEBHOOK_SECRET` and pass the same value as `secret_token` to `setWebhook` — the daemon checks the `X-Telegram-Bot-Api-Secret-Token` header.

Additional defenses:

- **Cross-origin POST blocked** — any browser request whose `Origin` doesn't match `Host` is rejected with 403, regardless of auth state.
- **MCP register hardening** — `command` is allowlisted to known runners (`npx`, `node`, `bun`, `deno`, `python3`, `uvx`, `docker`); URL hosts may not be loopback / RFC1918 / link-local / cloud-metadata; `${VAR}` substitution is allowlisted to keys explicitly declared in `~/.openagi/.env`.

---

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
| POST   | `/skills/replay/:name`            | Replay a skill on the Mac              |
| GET    | `/mcp`, `/mcp/tools`              | MCP server + tool inventory            |
| POST   | `/mcp/register`                   | Register a server at runtime           |
| POST   | `/mcp/connect/:name`              | Spawn the server, fetch tools          |
| POST   | `/mcp/disconnect/:name`           | Kill it                                |
| POST   | `/mcp/call`                       | `{server, tool, args}`                 |
| POST   | `/observations`                   | Activity batch from Mac capture        |
| GET    | `/observations/search`            | Full-text search of observed activity  |
| POST   | `/channels/sendblue/webhook`      | Approved partner iMessage / SMS         |
| POST   | `/channels/linq/webhook`          | Signed Linq V3 partner text             |
| POST   | `/channels/twilio/webhook`        | Signed form-encoded partner SMS         |
| POST   | `/channels/telnyx/webhook`        | Signed Telnyx partner text              |
| POST   | `/channels/surge/webhook`         | Signed Surge partner text               |
| POST   | `/channels/telegram/webhook`      | Telegram inbound                       |
| POST   | `/webhooks/pebble`                | Signed Index 01 voice-memo ingestion    |
| POST   | `/tick`                           | Manually run due cron jobs             |

---

## Environment

See `.env.example`. All keys read from `.env` and `~/.openagi/.env` (override the location with `OPENAGI_DATA_DIR`).

### Model tiering

You set **one base model** for everything (`OPENAI_MODEL` / `ANTHROPIC_MODEL`). You do **not** need a top model for every internal job — the small, frequent background work (proactive observation, scrutiny judging, memory condensing, session mining, daily recaps) runs fine on a cheaper `mini`/`nano` model, which is where most of the spend hides. Tiering is **opt-in**: until you set a tier, every task stays on the base model.

Run `openagi models` to see the plan — which job runs on which model, why each is safe to shrink, and exactly what to set to start saving.

| Variable | What it does |
|---|---|
| `OPENAI_MODEL` / `ANTHROPIC_MODEL` | Base model — handles chat + autopilot (real reasoning). Default `gpt-5` / `claude-sonnet-4-6`. |
| `OPENAI_MODEL_MINI` / `ANTHROPIC_MODEL_MINI` | Mini tier — memory condensing, session mining, daily recap. e.g. `gpt-5-mini`. |
| `OPENAI_MODEL_NANO` / `ANTHROPIC_MODEL_NANO` | Nano tier — proactive observer, scrutiny judges (short, very frequent). e.g. `gpt-5-nano`. |
| `OPENAI_MODEL_TASK_<JOB>` | Pin one job to an exact model (wins over its tier). Jobs: `OBSERVER`, `SCRUTINY`, `CONDENSE`, `MINE`, `PLAN`, `CHAT`, `AUTOPILOT`. |
| `OPENAI_REASONING_EFFORT_TASK_<JOB>` | Reasoning effort for one job (wins over `OPENAI_REASONING_EFFORT`). e.g. `OPENAI_REASONING_EFFORT_TASK_CHAT=high`. |

Recommended starting point for OpenAI: `OPENAI_MODEL=gpt-5`, `OPENAI_MODEL_MINI=gpt-5-mini`, `OPENAI_MODEL_NANO=gpt-5-nano`. The ledger records the **actual** model each call used, so `openagi status` / `/budget` show where the money really goes.

### Workflow-learning cadence

`OPENAGI_PATTERN_MINE_INTERVAL_MIN` controls the fast activity-workflow pass (default `60`, minimum `15`). Statistical detection is local and deterministic; the model is called only for a new workflow that clears the confidence threshold. The nightly pass remains enabled for longer day/week recalculation.

### Web search

The agent gains two tools — `web_search` and `fetch_url` — once at least one provider key is set. With no key configured, `web_search` returns a clear "no provider configured" error and `fetch_url` still works via a plain HTTP fetch.

| Variable | Provider |
|---|---|
| `EXA_API_KEY` | [Exa](https://exa.ai) (default first choice) |
| `TAVILY_API_KEY` | [Tavily](https://tavily.com) |
| `BRAVE_API_KEY` | [Brave Search](https://brave.com/search/api/) |
| `SERPAPI_API_KEY` | [SerpApi](https://serpapi.com) |
| `FIRECRAWL_API_KEY` | [Firecrawl](https://firecrawl.dev) |
| `PERPLEXITY_API_KEY` | [Perplexity](https://www.perplexity.ai/api) |
| `GOOGLE_API_KEY` + `GOOGLE_CSE_ID` | Google Custom Search (alternative to the above) |

`WEB_SEARCH_PROVIDER` — optional. Force a specific provider (`exa`, `tavily`, `firecrawl`, `brave`, `perplexity`, or `serpapi`). When unset the agent auto-selects the first configured provider in priority order `exa → tavily → brave → serpapi → firecrawl → perplexity`, falling back to the next on error.

### BuildBetter

Set `BUILDBETTER_API_KEY`, `BUILDBETTER_USER_EMAIL`, and `BUILDBETTER_USER_NAME` to enable the BuildBetter integration.

`BUILDBETTER_INGEST_MODE` controls what the integration ingests:

| Value | Behavior |
|---|---|
| `signals` _(default)_ | Action items from calls become agent tasks |
| `transcripts` | Call transcripts are stored as searchable memory (queryable via `recall_activity`) |
| `both` | Both of the above |

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
  auth.js                     bearer/cookie auth + CSRF (cross-origin POST guard)
  channels.js                 local + Telegram + Sendblue partner channels
  cron-scheduler.js           interval/dailyAt jobs (incl. the "prompt" job type)
  directional-adaptive-scrutiny.js  decision layer
  hosted-interface.js         HTTP server, SSE, chat UI
  mcp-client.js               stdio JSON-RPC MCP transport
  mcp-http-client.js          HTTP+bearer MCP transport
  mcp-oauth.js                HTTP+OAuth MCP transport (DCR + pre-registered)
  mcp-registry.js             config + live clients, tool exposure
  memory-system.js            short/medium/long tiers with decay
  model-provider.js           DeterministicModelProvider + OpenAI / Anthropic tool loops
  observation-store.js        SQLite FTS5 store for capture observations
  activity-patterns.js        semantic action sequences + multi-horizon cadence
  pattern-miner.js            ground repeating workflows → propose skills
  session-miner.js            cluster repeating chat intents → propose skills
  propagation-controller.js   bounded specialist creation
  skills.js                   SKILL.md loader, exposes each skill as a tool
  skill-replay.js             replay parser + executor + trust persistence
  tool-registry.js            internal tools the agent can call
mac/Sources/OpenAGI/
  AppDelegate.swift           menubar lifecycle
  TrayController.swift        menu bar icon + status
  DaemonController.swift      Node bundle launcher + crash recovery
  AppState.swift              SSE client + dashboard window
  Capture/                    ScreenCaptureKit + Vision OCR pipeline
  Replay/                     SSE-driven action executor + confirmation modal
examples/
  hosted-server.js            entrypoint for `npm run serve`
  abi-demo.js                 deterministic ABI signal demo
  skills/                     bundled starter skills
test/
  abi-runtime.test.js
```

---

## Development direction

See [the architecture](docs/abi-architecture.md), the setup guides above, and
current issues/PRs for implementation work. Older scope documents describe plans
at the time they were written; use a release's assets and a verified setup flow
to establish what is available on your platform today.

---

## License

**PolyForm Noncommercial License 1.0.0** — see [LICENSE](LICENSE).

You can use, fork, run, and modify OpenAGI freely for personal, research, hobby, educational, government, and other noncommercial purposes. Commercial use (including using OpenAGI as part of a paid product or revenue-generating service) requires a separate license — open an issue or reach out if you want one.

---

## Optional phone calls

Connect your own Vocaleo account from **Integrations → Vocaleo** using your phone
number and an SMS code, or an existing API key. OpenAGI can then make approved
calls and retrieve their results. See [Vocaleo setup](docs/vocaleo.md) for details.

[openagi.sh](https://openagi.sh) · [Issues](https://github.com/Spshulem/openAGI/issues) · [Docs](https://github.com/Spshulem/openAGI/tree/main/docs)

### Memory correction scopes

Shared `main` memories can be recalled by specialists. Corrections supersede
only memories in the caller's own scope: a specialist can retain a local
correction without hiding the shared fact from other agents. An explicit ID
outside the caller's scope is rejected before any memory is changed or target
content is returned. Query corrections rank only same-scope candidates, so
shared matches cannot crowd out a specialist's own facts. Legacy memories
without a scope belong to `main` for corrections.

Tier promotion preserves memory IDs, so saved references, correction links, and
derived-principle lineage remain valid across promotion and restart. This protects
future promotions; it does not reconstruct links lost by earlier versions.

Nightly condensation excludes superseded facts from both model input and principle
lineage. If a source is corrected or removed while distillation is running, the
result is discarded; queued groups are rechecked before model dispatch as well.
Correcting a source also supersedes its existing same-scope derived principles,
removes their vectors, and releases surviving source notes for later condensation
when the replacement correction is in an input tier. Direct principle corrections
remain in long-term memory; their source notes stay consumed so a later run cannot
recreate the obsolete conclusion without its correction. Vector deletion also
cancels pending embedding writes, preventing retired principles from reappearing
in semantic novelty measurements. These changes persist across restart.
Historical rows remain available for audit;
principles from an earlier version are invalidated when their source is corrected,
without a bulk rewrite of existing data.

No bulk migration runs automatically, and previously superseded memories are
not restored.

The iMessage self-chat importer opens the Messages SQLite database strictly read-only,
with a bounded lock wait. It reads committed WAL messages without checkpointing or
creating the source database. Cursor checkpoints stay in OpenAGI's own data directory.

The self-chat task importer supports both plain `text` and modern Messages
`attributedBody` text, using the same decoder as the conversation bridge. Plain
text takes precedence. Unreadable bodies and attachment-only rows advance the
cursor without creating empty tasks; other chats remain excluded. First enable
remains forward-only unless backfill is explicitly configured.
