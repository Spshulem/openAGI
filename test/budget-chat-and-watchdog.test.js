import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDurableRuntime } from "../src/index.js";
import { registerCoreTools } from "../src/tool-registry.js";
import { ownerPrincipal, intentCovers, parseDirectBudgetCommand } from "../src/owner-authority.js";
import { DEFAULTS, resolveFleetConfig } from "../src/fleet/contracts.js";
import { listAntigravityThreads } from "../src/fleet/sources/antigravity.js";
import { createPaseoSource } from "../src/fleet/sources/paseo.js";
import { deliverPaseo } from "../src/fleet/paseo-delivery.js";
import { classifyThread } from "../src/fleet/classify.js";
import { decideThread } from "../src/fleet/policy.js";
import { loadPlaybooks, BUNDLED_PLAYBOOKS_DIR } from "../src/fleet/playbooks.js";
import { diagnoseAgentBlocker, estimateExpectedCheckIn } from "../src/fleet/watchdog.js";
import { FleetSupervisor } from "../src/fleet/supervisor.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

function makeTempDir(t, prefix = "openagi-budget-watchdog-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("parseDirectBudgetCommand and budget intent family recognize chat top-ups and limit updates", () => {
  assert.deepEqual(parseDirectBudgetCommand("+$25"), { addUsdToday: 25 });
  assert.deepEqual(parseDirectBudgetCommand("+$15 today"), { addUsdToday: 15 });
  assert.deepEqual(parseDirectBudgetCommand("add $20 to my budget"), { addUsdToday: 20 });
  assert.deepEqual(parseDirectBudgetCommand("top up $50 for today"), { addUsdToday: 50 });
  assert.deepEqual(parseDirectBudgetCommand("set daily budget to $75"), { dailyUsdLimit: 75 });
  assert.deepEqual(parseDirectBudgetCommand("change my budget limit to $100/day"), { dailyUsdLimit: 100 });
  assert.deepEqual(parseDirectBudgetCommand("reset today's extra budget"), { resetTodayBonus: true });
  assert.equal(parseDirectBudgetCommand("what is my budget right now?"), null);
  assert.equal(parseDirectBudgetCommand("fix the $25 pricing bug in checkout"), null);

  assert.equal(intentCovers("add $25 to my budget", "update_budget"), true);
  assert.equal(intentCovers("+$10 today", "update_budget"), true);
  assert.equal(intentCovers("change daily budget to $50", "update_budget"), true);
  assert.equal(intentCovers("what did codex say about the budget?", "update_budget"), false);
});

test("chat budget approval & top-up unblocks an exhausted daily budget with zero LLM spend", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-budget-chat-"));
  const prevDataDir = process.env.OPENAGI_DATA_DIR;
  const prevLimit = process.env.OPENAGI_DAILY_USD_LIMIT;
  process.env.OPENAGI_DATA_DIR = dataDir;
  process.env.OPENAGI_DAILY_USD_LIMIT = "5";

  let runtime;
  t.after(async () => {
    await runtime?.sessionIndex?.ready?.catch?.(() => {});
    for (const store of [runtime?.observations, runtime?.vectorStore, runtime?.sessionIndex]) store?.db?.close?.();
    if (prevDataDir === undefined) delete process.env.OPENAGI_DATA_DIR;
    else process.env.OPENAGI_DATA_DIR = prevDataDir;
    if (prevLimit === undefined) delete process.env.OPENAGI_DAILY_USD_LIMIT;
    else process.env.OPENAGI_DAILY_USD_LIMIT = prevLimit;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  runtime = createDurableRuntime({
    dataDir,
    registerDefaults: false,
    integrations: false,
    skills: false,
    autoConnectMcp: false
  });
  registerCoreTools(runtime.tools, runtime);
  await runtime.sessionIndex?.ready?.catch?.(() => {});
  let llmCalls = 0;
  runtime.agentHost.modelProvider = {
    budgetGuard: runtime.budget,
    isConfigured: () => true,
    generate: async ({ input }) => {
      runtime.budget.check();
      llmCalls += 1;
      return { text: `Model answered: ${input}`, provider: "deterministic", model: "det-1", id: `resp-${llmCalls}` };
    }
  };

  // Exhaust today's $5.00 budget.
  runtime.budget.recordUsd(5.2, "gpt-6.2-sol");
  assert.equal(runtime.budget.status().exceeded, true);

  // 1. Non-owner / background call to update_budget queues a PendingAction approval card.
  const queued = await runtime.tools.invoke("update_budget", { addUsdToday: 15, reason: "Finish deployment verification" }, {
    sessionId: "budget-chat",
    agentId: "main",
    channel: "autopilot",
    __reason: "autopilot requested extra budget"
  });
  assert.equal(queued.ok, true);
  assert.equal(queued.result.status, "awaiting_confirmation");
  assert.ok(queued.result.code, "queues a confirmation code for chat approval");
  assert.equal(runtime.budget.status().exceeded, true, "not applied until owner approves");

  // 2. Owner approves the queued budget card in chat ("yes <code>") WHILE budget is still exceeded!
  const owner = ownerPrincipal("phone", "node-peri");
  const confirmTurn = await runtime.agentHost.handleMessage(
    { text: `yes ${queued.result.code}`, sessionId: "budget-chat", channel: "local", routeTo: false },
    { principal: owner }
  );
  assert.equal(runtime.budget.status().exceeded, false, "approved card added +$15 headroom");
  assert.equal(runtime.budget.status().bonusUsdToday, 15);
  assert.ok(confirmTurn.reply.length > 0);

  // 3. Exhaust budget again, then owner types a direct "add $25 to my budget" command in chat — works with 0 LLM calls!
  runtime.budget.recordUsd(15.5, "gpt-6.2-sol");
  assert.equal(runtime.budget.status().exceeded, true);
  const callsBeforeDirect = llmCalls;

  const topUpTurn = await runtime.agentHost.handleMessage(
    { text: "add $25 to my budget", sessionId: "budget-chat", channel: "local", routeTo: false },
    { principal: owner }
  );
  assert.equal(llmCalls, callsBeforeDirect, "direct budget top-up needs zero LLM calls when over budget");
  assert.match(topUpTurn.reply, /Added \+\$25\.00 to today's budget/);
  assert.equal(runtime.budget.status().exceeded, false);
  assert.equal(runtime.budget.status().bonusUsdToday, 40);
});

test("Antigravity CLI path fallback and 15-hour live-server hung conversation detection", async (t) => {
  const home = makeTempDir(t, "agy-cli-home-");
  const cliDir = path.join(home, ".gemini", "antigravity-cli");
  fs.mkdirSync(path.join(cliDir, "conversations"), { recursive: true });

  const now = Date.parse("2026-11-21T09:00:00.000Z");
  const goSixteenHoursAgo = "2026-11-20 17:00:00.000000+00:00";
  const goThirtyMinsAgo = "2026-11-21 08:30:00.000000+00:00";

  const db = new DatabaseSync(path.join(cliDir, "conversation_summaries.db"));
  db.exec(`CREATE TABLE conversation_summaries (
    conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT '', preview text NOT NULL DEFAULT '',
    step_count integer NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL, workspace_uris text NOT NULL,
    status text NOT NULL DEFAULT '', source text NOT NULL DEFAULT '', project_id text NOT NULL DEFAULT '',
    agent_name text NOT NULL DEFAULT '', parent_conversation_id text NOT NULL DEFAULT '',
    nesting_depth integer NOT NULL DEFAULT 0, not_fully_idle numeric NOT NULL DEFAULT false,
    killed numeric NOT NULL DEFAULT false, last_user_input_time datetime NOT NULL,
    last_user_input_step_index integer NOT NULL DEFAULT -1, raw_summary blob, group_id text NOT NULL DEFAULT ''
  )`);
  const ins = db.prepare(`INSERT INTO conversation_summaries
    (conversation_id, title, step_count, last_modified_time, workspace_uris, status, project_id, not_fully_idle, killed, last_user_input_time)
    VALUES (?, ?, ?, ?, ?, ?, 'p1', ?, 0, ?)`);
  ins.run("stuck-16h-run", "Staging QA Report Analysis", 12, goSixteenHoursAgo, JSON.stringify(["file:///work/app"]), "CASCADE_RUN_STATUS_RUNNING", 0, goSixteenHoursAgo);
  ins.run("stuck-15h-bg", "TileNews Safari check", 9, goSixteenHoursAgo, JSON.stringify(["file:///work/tilenews"]), "CASCADE_RUN_STATUS_IDLE", 1, goSixteenHoursAgo);
  ins.run("fresh-30m-run", "Active coding turn", 4, goThirtyMinsAgo, JSON.stringify(["file:///work/app"]), "CASCADE_RUN_STATUS_RUNNING", 0, goThirtyMinsAgo);
  db.close();

  const cfg = resolveFleetConfig({}, { home });
  assert.equal(cfg.paths.antigravityHome, cliDir, "falls back to ~/.gemini/antigravity-cli when .gemini/antigravity has no DB");

  const threads = await listAntigravityThreads(cfg, {
    now,
    languageServer: { pid: 99, address: "127.0.0.1:50123" }
  });
  const byId = new Map(threads.map((th) => [th.id, th]));

  // Fresh 30m run stays running; 16h hung runs become stalled with silentStuck=true even with live LS!
  assert.equal(byId.get("fresh-30m-run").agentStatus, "running");
  assert.equal(byId.get("stuck-16h-run").agentStatus, "stalled");
  assert.equal(byId.get("stuck-16h-run").meta.silentStuck, true);
  assert.equal(byId.get("stuck-15h-bg").agentStatus, "stalled");
  assert.equal(byId.get("stuck-15h-bg").meta.silentStuck, true);

  // Classify + Policy routes the 16h hung Antigravity session to status-check nudge!
  const playbooks = loadPlaybooks({ bundledDir: BUNDLED_PLAYBOOKS_DIR });
  const classified = classifyThread({ ...byId.get("stuck-16h-run"), repo: "Spshulem/openAGI", branch: "spencer/qa" }, { now, config: cfg });
  assert.equal(classified.state, "stopped");
  assert.equal(classified.snag?.kind, "silent-turn");

  const decision = decideThread(classified, { ...byId.get("stuck-16h-run"), repo: "Spshulem/openAGI", branch: "spencer/qa" }, {
    playbooks,
    config: cfg,
    mode: "auto",
    now
  });
  assert.equal(decision.action, "nudge");
  assert.equal(decision.playbook, "status-check");
  assert.equal(decision.route, "antigravity-send");
});

test("Paseo 15-hour silent running session is diagnosed as stalled and steered cleanly", async (t) => {
  const storeDir = makeTempDir(t, "paseo-watchdog-");
  const now = Date.now();
  const fifteenHoursAgo = new Date(now - 15.5 * HOUR).toISOString();

  let sentPayload = null;
  const timelineEntries = [
    { timestamp: fifteenHoursAgo, item: { type: "user_message", messageId: "m1", text: "Run the staging QA analysis" } },
    { timestamp: fifteenHoursAgo, item: { type: "assistant_message", messageId: "m2", text: "Starting the staging QA analysis now." } }
  ];
  const hungAgent = {
    id: "504212e5-808c-4a7f-afe9-a5d3a7eeb0cd",
    title: "Staging QA Report Analysis",
    provider: "antigravity",
    status: "running",
    activeTurn: { turnId: "turn-old" },
    cwd: "/home/dev/openAGI",
    workspaceId: "openAGI",
    updatedAt: fifteenHoursAgo,
    lastUserMessageAt: fifteenHoursAgo,
    pendingPermissions: []
  };

  const fakeFactory = () => ({
    async connect() {},
    async close() {},
    hosts: {
      async list() {
        return { self: { serverId: "srv_local" }, hosts: [] };
      }
    },
    agents: {
      async list() {
        return { entries: [{ agent: hungAgent }], pageInfo: { hasMore: false } };
      },
      ref() {
        return {
          async refresh() {},
          current() { return hungAgent; },
          timeline: {
            async refetch() {
              return { agent: hungAgent, entries: timelineEntries, epoch: "e1", endCursor: { seq: timelineEntries.length }, hasNewer: false };
            }
          },
          async send(text, options) {
            sentPayload = { text, options };
            timelineEntries.push({
              timestamp: new Date().toISOString(),
              item: { type: "user_message", clientMessageId: options.messageId, messageId: options.messageId, text }
            });
          }
        };
      }
    }
  });

  const cfg = resolveFleetConfig({ OPENAGI_FLEET_PASEO: "1" }, { home: storeDir });
  const listPaseo = createPaseoSource({ factory: fakeFactory });
  const [thread] = await listPaseo(cfg);

  assert.equal(thread.agentStatus, "stalled");
  assert.equal(thread.meta.silentStuck, true);
  assert.match(thread.lastAgentText, /Starting the staging QA analysis now/);

  const delivery = await deliverPaseo({
    config: cfg,
    thread,
    text: "[OpenAGI supervisor] No update from you in 930m while you wait on a long-running turn. Check it now.",
    store: { dir: storeDir },
    actionId: "act-1",
    base: { playbook: "status-check", messageHash: "h1" },
    factory: fakeFactory
  });
  assert.equal(delivery.status, "sent");
  assert.equal(sentPayload?.options?.activeTurnBehavior, "steer");
});

test("declarative agent snags auto-unblock via unblock-snag while human auth walls ask the owner", () => {
  const now = Date.parse("2026-11-21T09:00:00.000Z");
  const thirtyMinsAgo = new Date(now - 30 * MIN).toISOString();
  const cfg = resolveFleetConfig({});
  const playbooks = loadPlaybooks({ bundledDir: BUNDLED_PLAYBOOKS_DIR });

  // 1. Agent stopped on a local snag (without asking a '?' question) -> auto-unblock nudge!
  const snagThread = {
    key: "paseo:srv_1.agent_snag",
    kind: "paseo",
    id: "agent_snag",
    title: "Fix SQLite store migration",
    repo: "Spshulem/openAGI",
    branch: "spencer/sqlite-fix",
    prLookedUp: true,
    prRefs: [],
    agentStatus: "idle",
    lastUserAt: new Date(now - 45 * MIN).toISOString(),
    lastUserText: "Fix the observation store migration and run tests",
    lastAgentAt: thirtyMinsAgo,
    lastActivityAt: thirtyMinsAgo,
    lastAgentText: "I ran the test suite, wrapped up the first check, and hit a wall: Error: database is locked (ERR_SQLITE_ERROR). I couldn't get past the failing store test.",
    lastAgentTail: "I ran the test suite, wrapped up the first check, and hit a wall: Error: database is locked (ERR_SQLITE_ERROR). I couldn't get past the failing store test.",
    meta: { serverId: "srv_1" }
  };

  const snagClass = classifyThread(snagThread, { now, config: cfg });
  assert.equal(snagClass.state, "stopped");
  assert.equal(snagClass.snag?.kind, "agent-snag");
  assert.equal(snagClass.snag?.playbook, "unblock-snag");

  const snagDec = decideThread(snagClass, snagThread, { playbooks, config: cfg, mode: "auto", now });
  assert.equal(snagDec.action, "nudge");
  assert.equal(snagDec.playbook, "unblock-snag");
  assert.equal(snagDec.route, "paseo-send");
  assert.doesNotMatch(snagDec.message, /ERR_SQLITE_ERROR/, "never echoes raw untrusted transcript into agent nudge");
  assert.match(snagDec.message, /Diagnose the exact root cause/);

  // 2. Agent stopped on a genuine human-only Tailscale SSH / login wall (no '?' at the end) -> asks owner!
  const authWallThread = {
    ...snagThread,
    key: "paseo:srv_1.agent_auth",
    id: "agent_auth",
    title: "Update distiller box",
    lastAgentText: "I ran openagi update over SSH and it stopped because Tailscale SSH requires an additional check. To authenticate, visit: https://login.tailscale.com/a/12345.",
    lastAgentTail: "I ran openagi update over SSH and it stopped because Tailscale SSH requires an additional check. To authenticate, visit: https://login.tailscale.com/a/12345."
  };

  const wallClass = classifyThread(authWallThread, { now, config: cfg });
  assert.equal(wallClass.state, "needs-human");
  assert.equal(wallClass.ask?.wall, true);

  const wallDec = decideThread(wallClass, authWallThread, { playbooks, config: cfg, mode: "auto", now });
  assert.equal(wallDec.action, "ask-user");
  assert.deepEqual(wallDec.question.options, ["retry", "later"]);
  assert.equal(wallDec.question.meta?.wall, "true");
});

test("adaptive check-in timer estimates duration by work phase and surfaces overdue sessions on FleetState", async (t) => {
  const dataDir = makeTempDir(t, "watchdog-timer-");
  const now = Date.parse("2026-11-21T09:00:00.000Z");

  // Running coding turn silent 35m (> 25m estimate) -> overdue!
  const runningThread = {
    key: "paseo:srv_1.a1",
    kind: "paseo",
    id: "a1",
    title: "Fix mobile header alignment",
    agentStatus: "running",
    lastActivityAt: new Date(now - 35 * MIN).toISOString(),
    lastUserText: "Fix the mobile header alignment",
    prRefs: [],
    meta: { serverId: "srv_1" }
  };
  const runningEst = estimateExpectedCheckIn(runningThread, { classified: { state: "running" }, now });
  assert.equal(runningEst.expectedMinutes, 25);
  assert.equal(runningEst.overdue, true);
  assert.equal(runningEst.overdueMinutes, 10);
  assert.equal(runningEst.status, "overdue");

  // Training / benchmark turn gets 45m estimate -> on_track at 35m!
  const trainEst = estimateExpectedCheckIn(
    { ...runningThread, title: "Train custom small model benchmark" },
    { classified: { state: "running" }, now }
  );
  assert.equal(trainEst.expectedMinutes, 45);
  assert.equal(trainEst.overdue, false);
  assert.equal(trainEst.status, "on_track");

  // FleetSupervisor exposes watchdog summary in getState().
  const sup = new FleetSupervisor({
    dataDir,
    config: resolveFleetConfig({ OPENAGI_FLEET_PASEO: "1", OPENAGI_FLEET_PASEO_ONLY: "1" }, { home: dataDir }),
    skip: { bb3: true, github: true },
    deps: {
      now: () => now,
      listPaseoThreads: async () => [runningThread]
    }
  });
  t.after(() => sup.stop());
  await sup.tick({ reason: "manual" });
  const state = sup.getState();
  assert.equal(state.watchdog.trackedCount, 1);
  assert.equal(state.watchdog.overdueCount, 1);
  assert.equal(state.watchdog.items[0].threadKey, "paseo:srv_1.a1");
  assert.equal(state.watchdog.items[0].expectedMinutes, 25);
});

test("watchdog bookkeeping writes to a linked task do not reset its check-in timer", async (t) => {
  // Regression (#332 review [2]): TaskStore.update() bumps task.updatedAt, so a
  // progress anchor that included it reset an overdue session every scan.
  const dataDir = makeTempDir(t, "watchdog-anchor-");
  let now = Date.parse("2026-11-21T09:00:00.000Z");
  const thread = {
    key: "paseo:srv_1.a1",
    kind: "paseo",
    id: "a1",
    title: "Fix mobile header alignment",
    agentStatus: "running",
    lastActivityAt: new Date(now - 35 * MIN).toISOString(),
    lastUserText: "Fix the mobile header alignment",
    prRefs: [],
    meta: { serverId: "srv_1" }
  };
  const task = {
    id: "task_1",
    status: "in_progress",
    createdAt: new Date(now - 2 * HOUR).toISOString(),
    updatedAt: new Date(now - 40 * MIN).toISOString(),
    statusHistory: [{ status: "in_progress", at: new Date(now - 40 * MIN).toISOString() }],
    sourceMeta: { threadKey: thread.key }
  };
  const tasks = new Map([[task.id, task]]);
  const writes = [];
  const taskStore = {
    tasks,
    update(id, patch) {
      const next = { ...tasks.get(id), ...patch, updatedAt: new Date(now).toISOString() };
      tasks.set(id, next);
      writes.push(next);
      return next;
    }
  };
  const sup = new FleetSupervisor({
    dataDir,
    runtime: { tasks: taskStore },
    config: resolveFleetConfig({ OPENAGI_FLEET_PASEO: "1", OPENAGI_FLEET_PASEO_ONLY: "1" }, { home: dataDir }),
    skip: { bb3: true, github: true },
    deps: { now: () => now, listPaseoThreads: async () => [thread] }
  });
  t.after(() => sup.stop());

  await sup.tick({ reason: "manual" });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].sourceMeta.watchdog.status, "overdue");
  // The watchdog's own write made updatedAt === now; the next scan must still see it overdue.
  const est = estimateExpectedCheckIn(thread, { classified: { state: "running" }, task: tasks.get(task.id), now });
  assert.equal(est.status, "overdue");
  assert.equal(est.anchorAt, thread.lastActivityAt);

  now += 5 * MIN;
  await sup.tick({ reason: "manual" });
  const latest = tasks.get(task.id);
  assert.equal(latest.sourceMeta.watchdog.status, "overdue");
  assert.equal(latest.sourceMeta.watchdog.checkInDueAt, writes[0].sourceMeta.watchdog.checkInDueAt);
  assert.equal(sup.getState().watchdog.overdueCount, 1);
});

test("Paseo running session with recent tool activity is not marked stalled", async (t) => {
  // Regression (#332 review [4]): the history cache keeps only messages and
  // errors, so a tool call one minute ago was ignored when measuring silence.
  const storeDir = makeTempDir(t, "paseo-tool-activity-");
  const now = Date.now();
  const threeHoursAgo = new Date(now - 3 * HOUR).toISOString();
  const oneMinuteAgo = new Date(now - MIN).toISOString();
  const timelineEntries = [
    { timestamp: threeHoursAgo, item: { type: "user_message", messageId: "m1", text: "Run the staging QA analysis" } },
    { timestamp: threeHoursAgo, item: { type: "assistant_message", messageId: "m2", text: "Starting the staging QA analysis now." } },
    { timestamp: oneMinuteAgo, item: { type: "tool_call", name: "run_command", detail: { input: { command: "npm test" } } } }
  ];
  const agent = {
    id: "tool-active-agent",
    title: "Staging QA Report Analysis",
    provider: "antigravity",
    status: "running",
    activeTurn: { turnId: "turn-1" },
    cwd: "/home/dev/openAGI",
    workspaceId: "openAGI",
    updatedAt: threeHoursAgo,
    lastUserMessageAt: threeHoursAgo,
    pendingPermissions: []
  };
  const fakeFactory = () => ({
    async connect() {},
    async close() {},
    hosts: { async list() { return { self: { serverId: "srv_local" }, hosts: [] }; } },
    agents: {
      async list() { return { entries: [{ agent }], pageInfo: { hasMore: false } }; },
      ref() {
        return {
          async refresh() {},
          current() { return agent; },
          timeline: {
            async refetch() {
              return { agent, entries: timelineEntries, epoch: "e1", endCursor: { seq: timelineEntries.length }, hasNewer: false };
            }
          }
        };
      }
    }
  });

  const cfg = resolveFleetConfig({ OPENAGI_FLEET_PASEO: "1" }, { home: storeDir });
  const [thread] = await createPaseoSource({ factory: fakeFactory })(cfg);
  assert.notEqual(thread.agentStatus, "stalled");
  assert.equal(thread.meta.silentStuck, undefined);
});

// Regression, 2026-11-25 (Paseo e3c3ce15, "Sales v1 PR review"): a recursive
// Python glob over schema-use.json walked node_modules symlinks inside one
// shell tool call from 05:21 to 16:05 UTC (10 h 44 m) with no other timeline
// event, while Paseo kept refreshing agent.updatedAt. Both stall checks read
// updatedAt as activity, so the chat stayed "running" / on_track.
function liveButSilentFactory({ agent, entries, fail = false }) {
  return () => ({
    async connect() {},
    async close() {},
    hosts: { async list() { return { self: { serverId: "srv_local" }, hosts: [] }; } },
    agents: {
      async list() { return { entries: [{ agent }], pageInfo: { hasMore: false } }; },
      ref() {
        return {
          async refresh() {},
          current() { return agent; },
          timeline: {
            async refetch() {
              if (fail) throw new Error("history unavailable");
              return { agent, entries, epoch: "e1", endCursor: { seq: entries.length }, hasNewer: false };
            }
          }
        };
      }
    }
  });
}

function salesGlobAgent(now, extra = {}) {
  return {
    id: "e3c3ce15-f163-462c-80c3-ef221ea23dbd",
    title: "Sales v1 PR review",
    provider: "antigravity",
    status: "running",
    activeTurn: { turnId: "turn-glob", startedAt: new Date(now - 11 * HOUR).toISOString() },
    cwd: "/home/dev/worktrees/sales-revops-delivery",
    workspaceId: "sales",
    // Paseo refreshed this a minute ago although nothing progressed.
    updatedAt: new Date(now - 1 * MIN).toISOString(),
    lastUserMessageAt: new Date(now - 11 * HOUR).toISOString(),
    pendingPermissions: [],
    ...extra
  };
}

function salesGlobTimeline(now, lastEventAgoMs) {
  const at = (ago) => new Date(now - ago).toISOString();
  return [
    { timestamp: at(11 * HOUR), item: { type: "user_message", messageId: "u1", text: "Finish the remaining schema-use entries." } },
    { timestamp: at(lastEventAgoMs + 40_000), item: { type: "assistant_message", messageId: "a1", text: "Checking which schema-use.json files still miss the new tables." } },
    // The glob call: started, never finished.
    { timestamp: at(lastEventAgoMs), item: { type: "tool_call", status: "running", name: "shell", callId: "call_764285278",
      detail: { type: "shell", command: "python3 - <<'PY'\nimport glob\nglob.glob('**/schema-use.json', recursive=True)\nPY" } } }
  ];
}

test("a live-looking Paseo session with no timeline progress for hours is stalled (schema-use.json glob)", async (t) => {
  const storeDir = makeTempDir(t, "paseo-glob-stall-");
  const now = Date.now();
  const agent = salesGlobAgent(now);
  const cfg = resolveFleetConfig({ OPENAGI_FLEET_PASEO: "1" }, { home: storeDir });
  const [thread] = await createPaseoSource({ factory: liveButSilentFactory({ agent, entries: salesGlobTimeline(now, (10 * 60 + 44) * MIN) }) })(cfg);
  assert.equal(thread.agentStatus, "stalled", "a fresh updatedAt is liveness, not progress");
  assert.equal(thread.meta.silentStuck, true);
  assert.equal(Date.parse(thread.lastProgressAt), now - (10 * 60 + 44) * MIN);
  const classified = classifyThread(thread);
  assert.equal(classified.snag?.kind, "silent-turn");
  assert.ok(classified.snag.silentMinutes >= 10 * 60, `silent for ${classified.snag.silentMinutes} min, not since the last updatedAt refresh`);
  const checkIn = estimateExpectedCheckIn(thread, { classified, now });
  assert.equal(checkIn.severelyStuck, true);
  assert.equal(checkIn.status, "stuck");
});

test("the same live session is healthy while its timeline keeps progressing", async (t) => {
  const storeDir = makeTempDir(t, "paseo-glob-healthy-");
  const now = Date.now();
  const cfg = resolveFleetConfig({ OPENAGI_FLEET_PASEO: "1" }, { home: storeDir });
  const [thread] = await createPaseoSource({ factory: liveButSilentFactory({ agent: salesGlobAgent(now), entries: salesGlobTimeline(now, 4 * MIN) }) })(cfg);
  assert.equal(thread.agentStatus, "running");
  assert.equal(thread.meta.silentStuck, undefined);
  const checkIn = estimateExpectedCheckIn(thread, { classified: classifyThread(thread), now });
  assert.equal(checkIn.severelyStuck, false);
});

test("no stall is claimed without evidence: pending permission, or history that could not be read", async (t) => {
  const now = Date.now();
  const silent = salesGlobTimeline(now, (10 * 60 + 44) * MIN);
  const permissionCfg = resolveFleetConfig({ OPENAGI_FLEET_PASEO: "1" }, { home: makeTempDir(t, "paseo-glob-perm-") });
  const waiting = salesGlobAgent(now, { pendingPermissions: [{ id: "perm-1", title: "Run shell command" }] });
  const [asking] = await createPaseoSource({ factory: liveButSilentFactory({ agent: waiting, entries: silent }) })(permissionCfg);
  assert.notEqual(asking.agentStatus, "stalled", "waiting on a permission is not a stall");
  const unreadCfg = resolveFleetConfig({ OPENAGI_FLEET_PASEO: "1" }, { home: makeTempDir(t, "paseo-glob-unread-") });
  const [unread] = await createPaseoSource({ factory: liveButSilentFactory({ agent: salesGlobAgent(now), entries: silent, fail: true }) })(unreadCfg);
  assert.notEqual(unread.agentStatus, "stalled", "no history read is no evidence of a stall");
  assert.equal(unread.meta.silentStuck, undefined);
});

// Review fix (#382): an idle chat last active hours ago, scanned, then given
// a new turn by its owner before the next history read, was reported stalled
// from the idle chat's old timeline. Evidence must cover the current turn.
test("a new turn started after the last history read is never stalled by the old timeline", async (t) => {
  const storeDir = makeTempDir(t, "paseo-new-turn-");
  const now = Date.now();
  const agent = salesGlobAgent(now, {
    status: "idle", activeTurn: null,
    updatedAt: new Date(now - 3 * HOUR).toISOString(),
    lastUserMessageAt: new Date(now - 3 * HOUR).toISOString()
  });
  const entries = salesGlobTimeline(now, 3 * HOUR).filter((e) => e.item.type !== "tool_call");
  let reads = 0;
  const factory = liveButSilentFactory({ agent, entries });
  const counted = () => {
    const client = factory();
    const ref = client.agents.ref;
    client.agents.ref = (...args) => { const r = ref(...args); const refetch = r.timeline.refetch; r.timeline.refetch = async (...a) => { reads += 1; return refetch(...a); }; return r; };
    return client;
  };
  const cfg = resolveFleetConfig({ OPENAGI_FLEET_PASEO: "1" }, { home: storeDir });
  const source = createPaseoSource({ factory: counted });
  const [idle] = await source(cfg);
  assert.equal(idle.agentStatus, "idle");
  assert.equal(reads, 1);
  // The owner starts a new turn; no new history read happens before the next scan.
  Object.assign(agent, { status: "running", activeTurn: { turnId: "turn-new", startedAt: new Date(Date.now()).toISOString() },
    updatedAt: new Date(Date.now()).toISOString(), lastUserMessageAt: new Date(Date.now()).toISOString() });
  const [started] = await source(cfg);
  assert.equal(reads, 1, "the second scan read no new history");
  assert.equal(started.agentStatus, "running", "a turn the evidence does not cover is not a stall");
  assert.equal(started.meta.silentStuck, undefined);
});
