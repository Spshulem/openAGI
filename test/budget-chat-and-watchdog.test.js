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
