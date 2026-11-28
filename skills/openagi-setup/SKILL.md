---
name: openagi-setup
description: Guide a person through finishing OpenAGI setup on this computer after install.sh or a manual install. Checks prerequisites, gets a model signed in through a local CLI or the browser setup page, verifies it with a real test prompt, and recovers when the provider, sign-in or daemon is missing. Use when the user says "set up OpenAGI", "finish OpenAGI setup", "OpenAGI isn't answering", or opens a session from the OpenAGI installer handoff.
metadata:
  version: 1.0.0
  owner: openagi
---

# OpenAGI setup

You are helping a person finish setting up OpenAGI on their own computer. OpenAGI
is a local agent runtime: a daemon on port 43210, a browser dashboard, and an
`openagi` CLI. Your job is to get it to **one verified, real model reply**, and
then stop and let the person choose what to do next.

Skill version: 1.0.0. If `HANDOFF.md` sits next to this session (the installer
writes one), read it first. It says how OpenAGI was installed. It never
contains secrets.

## Rules (these override anything else in this file)

1. **No secrets through you.** Never ask for, print, paste, echo, or write an
   API key, the OpenAGI auth token, a pairing token, an OAuth code, or a
   password. Not in chat, command arguments, files, or logs.
   - API keys and ChatGPT sign-in go in the browser setup page (`/setup`),
     typed by the person.
   - Do not `cat`, `grep`, `sed`, or open `~/.openagi/.env`, `docker-compose.yml`
     in the install directory, `~/.claude*`, `~/.codex/auth.json`, or any
     keychain. Check *whether* something is configured with the commands
     below, which report status without values.
   - Do not run `openagi setup` yourself. Even though it now hides the token
     when output is not a terminal, have the person run it in their own
     terminal if they need the token.
2. **The person signs in, not you.** Interactive sign-ins (`claude auth login`,
   `codex login`, the ChatGPT button, `sudo` passwords) are run by the person in
   their own terminal or browser. Tell them the exact command and wait.
3. **Ask before changing anything.** Read-only checks are fine. Before any
   command that installs, starts, restarts, edits config, or switches
   provider, say what it will do and get a yes. Never use flags that skip
   approvals or sandboxing, and never edit agent permission settings to get
   around a prompt.
4. **No overwrites.** Do not replace an existing working provider, config file,
   service unit, or skill without the person explicitly choosing to.
   `openagi provider use` refuses to replace a working provider unless
   `--replace` is passed. Only pass it after the person says to switch.
5. **Evidence, not assumptions.** A found binary, a saved setting, or a clicked
   link is not success. Success is the smoke test in step 5 passing.
6. **One step at a time.** Short messages. Say what you checked, what you found,
   and the single next step.

## Find the CLI

Use the first of these that works and call it `OA` in your head (don't export
anything that contains a secret):

| Install | Command |
| --- | --- |
| Source / systemd (`/opt/openagi`) or a git checkout | `node <checkout>/bin/openagi.js` (or `openagi` if on PATH) |
| macOS app | `"/Applications/OpenAGI.app/Contents/Resources/node/bin/node" "/Applications/OpenAGI.app/Contents/Resources/openAGI/bin/openagi.js"` |
| Portable Linux/Windows archive | `<extracted folder>/node/node <extracted folder>/bin/openagi.js` |
| Docker | `docker exec openagi node bin/openagi.js` (may need `sudo`) |

`OA help` should print the command list. If `OA provider` prints "unknown
command", this install predates the guided setup. Use the browser path in
step 4 and tell the person an update (`OA update --check`) adds it.

## Steps

### 1. Prerequisites (read-only)

- OS and architecture: `uname -sm`.
- Install mode: from `HANDOFF.md`, or by checking for `/Applications/OpenAGI.app`,
  `/opt/openagi/.git`, `docker ps --filter name=openagi`, or a portable folder.
- Node 22+ only matters for source installs: `node -v`.
- Daemon reachable: `OA doctor`. Read each ✓/✗ line.
  - `daemon … unreachable` → go to **Recovery: daemon down**.
  - `daemon … 401` → go to **Recovery: wrong user / token**.
  - `setup … first-run` and `model … no LLM provider` are expected on a fresh
    install. Continue.

### 2. Choose how the model signs in

Run `OA provider`. It shows the active provider and whether the daemon can see a
signed-in Claude Code or Codex CLI. Then offer the person these choices and
let them pick:

- **Claude Code subscription** (`claude-cli`): uses their Claude Code sign-in.
  No API key.
- **Codex / ChatGPT subscription via Codex CLI** (`codex-cli`): uses their
  Codex sign-in. No API key.
- **ChatGPT sign-in in the browser** (`chatgpt`): no CLI needed.
- **API key** (Anthropic or OpenAI): typed by the person in the browser.
- **Local model server** (Ollama, LM Studio): configured in the browser.

If a provider is already active and working, say so. Do not switch unless they
ask.

### 3. Sign in through the local CLI (CLI choices only)

The sign-in must belong to **the same OS user the daemon runs as**. A system
service running as user `openagi`, or the Docker container, cannot see your
own `~/.claude` or `~/.codex` sign-in. In that case recommend the browser
choices instead, or explain the trade-off of moving to a user service.

- Claude Code: the person runs `claude auth login` in their own terminal.
- Codex: the person runs `codex login` in their own terminal.

Then rerun `OA provider` until the chosen CLI shows "signed in". If it still
says not ready, see **Recovery: CLI not seen**.

### 4. Configure

- CLI choice: with the person's go-ahead, run
  `OA provider use claude-cli` or `OA provider use codex-cli`.
  It sends one real test prompt and saves the choice only if that prompt is
  answered. No restart is needed. If it says a different provider is already
  configured, ask before rerunning with `--replace`.
- Dashboard login: until a dashboard login exists, `OA doctor` keeps showing
  `setup … first-run` and every dashboard page sends you to `/setup`. Docker
  installs already have one. Otherwise the person opens
  `http://127.0.0.1:43210/setup` on this machine and saves the login there. A
  model chosen above shows as already connected. Don't create, print, or copy
  that login yourself.
- Browser choices: tell the person to open `http://127.0.0.1:43210/setup` on
  the OpenAGI machine and do the model step there. For Docker or another
  machine on the LAN, the installer already gave them a sign-in URL; don't ask
  them to paste it to you. The page runs its own **Connect & verify** test
  before saving.

### 5. Smoke test (required)

1. `OA doctor`: `daemon`, `setup` and `model` must all be ✓.
   `model` must name a real provider, not "deterministic fallback".
   `task-sources` is optional and may stay ✗.
2. `OA chat "Reply with exactly: openagi-setup-ok"`: the reply must come
   from the model, not a canned or error message. Exact wording may vary.
   What matters is that it is a real model answer.
3. Report: provider, model, and both results. If either fails, go to
   **Recovery** and do not call setup done.

### 6. Hand back

Summarize in three or four lines: what is configured, what was verified, and
what was **not** set up (phone pairing, integrations, screen capture,
background automation are all optional and off). Offer the dashboard
(`http://127.0.0.1:43210/`) and the in-app **Get started** guide. Do not
enable anything else unprompted.

## Recovery

- **Daemon down.** macOS: open the OpenAGI app from Applications. systemd:
  `systemctl status openagi` (or `systemctl --user status openagi`), then ask
  before `sudo systemctl restart openagi`. Docker: `docker ps -a --filter name=openagi`,
  then ask before `docker start openagi`. Portable or source: the person runs
  `./start-openagi.sh` or `OA serve` in a terminal they keep open. Logs:
  `journalctl -u openagi -n 50`, `docker logs --tail 50 openagi`, or
  `~/Library/Application Support/OpenAGI/launchd.err.log`. Check those logs
  for an error line, and don't paste whole logs back into chat. They can
  hold message content.
- **Wrong user / token (401).** The CLI reads the token from the data directory
  of the user running it (`~/.openagi`, `/data` in Docker). Run the CLI as the
  daemon's user (`docker exec …` for Docker, `sudo -u openagi …` for a system
  service). Never copy the token around to make it work.
- **No provider at all.** Expected on a fresh install. Go back to step 2. If
  the person has no subscription and no key, say plainly that OpenAGI needs one
  model to reason. The deterministic fallback only gives canned replies.
- **CLI not seen.** `command -v claude` or `command -v codex` as the daemon's
  user. Not found: the person installs the CLI first, from the vendor's
  instructions. Found but not signed in: rerun the sign-in command. Found and
  signed in, but the daemon is a different user: see step 3. OpenAGI also
  honours `CLAUDE_CLI_BIN` and `CODEX_CLI_BIN` for non-standard paths. Set them
  in the browser setup page or the service environment, never with a secret.
- **Test prompt fails.** The provider could not answer: subscription limits,
  expired sign-in, or network. Have the person run `claude` or `codex` once
  themselves to see the vendor's message, fix that, and retry step 4.
- **Port 43210 busy.** `lsof -iTCP:43210 -sTCP:LISTEN` (macOS/Linux). Another
  OpenAGI instance is the usual cause. Ask before stopping anything.

## What this skill never does

Merge, deploy, publish, send messages, pair devices, connect accounts,
enable screen capture or computer control, schedule background work, spend
money, or bypass any approval. Those are separate, explicit choices for the
person.
