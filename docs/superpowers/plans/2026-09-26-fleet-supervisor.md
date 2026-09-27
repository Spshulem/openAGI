# Fleet Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local OpenAGI subsystem plus `/fleet` mini app that classifies every recent Codex / Claude / Conductor coding thread, judges PR merge-readiness from GitHub and BuildBot3, nudges threads with playbook templates, escalates BuildBot3/LB problems to the manager agent, and keeps a tiny caveman "needs you" queue.

**Architecture:** Read-only sources normalize each system into `FleetThread`, `FleetPr`, `FleetInfra` (shapes in `src/fleet/contracts.js`). Pure `classify` + `policy` turn them into `FleetDecision`s using editable playbook files. A supervisor tick persists a snapshot, executes decisions according to the mode (`observe` / `propose` / `auto`), and exposes everything through JSON routes and a standalone page.

**Tech Stack:** Node >= 22 ESM, `node:test`, `node:sqlite` (read-only), `gh`, `ssh`, `ps`, `lsof`, `git` via `runCommand`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-26-fleet-supervisor-design.md`

## Global Constraints

- Node 22 for tests: `~/.nvm/versions/node/v22.21.1/bin/node --test test/<file>.test.js` (system `node` is v20 and lacks `node:sqlite`).
- Import shared names only from `src/fleet/contracts.js` and `src/fleet/errors.js`. Do not edit those two files; report needed changes instead.
- Sources never throw: failures become `null` / `[]` / `{ error }`. Never read whole transcripts: use `readTail`.
- Every external command goes through an injectable `run` (default `runCommand`) with absolute binaries from `config.bins`.
- Read-only everywhere except `src/fleet/executor.js`. Never kill a process you did not spawn. Never call docker on BuildBot3.
- Untrusted transcript text passes through `redactSecrets` and `clampText(…, config.limits.excerptMax)` before storage.
- No backticks and no dollar-brace sequences inside `String.raw` UI/page modules. No `??` mixed with `||` without parentheses.
- Tests use temp dirs and fake runners only. Never read the real `~/.openagi`, `~/.codex`, `~/.claude`, or Conductor DB in tests.
- Owner-facing text: questions ≤100-char title, ≤220-char body, one question, fewest words.

## Review Focus

1. A thread the owner is actively typing into gets nudged anyway → `policy` must skip when `lastUserAt` is within `ownerRecentMs` (Task 4 test).
2. The same stalled thread gets re-nudged every tick → cooldown and max-attempts from the ledger (Task 4 test) and the executor in-flight guard (Task 5 test).
3. A session/usage limit gets `continue` before its reset → `notBefore = resetAt + sessionLimitGraceMs` (Task 4 test).
4. A missing tool or dead SSH on the laptop crashes the tick → every source returns a degraded value; supervisor tick survives a throwing source (Task 6 test).
5. Agent text containing HTML or instructions ends up executed or rendered as HTML → page uses `textContent` only; policy never copies agent text into messages sent to other agents (Task 6 test).

---

### Task 1: Codex and local-process sources

**Files:**
- Create: `src/fleet/sources/codex.js`, `src/fleet/sources/processes.js`
- Test: `test/fleet-source-codex.test.js`, `test/fleet-source-processes.test.js`

**Interfaces:**
- Consumes: `contracts.js` (`resolveFleetConfig`, `readTail`, `parseJsonLines`, `openReadOnlyDb`, `clampText`, `redactSecrets`, `threadKey`, `toIso`, `runCommand`), `errors.js` (`classifyCodexErrorCode`, `classifyErrorText`).
- Produces:
  - `listCodexThreads(config, { now?: number, isPidAlive?: (pid) => boolean }) => Promise<FleetThread[]>` — reads `<codexHome>/state_5.sqlite` table `threads` (verify real column names with `sqlite3 -readonly ~/.codex/state_5.sqlite ".schema threads"`; schema only, never content), keeps rows updated within `lookbackHours`, parses the rollout tail. `kind: "codex"`. `excluded` reasons: `"archived"`, `"automation"` (thread_source guardian_review/subagent/automation, or heartbeat input), `"no-repo"` when cwd missing. `writerLocked` from `<codexHome>/thread-writer-locks/<id>.lock` held by a live pid (inspect the real lock file format read-only). `prRefs` from `github.com/<o>/<r>/pull/<n>` URLs in `attach_artifact` calls and user messages. `agentStatus`: unfinished turn + rollout mtime within `runningWindowMs` → `running`; unfinished + older → `stalled`; `turn_aborted` → `aborted` (`meta.abortReason`); `task_complete` with `payload.error` → `error` with `error = classifyCodexErrorCode(...)`; `task_complete` → `idle`.
  - `readCodexLbErrors(config, { now?: number, windowMs?: number }) => Promise<{kind, count, lastAt, threadIds}[]>` from `<codexHome>/logs_2.sqlite` (verify schema; `responses_retry` target rows) grouped by kind: `no-accounts`, `connection`, `auth`, `unavailable`, `usage-limit`, `other`.
  - `findLocalHeavyVerification(config, { run? }) => Promise<{pid, command, cwd, ageSec}[]>` — `ps -axo pid=,ppid=,etime=,command=`, matches `verify:pr`, `nx run-many`, `pnpm (run )?build`, `docker compose up`, `docker-compose up`, `local-stack:up`, a local `bb-verify` not run over `ssh`; excludes lines containing `ssh `; cwd via `lsof -a -p <pid> -d cwd -Fn`.
  - `parseEtime(text) => number` seconds for `[[dd-]hh:]mm:ss`.
  - `matchThreadByCwd(cwd, threads) => string|null` longest `thread.cwd` prefix match, returns thread key.

- [ ] Step 1: Write fixture builders in the test (temp `codexHome` with a `state_5.sqlite` created through `node:sqlite` using the real column names, rollouts for: running, stalled, aborted, usage-limit error, idle with PR link, automation thread, archived thread).
- [ ] Step 2: Run tests, see them fail.
- [ ] Step 3: Implement both modules.
- [ ] Step 4: Run tests, see them pass. Also run `listCodexThreads(resolveFleetConfig())` once against the real machine read-only from a scratch script and print only counts per status (no content) to sanity-check parsing.

### Task 2: Claude and Conductor sources

**Files:**
- Create: `src/fleet/sources/claude.js`, `src/fleet/sources/conductor.js`
- Test: `test/fleet-source-claude.test.js`, `test/fleet-source-conductor.test.js`

**Interfaces:**
- Produces:
  - `listClaudeThreads(config, { now?, isPidAlive? }) => Promise<FleetThread[]>` — scans `<claudeHome>/projects/*/*.jsonl` modified within lookback (tail ≤2 MB). `kind: "claude"`, `id` = session id (file name), `claudeSessionId` = same. Uses entry fields `type`, `message.content`, `timestamp`, `cwd`, `gitBranch`, `isSidechain`, `isApiErrorMessage`, `error`, and `{"type":"pr-link","prNumber","prRepository"}` rows. Excluded: sidechain, cwd under `paths.relayCwd` or `/tmp`, id in `config.selfSessionIds`, fewer than 5 assistant turns in the tail (`"too-short"`). `meta.conductorHosted = true` when cwd contains `/conductor/workspaces/` or `/.conductor/` or entrypoint is `sdk-ts`. `live` from the peer registry.
  - `readLivePeers(config, { isPidAlive? }) => Map<sessionId, {peerName, pid, status, cwd, entrypoint}>` from `<claudeHome>/sessions/*.json` (fields `pid, sessionId, cwd, name, status, entrypoint`), alive pids only.
  - `listConductorThreads(config, { now? }) => Promise<FleetThread[]>` — `paths.conductorDb` read-only: sessions ⋈ workspaces where workspace `state != 'archived'`, session not hidden, updated within lookback. `kind: "conductor"`, `id` = sessions.id, `claudeSessionId`, `workspace` = directory_name, `cwd` = workspace_path, `branch` = workspaces.branch, `title`. Status map: `working → running`, `waiting → waiting`, `idle → idle`, `error → error`. Last `result` row (`is_error`, `result`) → `error` via `classifyErrorText`; last assistant text → `lastAgentText`; last real user message → `lastUserText/At`; open background tasks = `task_started` without matching `task_notification` → `openTasks`. `meta.derivedStatus` = workspaces.derived_status. Inspect the real `session_messages` content shapes read-only (limit rows, truncate) before writing fixtures.
  - `findManagerSession(config, threads) => FleetThread|null` — matches `config.managerRef` against conductor thread id, claudeSessionId, or workspace name.

### Task 3: GitHub and BuildBot3 sources

**Files:**
- Create: `src/fleet/sources/github.js`, `src/fleet/sources/buildbot3.js`
- Test: `test/fleet-source-github.test.js`, `test/fleet-source-buildbot3.test.js`

**Interfaces:**
- Produces:
  - `fetchPrStates(refs, config, { run? }) => Promise<Map<ref, FleetPr>>` — one `gh api graphql -f query=<q>` per ≤20 refs (fragment from `.context/research/gaps.md` §4 plus `comments(last:30){nodes{author{login} body createdAt}}` and `files(first:100){nodes{path}}`). Codex review: comment containing `<!-- codex-pull-request-review-summary -->` with `Completed` and a 7-char sha equal to head prefix → `reviewedHead: true`. QA: `qa.required` = any file under `config.uiPathPrefixes?.[repo]` (default bbapp list: `packages/apps/web-app/`, `packages/apps/admin-app/`, `packages/apps/portal-app/`, `packages/apps/portal-embed/`, `packages/apps/zeroshot-app/`, `packages/apps/desktop-app/`, `packages/apps/changelog-widget/`, `packages/apps/feedback-widget/`, `packages/apps/keycloak-theme/`), else `null`; `qa.sha` from the latest comment matching `**Screenshots**` and `PR box ` + "`pr<N>`" + ` on ` + "`<sha>`"; `freshOnHead` = sha is a prefix of head. Unknown refs or GraphQL errors → absent from the map.
  - `findPrForBranch(repo, branch, config, { run? }) => Promise<string|null>` — `gh pr list --repo <repo> --head <branch> --state all --json number,state,updatedAt`, prefer OPEN then newest.
  - `readLocalGit(cwd, config, { run? }) => Promise<LocalGit>` — `git -C <cwd>` `rev-parse HEAD`, `rev-parse --abbrev-ref HEAD`, `rev-parse --abbrev-ref @{u}`, `rev-list --count @{u}..HEAD`, `remote get-url origin` (→ `repoFromRemote`). Missing dir or EPERM → all null.
  - `probeBuildBot3(config, { run?, now? }) => Promise<FleetInfra["bb3"]>` — one `ssh -o BatchMode=yes -o ConnectTimeout=10 <bb3Host> '<script>'` with `timeoutMs: 40000`; the remote script prints marked sections: `ps -eo pid=,etimes=,args=` filtered to `bin/bb-quick|bin/bb-verify`, `ls ~/.bb-ci/quick/queue | wc -l`, `ls ~/.bb-ci/canonical-verification/queue | wc -l`, `cat ~/.bb-ci/gate-status.json`, `cat /proc/loadavg`, `systemctl --user list-timers --all --no-pager`. No docker.
  - `parseBb3Probe(text, now) => FleetInfra["bb3"]` (pure). Runs: `--full` → `full`, else `quick`; `--pr N`; `--head <sha>`; owner from a log redirect like `~/monrovia-pr6874-full.log` or `bb-verify-6873-sydney.log`. `timersDead` = any of `lb-health`, `lb-guard`, `bb-ci-warm` whose NEXT column is `-` or `n/a`, or that is missing.
  - `checkLb(config, { fetchImpl?, now?, readFile? }) => Promise<{healthy, detail, watchLine}>` — `GET <lbUrl>/health` (5 s timeout) and the last line of `paths.lbWatchLog`.
  - `readLocalWatchState(config, { readFile? }) => {bb3State: string|null, gateState: string|null}`.

### Task 4: Classifier, policy, playbooks, and skill files

**Files:**
- Create: `src/fleet/classify.js`, `src/fleet/policy.js`, `src/fleet/playbooks.js`
- Create: `examples/skills/fleet-supervisor/SKILL.md`, `examples/skills/fleet-supervisor/playbooks/{resume,merge-ready,ci-finished,no-local-verify,in-scope-yes,bb3-slow-agent,infra-recovered,manager-bb3,manager-lb}.md`
- Test: `test/fleet-classify.test.js`, `test/fleet-policy.test.js`, `test/fleet-playbooks.test.js`

**Interfaces:**
- Produces:
  - `mergeThreads({ codex, claude, conductor }) => FleetThread[]` — a Claude thread whose `claudeSessionId` equals a Conductor thread's `claudeSessionId` merges into it (Conductor keeps status; takes `prRefs`, `live`, `error` when its own is null, `lastAgentText`/`cwd`/`branch` when empty). Unmatched threads pass through.
  - `prReadiness(pr, localGit) => { ready: boolean, blockers: string[], onlyHumanLeft: boolean, progressMark: { head: string|null, unresolved: number|null } }`. Blockers (exact strings): `"CI red: <names>"`, `"CI running"`, `"no CI on head"`, `"unpushed commits"`, `"local head differs"`, `"<n> open threads"`, `"merge conflicts"`, `"Codex review not on head"`, `"UI QA missing"`, `"draft"`. `onlyHumanLeft` = no blockers and (`reviewDecision === "REVIEW_REQUIRED"` or `mergeState === "BLOCKED"`). `ready` = no blockers and not `onlyHumanLeft` (or state CLEAN/MERGEABLE with approval).
  - `classifyThread(thread, { pr, localGit, infra, now, config }) => { state, reason, blockers, readiness }` following the spec's 11-state order. Export `WAITING_PATTERNS`, `IN_SCOPE_ASK_PATTERNS`, `OUT_OF_SCOPE_PATTERNS`.
  - `loadPlaybooks({ bundledDir, userDir }) => Map<id, {id, body, cooldownMin, maxAttempts, ask}>` (flat `key: value` frontmatter; user file with the same id wins). `renderTemplate(text, vars) => string` (`{name}` placeholders, missing → empty, collapse doubled spaces).
  - `decideThread(classified, thread, { ledger, playbooks, config, now, pr, mode }) => FleetDecision` — spec policy table; `route = chooseRoute(thread, mode)`; limits: `ownerRecentMs`, `nudgeCooldownMs`, `maxNudgesWithoutProgress` (progress = `progressMark` changed vs `ledger.lastProgressMark`) → `ask-user` with the playbook's `ask` text; `session-limit`/`usage-limit` → `notBefore = resetAt + sessionLimitGraceMs`; `model-limit`, `logged-out`, `disk-full` → `ask-user`. Messages sent to agents are built only from playbook text and supervisor facts (PR, head, CI names, counts), never from agent text.
  - `decideInfra(infra, { ledger, playbooks, config, now, threads, manager }) => FleetDecision[]` — BuildBot3 escalation (gate blocked ≥ `gateBlockedEscalateMs`, full run ≥ `fullVerifyEscalateMs`, quick ≥ `quickVerifyEscalateMs`, SSH unreachable, `timersDead` non-empty) and LB escalation (`healthy === false` or recent `no-accounts`/`auth`/`connection` errors) as `escalate-manager` to `infra:bb3` / `infra:lb`, at most once per `managerEscalationCooldownMs`; if no live manager → `ask-user` ("BB3 jammed. Manager offline. Open Remote dev setup?"). Recovery (`ledger.infraDown` true and now healthy) → `nudge` with `infra-recovered` to every thread whose state was `infra-blocked` with matching kind.
  - `chooseRoute(thread, mode) => "codex-exec"|"peer-relay"|"claude-resume"|null` per the spec delivery table (`claude-resume` only in `auto`, never for Conductor threads).

### Task 5: Store, executor, notifier

**Files:**
- Create: `src/fleet/store.js`, `src/fleet/executor.js`, `src/fleet/notify.js`
- Test: `test/fleet-store.test.js`, `test/fleet-executor.test.js`, `test/fleet-notify.test.js`

**Interfaces:**
- Produces:
  - `class FleetStore { constructor({ dir }); get mode(); setMode(mode); recordSnapshot(snapshot); get snapshot(); ledgerFor(key) => { nudges: {at, playbook, route, status, messageHash}[], lastProgressMark, attemptsWithoutProgress, lastNudgeAt }; recordNudge(key, entry, progressMark); upsertQuestion({ dedupeKey, threadKey, prRef, title, body, options, playbook }) => question; answerQuestion(id, answer) => question|null; dismissQuestion(id) => question|null; openQuestions() => question[]; question(id); recordAction(action) => action; updateAction(id, patch); actions(limit=50); recordEscalation(key, at); lastEscalation(key) => ISO|null; setInfraDown(kind, down); infraDown(kind) => boolean; recordPush(at); pushesSince(ms, now) => number }` — state in `<dir>/state.json` (0600 via `writeJsonAtomic`), journal `<dir>/actions.jsonl`. Titles clamped to 100, bodies to 220. Questions expire after 24 h.
  - `createExecutor({ config, run?, store, logDir?, spawnBackground? }) => { deliver({ thread, message, route, dryRun }) => Promise<{status: "sent"|"dry-run"|"blocked"|"failed", route, detail}>, inFlight() => string[] }`. Prefix every message with `[OpenAGI supervisor] `. `codex-exec`: `codex exec resume <id> --skip-git-repo-check <msg>` in `thread.cwd`, env = `process.env` + `parseEnvText(<codexLbEnvFile>)`; blocked if archived, writer-locked, or cwd missing; runs in the background (not awaited by the tick) and records completion via `store.updateAction`. `peer-relay`: `claude -p <relay prompt> --allowedTools SendMessage --permission-mode bypassPermissions --model <relayModel>` in `paths.relayCwd` (create it), 180 s timeout, success iff stdout matches `/\bDONE\b/i`; relay prompt mirrors `relayToPeer` in `/Users/shooby/Dev/g2/scripts/agent-supervisor/attach.mjs`. `claude-resume`: `claude -p --resume <id> --permission-mode bypassPermissions <msg>` in `thread.cwd`, background. A thread key already in flight → `blocked`.
  - `createNotifier({ config, store, runtime?, fetchImpl?, readFile?, now? }) => { notifyQuestion(question) => Promise<{outreachId, pushed, skipped}>, isQuietHours(date) => boolean }` — `runtime.outreach.append({ type: "fleet-question", sourceRef: { kind: "fleet", id }, title, summary: body, needsDecision: true, actions: [...options, "dismiss"], dedupeOpen: true })` when available (check the real `OutreachStore.append` signature in `src/outreach-store.js`); BuzzKit when `config.push === "buzzkit"`, not quiet hours, and `store.pushesSince(3600000) < pushPerHour`: `POST <endpoint file contents>` JSON `{ title, body, agent: "openagi-fleet", important: true, url }` with 5 s timeout, `url` = `<publicUrl>/fleet?q=<id>` when `publicUrl` is set. Never log the endpoint.

### Task 6: Supervisor, routes, page, wiring, CLI, docs (after Tasks 1–5)

**Files:**
- Create: `src/fleet/supervisor.js`, `src/fleet/routes.js`, `src/fleet/page.js`, `scripts/fleet-scan.mjs`, `docs/setup/fleet-supervisor.md`
- Modify: `src/abi-runtime.js` (construct `this.fleetSupervisor`), `src/hosted-interface.js` (mount `GET /fleet`, `/fleet/api/*`, start/stop, `fleet` case in `applyOutreachAction`, header link, SSE `fleet` event), `src/index.js` exports if the pattern requires
- Test: `test/fleet-supervisor.test.js`, `test/fleet-routes.test.js`, `test/fleet-http.test.js`, `test/fleet-page.test.js`

**Interfaces:**
- Produces:
  - `class FleetSupervisor { constructor({ dataDir, runtime?, config?, deps? }); start(); stop(); tick({ reason }) => Promise<snapshot>; getState() => { mode, enabled, running, lastTickAt, snapshot, questions, actions }; setMode(mode); answerQuestion(id, answer); dismissQuestion(id); sendProposed(actionId) }` — `deps` overrides every source function, `run`, `fetchImpl`, `now`, `executor`, `notifier` for tests. Tick: collect sources in parallel (each wrapped: a throw becomes a recorded source error), `mergeThreads`, resolve repo/branch/PR per in-scope thread (local git, `findPrForBranch` only when `prRefs` empty; cache per tick), `fetchPrStates`, `probeBuildBot3` + `checkLb` + `readCodexLbErrors` + `findLocalHeavyVerification`, classify, decide, then per mode: `observe` records decisions only; `propose` stores nudge/escalation actions as `proposed`; `auto` delivers up to `maxSendsPerTick` with the executor. `ask-user` decisions always upsert a question and call the notifier. A second `tick` while one runs returns the running promise.
  - `createFleetRoute({ supervisor }) => (method, pathname, url, readBody) => Promise<{status, body}|null>` — `GET /fleet/api/state`, `POST /fleet/api/scan`, `POST /fleet/api/mode {mode}`, `POST /fleet/api/questions/<id> {answer}|{dismiss:true}`, `POST /fleet/api/actions/<id>/send`.
  - `fleetPage` (`String.raw` HTML) served at `GET /fleet` with `sendHtml`: sections Needs you / Doing / Fleet / Infra, buttons Scan now and Mode, `textContent` rendering only, polls `/fleet/api/state` every 30 s.
  - `scripts/fleet-scan.mjs [--json] [--no-bb3] [--no-github] [--data-dir <dir>]` — runs one `observe` tick against the real machine and prints a caveman report (or JSON).
