RUNNING vs DORMANT — ground truth report

## Key finding: two data dirs
- Repo-local `/Users/you/Dev/openAGI/.openagi` is a STALE dev-run artifact (last touched 2026-05-07/06-02, stale pid).
- The LIVE instance is the packaged Mac app `/Users/you/Dev/openAGI/build/OpenAGI.app` (PID 26204 + bundled node PID 26246 running `Contents/Resources/openAGI/examples/hosted-server.js`, both started Fri Jul 3 15:13 2026), writing to `~/.openagi` (confirmed via lsof: node holds `/Users/you/.openagi/observations/index.db`). `curl 127.0.0.1:43210/health` responds (keys: firstRun,ok,status). `~/.openagi/node.json` (keys: remote,token) matches memory note that this Mac is a node paired to a Distiller main at 192.0.2.30:43210.

## (1) Repo `.openagi` (stale dev copy) — files / size / newest
- memory 2 / 668K / 2026-05-07; observations 1 (index.db) / 260K / 2026-06-02; vectors 1 / 1.3M / 2026-06-02; agents 5 / 44K / 2026-05-07; agent-host 14 / 260K / 2026-05-07; cron 1 / 8K / 2026-05-07; outcomes 3 / 12M / 2026-06-02; channels 1 / 4K / 2026-05-06; budget 1 / 4K / 2026-05-07.
- Empty (0 files): scrutiny, skills, skills-suggested, proactive, tasks, pending-actions, inbox, clarifications, drafts, replay, computer-use, integrations.
- Store shapes (keys only): memory-state.json {items,updatedAt,version}; cron/jobs.json {jobs,updatedAt,version}; budget/usage.json {days,version}; outcomes/snapshot.json {outcomes,updatedAt,version}; vectors/store.json {entries,updatedAt,version}; channels/events.jsonl lines {at,channel,op,target,text}; observations/index.db tables: activity, frames, texts (+FTS shadow tables texts_content/config/data/docsize/idx).

## Live `~/.openagi` — files / size / newest
- observations 1 / **742M** / 2026-07-05 (today) — by far the heaviest store; continuous capture is live.
- memory 2 / 2.4M / 2026-07-05; vectors 1 / 2.1M / 2026-07-05; outcomes 2 / 8.9M / 2026-07-05; agents 5 / 172K / 2026-07-05; agent-host 4 / 2.6M / 2026-07-05; cron 1 / 12K / 2026-07-05; budget 2 / 964K / 2026-07-05; outreach 1 / 164K / 2026-07-05 — all touched today.
- proactive 314 files / 1.2M / newest 2026-07-04 (71 files newer than 2026-07-01 — actively producing suggestions).
- skills-suggested 74 / 304K / 2026-06-28; tasks 3 / 260K / 2026-07-03; drafts 1 / 316K / 2026-07-02; scrutiny 4 / 36K / 2026-06-30; clarifications 1 / 4K / 2026-06-09.
- Empty (0 files) even in live install: **skills, pending-actions, inbox, channels, replay, computer-use, integrations**.
- daemon.log mtime 2026-07-03 15:13 (boot banner: listening on 127.0.0.1:43210), consistent with the Jul 3 process start.

## (2) Server status
- Repo `.openagi/server.pid` = 74540, dated May 7; `ps -p 74540` returns nothing → that pid is dead/stale. Repo server.log is 312 bytes, mtime 2026-05-07, only the boot banner.
- Actual server: PID 26246 (bundled node, hosted-server.js) alive since Jul 3, serving :43210 and answering /health.

## (3) git log --oneline -40 summary
Recent work is almost entirely the **proactive-outreach** feature (spec c2814e2/b68fcbf through merge c032568 and follow-up fixes ccd51aa, 34fc638): durable OutreachStore with cursor index, OutreachMapper (events→durable items), DigestComposer with quiet hours, stalled-task surfacing, HTTP endpoints (GET /outreach/feed, /digest; POST /:id/act with idempotency, /:id/reply, /outreach/config), SSE broadcast, and a Mac consumer (notifications with inline actions, overlay list, tray badge, SSE reconnect fixes). Before that: daemon crash guard for MCP connect failures (c099bce), Mac release-build fix (4f0ca3f), operational-runbook/skills docs (d1d67a3, 82ecab1), autopilot gating to only spend model calls on queued work (36840a1), tool-count cap fix "256 tools broke every call" (384be44), and a computer-use run (screenshot vision feedback 9f6757e, coord scaling 4d7cb2f, TCC-free geometry 2c93acc).

## (4) Tests
- `/Users/you/Dev/openAGI/test`: 46 entries, 46 `*.test.js` files. Runner: `"test": "node --test"` (package.json, openagi v0.0.6). Coverage names map to the live subsystems: 6 outreach tests, MCP/OAuth, iMessage bridge/extractor, memory, budget/credit ledger, autopilot gate, computer-server, model-router, proactive-suggestion-flow, migrate, onboarding, self-update.

## Conclusion — live vs dormant
- **Live (daily writes as of 2026-07-04/05):** observation capture (742M SQLite FTS store), memory + vectors, outcomes, agents/agent-host, cron, budget ledger, proactive suggestion engine (314 files, 71 this week), and the new outreach store — all fed by the packaged Mac app + bundled node server on :43210, operating as a paired node of a remote Distiller main.
- **Lightly used:** skills-suggested (74 files, last Jun 28), tasks (Jul 3), drafts (Jul 2), scrutiny (Jun 30), clarifications (one file, Jun 9).
- **Dormant/scaffolding (empty in both installs):** skills (installed), pending-actions, inbox, channels (live), replay, computer-use, integrations — directories exist but nothing has ever been persisted; computer-use code shipped (git + tests) but its store is unused.
- The repo-local `.openagi` is a dead dev snapshot from May 7 (stale server.pid 74540) and should not be read as current state.