# Fleet supervisor

Watches every recent Codex, Claude Code, and Conductor coding thread on this Mac.
Judges each PR from GitHub and BuildBot3, not from the agent's "done".
Nudges stuck threads with your own wording. Asks you only for real decisions.

- Page: `/fleet` on the local daemon (phone-sized, same login as the dashboard).
  Also linked as **Fleet** in the dashboard header.
- Sections: **Needs you** (questions with buttons), **Doing** (nudges planned,
  proposed, sent), **Infra** (BuildBot3 gate, queue, oldest run, codex-lb,
  laptop verify), **Fleet** (every thread by state).
- Needs-you questions also land in the local outreach feed.

## Try it

1. Dry run from a terminal. Reads only, sends nothing:

   ```sh
   ~/.nvm/versions/node/v22.21.1/bin/node scripts/fleet-scan.mjs
   ```

   Add `--json` for raw output. `--no-bb3` / `--no-github` skip those probes.

2. See the page on a throwaway dev server. Spare port, temp data dir, so the real
   `~/.openagi` is untouched:

   ```sh
   PORT=43311 OPENAGI_DATA_DIR="$(mktemp -d)" \
     ~/.nvm/versions/node/v22.21.1/bin/node examples/hosted-server.js
   ```

   Open http://127.0.0.1:43311/fleet and tap **Scan now**.
   The supervisor still reads the real `~/.codex`, `~/.claude`, and Conductor DB
   (read-only). Mode starts as `observe`.

3. Turn it on in the app daemon. Add to `~/.openagi/.env`, then restart OpenAGI:

   ```sh
   OPENAGI_FLEET_SUPERVISOR=1
   OPENAGI_FLEET_MODE=observe   # or propose / auto
   ```

   Without `OPENAGI_FLEET_SUPERVISOR=1` there is no timer, but the page and
   **Scan now** still work.

## Modes

| Mode | Does |
|---|---|
| `observe` (default) | Classifies and plans. Sends nothing. Plans show as **Planned**. |
| `propose` | Plans show as **Proposed** with a **Send** button. You tap to send. |
| `auto` | Sends in-scope templated nudges itself, up to 4 per scan. |

Switch on the page (Auto asks to confirm) or with `OPENAGI_FLEET_MODE`.
The page choice is saved and wins over the env value.
Questions reach you in every mode. Your answer to an agent's own question is
sent to that thread in every mode, when a route exists.

## Env vars

| Var | Default | Means |
|---|---|---|
| `OPENAGI_FLEET_SUPERVISOR` | off | `1` starts the timer |
| `OPENAGI_FLEET_MODE` | `observe` | `observe`, `propose`, `auto` |
| `OPENAGI_FLEET_PUSH` | off | `buzzkit` pushes needs-you items to the phone (uses `~/.claude/buzz/endpoint`). Quiet 22:00-08:00, max 3/hour |
| `OPENAGI_FLEET_LOOKBACK_HOURS` | `48` | Threads active this recently are in scope |
| `OPENAGI_FLEET_TICK_MS` | `300000` | Time between scans (5 min) |
| `OPENAGI_FLEET_BB3_HOST` | `dev@100.99.3.113` | BuildBot3 SSH target (read-only probe, never docker) |
| `OPENAGI_FLEET_LB_URL` | `http://100.99.3.113:2455` | codex-lb base URL; `/health` is checked |
| `OPENAGI_FLEET_BB3_MANAGER` | Remote dev setup session | Conductor session id or workspace name that gets BuildBot3 / LB escalations |
| `OPENAGI_FLEET_RELAY_MODEL` | `claude-haiku-4-5-20251001` | Model for the `claude -p` relay to live Claude/Conductor sessions |

`OPENAGI_PUBLIC_URL`, when set, makes phone pushes deep-link to `/fleet?q=<id>`.

## Change the wording

Nudge text lives in playbook files. Bundled copies:
`examples/skills/fleet-supervisor/playbooks/<id>.md`.

Override one without a code change: copy it to
`<dataDir>/skills/fleet-supervisor/playbooks/<id>.md` (usually
`~/.openagi/skills/fleet-supervisor/playbooks/`) and edit. Same `id` wins.

Ids: `resume`, `merge-ready`, `ci-finished`, `no-local-verify`, `in-scope-yes`,
`bb3-slow-agent`, `infra-recovered`, `manager-bb3`, `manager-lb`.
Frontmatter: `cooldown_min`, `max_attempts`, `ask` (question to you after max attempts).

## Safety limits

- Read-only everywhere except sending templated text to a thread.
- Every message starts with `[OpenAGI supervisor]` and is journaled.
- 15 min idle before a nudge. 12 min between nudges to one thread.
- 3 nudges without progress (no new head, no thread resolved), then it asks you.
- Max 4 sends per scan. Never nudges a thread you typed into in the last 10 min.
- Never nudges its own session. Never resends `continue` before a limit resets.
- One manager escalation per incident per hour.
- Never kills processes, merges PRs, changes permissions, or answers out-of-scope questions.
- Agent text is untrusted: shown as plain text, never forwarded to other agents.

## Known gaps

- Non-live Conductor sessions: no delivery route yet. You get "open it" after 90 min stuck.
- Codex threads held open by Codex Desktop (writer lock): blocked. Close the thread in Desktop, or send by hand.
- Not mirrored to the Distiller main: Mac banners and G2 do not show fleet questions yet.
  The data lives only on this Mac's daemon.
