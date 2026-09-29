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
| `OPENAGI_FLEET_DELIVERY` | `cli` | `cli`, `computer-use`, `computer-use-first`. See [Computer-use delivery](#computer-use-delivery) |
| `OPENAGI_FLEET_OCU_PATH` | `open-computer-use` on `PATH` | Open Computer Use binary for computer-use delivery |
| `OPENAGI_FLEET_REVIEW` | on with the supervisor | `0` turns off the [review of the needs-you list](#the-supervisor-reviews-its-own-list) |
| `OPENAGI_FLEET_REVIEW_MODEL` | `claude-sonnet-5` | Model for that review (owner-confirmed) |
| `OPENAGI_FLEET_REVIEW_MS` | `1800000` | Re-review an unchanged open question after this long (30 min), backing off to 4x while nothing changes |

`OPENAGI_PUBLIC_URL`, when set, makes phone pushes deep-link to `/fleet?q=<id>`.

## Change the wording

Nudge text lives in playbook files. Bundled copies:
`examples/skills/fleet-supervisor/playbooks/<id>.md`.

Override one without a code change: copy it to
`<dataDir>/skills/fleet-supervisor/playbooks/<id>.md` (usually
`~/.openagi/skills/fleet-supervisor/playbooks/`) and edit. Same `id` wins.

Ids: `resume`, `merge-ready`, `ci-finished`, `no-local-verify`, `in-scope-yes`,
`bb3-slow-agent`, `infra-recovered`, `manager-bb3`, `manager-lb`, `account-switched`.
Frontmatter: `cooldown_min`, `max_attempts`, `ask` (question to you after max attempts),
`restart_apps` (`account-switched` only: `conductor` and/or `codex`).

## Your workspace, kept out of this repo

Anything specific to your machine belongs in `~/.openagi/skills/fleet-supervisor/`,
not in this public repo. The supervisor reads two things there:

- `playbooks/<id>.md`: your copies of the playbooks above.
- `SKILL.md`: notes about your setup, in plain words. The self-review reads
  them as your instructions (the first 4,000 characters).

After you answer **added** on a "threads capped" question, the supervisor sends
`account-switched` to each capped thread. If your copy sets `restart_apps`, it first
restarts that app in the background, since some apps only pick up a new account at
launch. It won't restart while you are using the app or while another chat there is
running, and it restarts at most once every 10 minutes. Example:

```markdown
---
id: account-switched
restart_apps: conductor
---
retry
```

To keep these files in version control, make `~/.openagi/skills` its own private git repo.

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

## Phone app

The OpenAGI phone app's **Supervisor** tab shows the same fleet: threads by
colour, needs-you questions with buttons, mode, and **Scan now**.

- Colour is `threads[].health` in the snapshot. Red: `needs-human`,
  `infra-blocked`, or any thread with an error that is not running. Yellow: `pr-not-ready`,
  `idle-no-pr`, `ready-needs-human`. Green: `running`, `waiting-ci`,
  `local-verify`, `asked-in-scope`, `done`. Gray: `excluded` or unknown.
- The paired phone credential (`mobile-fleet-client`) may call only
  `GET /fleet/api/state`, `POST /fleet/api/scan`, `POST /fleet/api/mode`,
  `POST /fleet/api/questions/:id`, and `POST /fleet/api/actions/:id/send`.
  The `/fleet` page and every other route stay owner-only.
- Supervisor chat uses the normal chat route with two read-only tools:
  `fleet_status` (mode, counts, open questions, threads red first) and
  `fleet_thread` (one thread's row, decision, PR, and questions). They read the
  last scan only; they never scan, send, answer, or change the mode.

## Computer-use delivery

Types each supervisor message into the app that shows the thread, then presses
Send. No `codex exec` and no `claude -p`. Covers nudges, owner answers,
**retry**, grouped **added** resumes, and manager escalations.

| `OPENAGI_FLEET_DELIVERY` | Does |
|---|---|
| `cli` (default) | The CLI routes above. Nothing changes. |
| `computer-use` | App UI only, never a CLI. Not ready: the send waits. No app shows the thread (plain terminal `claude`): the usual "open it?" question. |
| `computer-use-first` | App UI when ready, otherwise the CLI routes. |

Which app:

- Conductor sessions: `conductor://workspace?id=<workspace>&session=<session>`.
- Codex threads: the Codex app, `codex://threads/<id>` (never `?prompt=`).
- Codex threads Conductor started (`originator=codex_sdk_ts`): their Conductor
  tab. No Conductor row: no route.

Setup on the coding Mac:

1. `npm install -g open-computer-use` (0.3.5 on the owner's Mac). The fleet runs the
   bundled `Open Computer Use.app` engine through its app agent, so macOS checks
   that app's permissions, not the daemon's node.
2. Grant **Open Computer Use** Accessibility and Screen Recording in System
   Settings > Privacy & Security. `open-computer-use doctor` shows both.
3. Keep `OPENAGI_COMPUTER_USE=1`. Turning it off in the dashboard stops
   computer-use delivery too.
4. Check what a delivery would see, read-only (no clicks, no typing):

   ```sh
   open-computer-use snapshot com.conductor.app | node scripts/fleet-ui-probe.mjs --expect <workspace>
   ```

   It should find one composer, the Send button, and the open workspace.
5. Add `OPENAGI_FLEET_DELIVERY=computer-use` to `~/.openagi/.env`, start with
   `OPENAGI_FLEET_MODE=propose`, and restart OpenAGI. Set
   `OPENAGI_FLEET_OCU_PATH` if the launchd `PATH` cannot find the binary.

Each send, in order. Any failed check stops before typing:

- Ready: permissions granted, screen unlocked, secure input off, no OpenAGI
  computer-use session running.
- The app is already running (never launched) and you are not using it: it is
  frontmost and you touched the keyboard or mouse in the last 2 min means
  "owner using <App>".
- Opens the thread. While you are away it opens the deep link with `open -g`.
  While you are active it only uses background accessibility clicks.
- Proves the right thread is open: workspace name, plus the tab title when the
  workspace has more than one tab (Codex: thread title). Shared or missing
  names block as "ambiguous".
- Blocks on a running turn (Stop visible) or a permission prompt.
- The composer must be empty. A draft is never overwritten.
- Types the message as one line (newlines become spaces), checks the composer
  holds exactly that text, checks the thread again, then clicks Send (or
  Return).
- Confirms the message shows in the thread within 8 s. Otherwise the result is
  **failed** and *unconfirmed*: check the thread before retrying.

Safety rules:

- One app delivery at a time. 10 s per UI step, 45 s per delivery.
- Only Conductor (`com.conductor.app`) and the Codex app (`com.openai.codex`).
  No clipboard, no paste, no app launch, no pointer moves.
- Text typed before a failed check is cleared only when it is provably ours.
- Before and after screenshots go to `<dataDir>/fleet/logs/ui/` (0600, newest
  200 kept). Their paths are on the action record.
- Blocked means nothing was typed: no attempt spent, retried next scan.


- Non-live Conductor sessions: no CLI delivery route. You get "open it" after
  90 min stuck, unless computer-use delivery is on.
- Codex threads held open by Codex Desktop (writer lock): blocked on the CLI
  route. Close the thread in Desktop, send by hand, or use computer-use delivery.
- Computer-use delivery reads the apps' accessibility trees. An app update can
  change them; a thread it cannot verify is blocked, never guessed.
- Main mirroring requires an explicitly selected enrolled coding Mac; without
  `OPENAGI_FLEET_NODE`, Fleet remains local to that daemon.

## Question delivery

Structured Codex questions keep their original choices (up to four labels of
40 characters). Free-text or multiple prompts offer **open thread** so you can
answer in Codex. Failed or unreachable deliveries stay open for another attempt.
Account-cap recovery remembers successful deliveries when part of a group is
unreachable, so retrying the group does not resend to those threads.

Switching away from **Propose** invalidates pending Send buttons. The scan CLI
copies persisted state into a temporary directory when given `--data-dir`; it
never writes the daemon's state or sends messages.

## The supervisor reviews its own list

The supervisor manages its own needs-you list. After each scan, one batched
`claude -p` call (structured output, no tools, no hooks, not saved as a
session) reads the open questions that are new, changed, or due, up to 15,
each with its thread, PR, the agent message it came from, and related
threads (same PR, workspace, or repo). The other open questions are listed
briefly so duplicates still show. It closes what no longer needs you:

- an optional offer ("want me to X?") that blocks nothing,
- an ask about a PR that shipped (work after the merge, like a release or
  staging QA, still counts), or a thread that moved on,
- work another thread did, or a call you already made elsewhere,
- status lines, automation relays, and duplicates of a question about the
  same thread (two threads asking the same thing each need their answer).

When unsure it keeps the question. An agent's own question it keeps may get
a clearer title (repo #PR plus the ask) and short answers the agent can act
on; the same outreach item updates in place. The supervisor's own questions
(ready, stuck, limits) keep their title and buttons.

- New questions are reviewed before they reach the phone, glasses, or main,
  so junk never pings.
- It runs right away for a new question, and at most every 10 minutes when a
  question's thread or PR changed or it is due: `OPENAGI_FLEET_REVIEW_MS`
  after its last review, then 2x and 4x that while nothing changes. The
  longest-unreviewed go first; a new question past the 15 waits (unseen)
  for the next review.
- At most a quarter of a batch (3 at least) closes per review; the rest wait
  for the next one. A close needs a reason.
- A closed question stays closed while the same ask repeats, for up to 6
  hours. Then the same ask is a new question, reviewed again before it pings.
  A changed ask is a new question.
- If the model fails or times out (6 min), questions go out as before and the
  error shows in **Doing**. It retries after 15 minutes.
- Every decision is in **Doing** (`review`). **Cleared by supervisor** under
  **Needs you** lists every close asked in the last day, one per ask, with
  category, reason and time; **Reopen** brings one back as
  the same item and pins it, so the review keeps it until its ask changes.
  An open question shows the review's reason under it. API:
  `POST /fleet/api/questions/<id>` with `{ "reopen": true }`.
- It runs in every mode. It only edits the supervisor's own list; it never
  messages a thread.

The default model is `claude-sonnet-5`, confirmed by the owner on 2026-09-29. On
26 hand-audited questions it agreed with the audit on 20, versus 17 for Haiku 4.5.
Set `OPENAGI_FLEET_REVIEW_MODEL` to use another model.

## One supervisor shared by main, Android and G2

Run the scanner on the coding Mac with `OPENAGI_FLEET_SUPERVISOR=1` and
`OPENAGI_FLEET_MODE=observe`. Its existing enrolled-node connection advertises
the `fleet-supervisor` capability. On main set `OPENAGI_FLEET_NODE` to that
Mac's node id and restart. Main then forwards Fleet requests over the authenticated
node-control channel and mirrors open questions into its outreach feed.

The Android **Supervisor** tab reads main's Fleet API with the existing phone
pairing. Existing Agents G2 clients can show mirrored questions in their
proactive inbox when Approvals notifications are enabled; this requires the
backend update, not a glasses firmware update. Answering remains on the phone
or main dashboard. Offline Macs retain their last snapshot with an unavailable
status; no successful delivery is inferred from cached data.
