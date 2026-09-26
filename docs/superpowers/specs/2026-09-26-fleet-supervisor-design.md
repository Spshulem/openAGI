# Fleet Supervisor — design

**Date:** 2026-09-26
**Status:** Prototype scope. Written and built overnight under the owner's standing authorization; decisions marked **(D#)** are defaults the owner can flip.
**Topic:** One supervisor that watches every coding-agent thread (Codex, Claude Code, Conductor), keeps each one moving until its PR is truly merge-ready, and only pings the owner when a human is actually needed.

## Problem

The owner runs 20–60 coding threads at once. Mining 1,729 of their messages from the last 7–14 days:

- 15% are pure keep-going nudges (`continue` was sent 106 times).
- 29% restate the same fixed policy to every PR agent: resolve PR comments ≥6/10, get CI green on the exact head, merge main, run bb-quick on BuildBot3 (not locally), QA on the BuildBot3 preview.
- 8% approve an in-scope step the agent should not have asked about.
- 58 "sweeps" in 14 days: the same few strings pasted into 5–21 sessions within 20 minutes.
- 59% of pure nudges follow a turn the agent ended to wait on CI or bb-verify. Nothing wakes it.
- Agents claim "done" while CI is red on the exact head or review threads are open.
- Infra stalls look like idle: Claude session/model limits, Codex load-balancer outages (`503 No available accounts`, `Connection failed`), BuildBot3 overload (gate blocked, 10+ full verifies queued, 90-minute runs).

About 40–45% of what the owner types is automatable. The rest is real decisions.

## Goals

1. See every recent coding thread in one place with its true state: running, waiting on CI/BuildBot3, idle with work left, blocked on infra, blocked on a human.
2. Judge merge-readiness from GitHub and BuildBot3, never from the agent's own claim.
3. Push threads forward with the owner's own wording, from editable playbook files.
4. Watch BuildBot3: slow verifies (>30 min), a blocked gate, dead timers, and agents running heavy verification locally. Escalate to the BuildBot3 manager agent first, the owner last.
5. Watch the Codex load balancer. When it recovers, resume the threads that stalled during the outage.
6. A tiny "needs you" queue: caveman questions (≤100-char title, one question, buttons), optionally pushed to the phone.
7. A mini app at `/fleet` in the local OpenAGI daemon, usable from the phone over the tailnet.

## Non-goals (v1)

- No LLM in the decision loop. Classification and policy are deterministic rules; the only model call is the existing `claude -p` SendMessage relay used to reach live Claude/Conductor sessions (D4).
- No killing processes, changing provider permission modes, switching accounts, or merging PRs. Those stay with the owner or the agent.
- No Distiller main / G2 / Mac-banner mirroring. The data lives on this Mac; main mirroring is a follow-up (see Topology).
- No new npm dependencies.

## Decisions (defaults the owner can flip)

| # | Decision | Default | Flip with |
|---|---|---|---|
| D1 | Where it runs | Local Mac OpenAGI daemon (the only place that can read `~/.codex`, `~/.claude`, the Conductor DB, `ps`, `gh`, BuildBot3 SSH) | follow-up: node capability for main |
| D2 | Autonomy | `observe`: classify + plan, send nothing | `OPENAGI_FLEET_MODE=propose` (one-tap send) or `auto` (send templated in-scope nudges automatically), or the page toggle |
| D3 | Phone ping | Off | `OPENAGI_FLEET_PUSH=buzzkit` (uses the already-paired `~/.claude/buzz/endpoint`). Quiet hours 22:00–08:00 local, ≤3 pings/hour, needs-you items only |
| D4 | Models | None in the loop. Relay to live Claude/Conductor peers uses `claude -p --model claude-haiku-4-5-20251001` (same as the g2 relay) | `OPENAGI_FLEET_RELAY_MODEL` |
| D5 | BuildBot3 manager | Conductor session `0056f770-…` "Remote dev setup" (workspace `remote-dev`), reached when live | `OPENAGI_FLEET_BB3_MANAGER` (session id or workspace name) |
| D6 | Scope | Threads active in the last 48 h that have a git repo and a branch or PR. Excludes subagents, automations, sidechains, relay dirs, the supervisor itself | `OPENAGI_FLEET_LOOKBACK_HOURS` |
| D7 | Enabled | Off until `OPENAGI_FLEET_SUPERVISOR=1`. The `/fleet` page and a manual "Scan now" work regardless | env |

## Topology

```
this Mac (OpenAGI daemon, 127.0.0.1:43210, tailnet :8443)
  FleetSupervisor.tick()  every 5 min (+ "Scan now")
    sources ─► ~/.codex (state_5.sqlite, rollouts, logs_2.sqlite, writer locks)
            ─► ~/.claude/projects/*.jsonl, ~/.claude/sessions/*.json (live peers)
            ─► Conductor conductor.db (read-only)
            ─► gh api graphql (one batched query per tick)
            ─► ssh dev@BuildBot3 (ps, queues, gate-status.json; never docker)
            ─► codex-lb /health, ~/.bb3-watch-state, ~/Library/Logs/lb-watch.log
            ─► local ps (heavy local verification detector)
    classify ─► policy ─► playbooks (SKILL.md + playbooks/*.md)
    executor ─► codex exec resume | claude -p SendMessage relay | claude -p --resume
    needs-you ─► FleetStore questions ─► /fleet page, outreach feed, BuzzKit
```

## Units

| Unit | File | Purpose | Depends on |
|---|---|---|---|
| Contracts | `src/fleet/contracts.js` | Shared shapes, constants, `runCommand`, text clamps | — |
| Codex source | `src/fleet/sources/codex.js` | Threads from `state_5.sqlite` + rollout tails → normalized threads, error kinds, writer locks, LB errors from `logs_2.sqlite` | contracts |
| Claude source | `src/fleet/sources/claude.js` | Claude transcripts (tail-only) + live peer registry → threads, PR links, API errors | contracts |
| Conductor source | `src/fleet/sources/conductor.js` | Conductor sessions/workspaces, last result, open background tasks | contracts |
| Processes source | `src/fleet/sources/processes.js` | Local heavy-verification detector (ps + cwd) | contracts |
| GitHub source | `src/fleet/sources/github.js` | Batched PR readiness (exact-head CI, unresolved threads, merge state, Codex review on head, QA evidence) | contracts |
| BuildBot3 source | `src/fleet/sources/buildbot3.js` | SSH probe parse, LB health, local watch files | contracts |
| Classifier | `src/fleet/classify.js` | Pure: thread + PR + infra → state + blockers | contracts |
| Policy | `src/fleet/policy.js` | Pure: state → decision (nudge / escalate-manager / ask-user / wait / none), limits, caveman text | contracts, playbooks |
| Playbooks | `src/fleet/playbooks.js`, `examples/skills/fleet-supervisor/` | Load editable message templates + limits from skill files | contracts |
| Store | `src/fleet/store.js` | Owner-only JSON state: snapshot, nudge ledger, questions, action log | contracts, file-utils |
| Executor | `src/fleet/executor.js` | Deliver a message to a thread; dry-run; journal; per-tick cap | contracts |
| Notify | `src/fleet/notify.js` | Outreach item + optional BuzzKit, quiet hours, hourly cap | contracts |
| Supervisor | `src/fleet/supervisor.js` | Tick orchestration, modes, start/stop | all above |
| Routes + page | `src/fleet/routes.js`, `src/fleet/page.js` | `/fleet` mini app + JSON API | supervisor |
| CLI | `scripts/fleet-scan.mjs` | `node scripts/fleet-scan.mjs [--json]` dry-run report from a terminal | supervisor |

## Classification (per thread)

States, first match wins:

1. `excluded` — out of scope (D6).
2. `running` — turn in progress, recent writes. Never touched.
3. `infra-blocked` — last turn ended on an infra error. Kinds: `session-limit` (with reset time), `model-limit`, `usage-limit`, `overloaded`, `network`, `lb`, `logged-out`, `disk-full`. Recovery depends on the kind.
4. `waiting-ci` — Conductor `waiting` with an open background task, or the last text says it is waiting on CI/verify ("CI is running on", "watching", "bb-verify run N"). Fine until the task is older than its threshold.
5. `local-verify` — a heavy verification process is running from this thread's cwd on the laptop.
6. `needs-human` — the agent asked something out of scope (named human approval, `--admin`, production, credentials, money, deleting others' resources, product A/B without a recommended option).
7. `asked-in-scope` — the agent asked permission for an in-scope step ("Want me to…?", "Say go", "Should I…?").
8. `pr-not-ready` — idle and its PR fails readiness: CI red/missing on the exact head, unpushed commits, unresolved review threads, merge conflicts, Codex review not on head, UI QA missing.
9. `ready-needs-human` — PR is ready except a human approval or merge.
10. `done` — PR merged or closed.
11. `idle-no-pr` — idle with no PR. Reported, not nudged.

## Policy (what the supervisor does)

| State | Supervisor action | Owner pinged when |
|---|---|---|
| `infra-blocked: session-limit` | wait until reset + 2 min, then resume | reset >8 h away |
| `infra-blocked: model-limit` | never resend `continue` on the same model | always (switch model is manual): `madrid: Fable capped. Switch model?` |
| `infra-blocked: overloaded/network` | back off 5 → 15 min, resume | 3 failed resumes |
| `infra-blocked: lb` | escalate to BuildBot3 manager ("reopen codex-lb"); resume when LB healthy | manager offline or LB down >60 min |
| `infra-blocked: logged-out` / `disk-full` | none | at once, one line |
| `waiting-ci` | watch; when CI finishes on the head, send "CI finished on <sha>: <result>" | never |
| `waiting-ci` older than threshold | escalate BuildBot3 (full >30 min, quick >15 min) | manager offline |
| `local-verify` | send "Don't verify locally. bb-quick on BuildBot3, push, hosted CI gates." | never |
| `asked-in-scope` | answer "yes — do it; standing authorization" | never |
| `needs-human` | none | one caveman question with buttons |
| `pr-not-ready` | merge-readiness nudge listing the exact failing items | 3 nudges with no progress (no new head, no thread resolved) |
| `ready-needs-human` | none | `#6522 ready. Merge?` or `Needs Nikhil approve.` |
| `done`, `idle-no-pr`, `running` | none | never |

Global limits: ≥12 min between nudges to one thread; ≤3 nudges without progress, then ask the owner; ≤4 sends per tick; never nudge a thread the owner messaged in the last 10 min; never nudge the supervisor's own session.

Infra-level rules: BuildBot3 gate blocked >30 min, SSH failing twice, or known timers dead → one manager escalation per 60 min with PR, head, run age, and queue depth. When BuildBot3 or the LB recovers, resume every thread that was blocked on it.

## Playbooks (skill files)

`examples/skills/fleet-supervisor/SKILL.md` documents the loop for any agent (and exposes `skill_fleet_supervisor` to OpenAGI chat). Message templates live next to it in `playbooks/<id>.md`:

```markdown
---
id: merge-ready
cooldown_min: 12
max_attempts: 3
ask: "#{pr} stuck. {blocker}. Help?"
---
Ready to merge? If not, get it ready: {blockers}. ...
```

A user copy at `<dataDir>/skills/fleet-supervisor/playbooks/<id>.md` overrides the bundled one, so wording changes need no code change. Placeholders: `{pr}`, `{head}`, `{blockers}`, `{ci}`, `{reset}`, `{thread}`, `{repo}`.

## Delivery

| Thread | Route | Precondition |
|---|---|---|
| Codex | `codex exec resume <id> --skip-git-repo-check <msg>` from its cwd, `CODEX_LB_API_KEY` loaded from `~/.codex/codex-lb.env` | not archived, no writer lock (`~/.codex/thread-writer-locks/<id>.lock` held by a live pid) |
| Claude or Conductor, live | `claude -p` SendMessage relay to its peer name (g2 `relayToPeer` contract; success = `DONE`) | peer in `~/.claude/sessions/<pid>.json`, pid alive |
| Claude CLI, not live, not Conductor | `claude -p --resume <id> --permission-mode bypassPermissions <msg>` (nudge skill) | `auto` mode only |
| Conductor not live, Codex writer-locked | none: needs-you "open <workspace>" only when the thread is otherwise stuck | — |

Every send is journaled (thread, playbook, message hash, route, result). A send in flight marks the thread so the next tick cannot double-send. Absolute binary paths (the app daemon's PATH is minimal).

## Needs-you queue

`FleetStore.questions`: `{ id, dedupeKey, threadKey, prRef, title ≤100, body ≤220, options, status open|answered|dismissed|expired, answer }`. One open question per dedupe key. The owner answers on `/fleet` (buttons). An answer to an agent's question is delivered to that thread in `propose`/`auto`. Each open question also becomes a local outreach item (`type: "fleet-question"`) and, when D3 is on, a BuzzKit push with a deep link to `/fleet?q=<id>`.

## Mini app

`GET /fleet`: standalone page (phone-sized, same auth/Origin gate). Sections: **Needs you** (cards with buttons), **Doing** (actions sent or proposed, one-tap send in `propose`), **Fleet** (thread, repo#PR, state, blocker, last nudge), **Infra** strip (BuildBot3 gate, queue, oldest verify, LB, local-verify violations). Buttons: Scan now, Mode. JSON API under `/fleet/api/*`. A "Fleet" link sits in the dashboard header.

## Safety

- Read-only everywhere except the executor, which only sends templated text through the three routes above.
- `observe` default. `auto` needs the env flag or the page toggle.
- Never kills, never changes permissions, never merges, never answers out-of-scope questions.
- Transcript text is untrusted: rendered with `textContent`, never used as instructions, never forwarded to the owner verbatim beyond 220 chars.
- No secrets in state, logs, or pages (BuzzKit endpoint, LB key, tokens are read at call time).
- Every source failure degrades to "unknown", never crashes the tick.

## Testing

- Unit tests per unit with temp fixtures: fake Codex home (sqlite + rollouts), fake Claude projects, fake Conductor DB, fake `gh`/`ssh`/`ps` runners.
- Policy table tests: one case per row, plus limits (cooldown, max attempts, owner-recently-typed).
- HTTP tests: 401 without auth, 403 cross-origin POST, state, scan, answer, mode.
- Page script parsed with `vm.Script`.
- Live dry-run on this Mac: `node scripts/fleet-scan.mjs` in `observe`, compared against manual `gh`/`ssh` checks.

## Follow-ups (not in v1)

- Mirror needs-you items to the Distiller main (node capability `fleet-supervisor`) so Mac banners and G2 show them. Needs main ≥0.0.27.
- Conductor CLI delivery for non-live Conductor sessions (needs `conductor auth login`).
- `codex queue` delivery for Desktop-held Codex threads (needs one deliberate test).
- Model-judged "goal accomplished" check with structured output.
- Automatic model switch on Claude model limits.
