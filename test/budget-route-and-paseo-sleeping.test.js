import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BudgetGuard } from "../src/budget-guard.js";
import { CreditLedger } from "../src/credit-ledger.js";
import { isMobileRouteAllowed } from "../src/mobile-node.js";
import { isMainDataRoute } from "../src/main-data-router.js";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { NodeRegistry } from "../src/node-registry.js";
import { createPaseoSource } from "../src/fleet/sources/paseo.js";
import { deriveProjectInfo } from "../src/fleet/coordinator.js";
import { FleetSupervisor } from "../src/fleet/supervisor.js";
import { resolveFleetConfig } from "../src/fleet/contracts.js";

test("BudgetGuard prices gpt-6.2-sol accurately and supports live daily limit + same-day top-up", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-topup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = new CreditLedger({ storePath: path.join(dir, "ledger.jsonl") });
  const guard = new BudgetGuard({ storePath: path.join(dir, "usage.json"), dailyUsdLimit: 10, ledger });

  assert.deepEqual(guard.priceFor("gpt-6.2-sol"), { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5 });
  assert.deepEqual(guard.priceFor("gpt-6.2-sol-2026-11"), { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5 });

  guard.recordUsd(10.05, "gpt-6.2-sol", { channel: "supervisor" });
  assert.equal(guard.status().exceeded, true);
  assert.throws(() => guard.check(), { code: "BUDGET_EXCEEDED" });

  // One-tap +$10 for today unblocks check() immediately without changing base dailyUsdLimit
  const afterBonus = guard.addBonusToday(10);
  assert.equal(afterBonus.dailyUsdLimit, 10);
  assert.equal(afterBonus.bonusUsdToday, 10);
  assert.equal(afterBonus.effectiveLimitUsd, 20);
  assert.equal(afterBonus.exceeded, false);
  assert.equal(Number(afterBonus.remainingUsd.toFixed(2)), 9.95);
  assert.doesNotThrow(() => guard.check());

  // Reloading from disk preserves today's bonus
  const reloaded = new BudgetGuard({ storePath: path.join(dir, "usage.json"), dailyUsdLimit: 10, ledger });
  assert.equal(reloaded.status().bonusUsdToday, 10);
  assert.doesNotThrow(() => reloaded.check());

  // Permanent daily limit change updates effectiveLimitUsd immediately
  const afterLimit = reloaded.setDailyLimit(25);
  assert.equal(afterLimit.dailyUsdLimit, 25);
  assert.equal(afterLimit.effectiveLimitUsd, 35);

  const afterClear = reloaded.clearBonusToday();
  assert.equal(afterClear.bonusUsdToday, 0);
  assert.equal(afterClear.effectiveLimitUsd, 25);
});

test("GET /budget and POST /budget are mobile-scoped, main-routed, update live runtime, and persist .env", async (t) => {
  assert.equal(isMobileRouteAllowed("GET", "/budget"), true);
  assert.equal(isMobileRouteAllowed("POST", "/budget"), true);
  assert.equal(isMainDataRoute("GET", "/budget"), true);
  assert.equal(isMainDataRoute("POST", "/budget"), true);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-http-"));
  const prevDataDir = process.env.OPENAGI_DATA_DIR;
  const prevLimit = process.env.OPENAGI_DAILY_USD_LIMIT;
  const prevTz = process.env.OPENAGI_TIMEZONE;
  process.env.OPENAGI_DATA_DIR = dataDir;
  process.env.OPENAGI_DAILY_USD_LIMIT = "10";
  delete process.env.OPENAGI_TIMEZONE;

  let app;
  let runtime;
  t.after(async () => {
    if (app?.close) await app.close();
    for (const store of [runtime?.observations, runtime?.vectorStore, runtime?.sessionIndex]) store?.db?.close();
    if (prevDataDir === undefined) delete process.env.OPENAGI_DATA_DIR;
    else process.env.OPENAGI_DATA_DIR = prevDataDir;
    if (prevLimit === undefined) delete process.env.OPENAGI_DAILY_USD_LIMIT;
    else process.env.OPENAGI_DAILY_USD_LIMIT = prevLimit;
    if (prevTz === undefined) delete process.env.OPENAGI_TIMEZONE;
    else process.env.OPENAGI_TIMEZONE = prevTz;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  runtime = createDurableRuntime({
    dataDir,
    registerDefaults: false,
    integrations: false,
    skills: false,
    autoConnectMcp: false
  });
  runtime.budget.recordUsd(10.2, "gpt-6.2-sol");
  const registry = new NodeRegistry({ dir: path.join(dataDir, "nodes") });
  const nodeId = "mobile:budget-phone-test";
  const mobileToken = "m".repeat(43);
  registry.enroll(nodeId, mobileToken, { platform: "mobile", name: "Peri" });

  app = createHostedInterface(runtime, {
    dataDir,
    nodeRegistry: registry,
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0,
    authToken: "test-owner-token-budget-12345",
    nodeControlEnabled: false
  });
  const { url: baseUrl } = await app.listen();
  const headers = {
    authorization: `Bearer ${mobileToken}`,
    "x-openagi-node-id": nodeId,
    "content-type": "application/json"
  };

  const initial = await fetch(`${baseUrl}/budget`, { headers }).then((r) => r.json());
  assert.equal(initial.exceeded, true);
  assert.equal(initial.dailyUsdLimit, 10);

  const badRes = await fetch(`${baseUrl}/budget`, {
    method: "POST",
    headers,
    body: JSON.stringify({ dailyUsdLimit: -5 })
  });
  assert.equal(badRes.status, 400);

  const topupRes = await fetch(`${baseUrl}/budget`, {
    method: "POST",
    headers,
    body: JSON.stringify({ addUsdToday: 10 })
  });
  assert.equal(topupRes.status, 200);
  const topped = await topupRes.json();
  assert.equal(topped.exceeded, false);
  assert.equal(topped.bonusUsdToday, 10);
  assert.doesNotThrow(() => runtime.budget.check());

  const saveLimitRes = await fetch(`${baseUrl}/budget`, {
    method: "POST",
    headers,
    body: JSON.stringify({ dailyUsdLimit: 50, resetTodayBonus: true })
  });
  assert.equal(saveLimitRes.status, 200);
  const saved = await saveLimitRes.json();
  assert.equal(saved.dailyUsdLimit, 50);
  assert.equal(saved.bonusUsdToday, 0);
  const envRaw = fs.readFileSync(path.join(dataDir, ".env"), "utf8");
  assert.match(envRaw, /OPENAGI_DAILY_USD_LIMIT=50/);

  // Client X-OpenAGI-Timezone header syncs BudgetGuard timezone on GET /budget
  runtime.budget._explicitTimeZone = null;
  runtime.budget.timeZone = "UTC";
  const tzSyncRes = await fetch(`${baseUrl}/budget`, {
    headers: { ...headers, "x-openagi-timezone": "America/Los_Angeles" }
  }).then((r) => r.json());
  assert.equal(tzSyncRes.timeZone, "America/Los_Angeles");
  assert.equal(runtime.budget.timeZone, "America/Los_Angeles");

  // Explicit timeZone in POST /budget persists OPENAGI_TIMEZONE
  const explicitTzRes = await fetch(`${baseUrl}/budget`, {
    method: "POST",
    headers,
    body: JSON.stringify({ timeZone: "America/New_York" })
  }).then((r) => r.json());
  assert.equal(explicitTzRes.timeZone, "America/New_York");
  assert.match(fs.readFileSync(path.join(dataDir, ".env"), "utf8"), /OPENAGI_TIMEZONE=America\/New_York/);
});

test("Recent unarchived sleeping Paseo chats (status=closed) stay visible, retain open questions, and skip auto-nudges", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-sleeping-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const recentIso = new Date(Date.now() - 20 * 60_000).toISOString();
  const oldIso = new Date(Date.now() - 10 * 24 * 3600_000).toISOString();
  let chatStatus = "idle";
  const agents = [
    {
      id: "recent-sleeping",
      title: "Intruder Production Sync Follow-Through",
      get status() { return chatStatus; },
      updatedAt: recentIso,
      archivedAt: null,
      cwd: "/home/dev/paseo/worktrees/bbapp/intruder-sync",
      workspaceId: "wks_abc123",
      provider: "codex"
    },
    {
      id: "sleeping-wip",
      title: "WIP Bob Thread",
      status: "closed",
      updatedAt: recentIso,
      archivedAt: null,
      cwd: "/home/dev/paseo/worktrees/bob/wip",
      workspaceId: "wks_wip123",
      provider: "codex"
    },
    {
      id: "old-sleeping",
      title: "Ancient unloaded thread",
      status: "closed",
      updatedAt: oldIso,
      archivedAt: null,
      cwd: "/home/dev/paseo/worktrees/bbapp/ancient",
      workspaceId: "wks_def456",
      provider: "codex"
    },
    {
      id: "archived-recent",
      title: "Explicitly archived thread",
      status: "closed",
      updatedAt: recentIso,
      archivedAt: recentIso,
      cwd: "/home/dev/paseo/worktrees/bbapp/done",
      workspaceId: "wks_999999",
      provider: "codex"
    }
  ];

  const client = {
    connect: async () => {},
    close: async () => {},
    hosts: {
      list: async () => ({ self: { serverId: "srv_local" }, hosts: [] }),
      client: async () => client
    },
    agents: {
      list: async () => ({
        entries: agents.filter((a) => !a.archivedAt).map((agent) => ({ agent: { ...agent, status: agent.status } })),
        pageInfo: { hasMore: false }
      }),
      ref: (id) => ({
        timeline: {
          refetch: async () => ({
            agent: { ...agents.find((a) => a.id === id), status: agents.find((a) => a.id === id).status },
            entries: id === "sleeping-wip"
              ? [
                  { timestamp: recentIso, item: { type: "user_message", text: "Keep going until all tests pass." } },
                  { timestamp: recentIso, item: { type: "assistant_message", text: "Next step: run the remaining integration tests." } }
                ]
              : [
                  { timestamp: recentIso, item: { type: "user_message", text: "Check Intruder sync." } },
                  { timestamp: recentIso, item: { type: "assistant_message", text: "Should I run the production migration?" } }
                ]
          })
        }
      })
    }
  };

  const source = createPaseoSource({ factory: () => client });
  // Simulate Paseo unloading the worker immediately (`status = "closed"`, `archivedAt = null`)
  chatStatus = "closed";
  const rows = await source({ paseo: { enabled: true, historyPerScan: 10 }, lookbackHours: 48 });
  const recentRow = rows.find((r) => r.id === "recent-sleeping");
  const oldRow = rows.find((r) => r.id === "old-sleeping");
  assert.equal(recentRow.excluded, null, "recent unarchived closed Paseo chat is scanned, not dropped");
  assert.equal(recentRow.agentStatus, "idle");
  assert.equal(recentRow.meta.paseoClosed, true);
  assert.match(recentRow.lastAgentText, /Should I run the production migration\?/);
  assert.equal(oldRow.excluded, "closed", "old closed Paseo chat outside lookback stays excluded");

  let deliverCalls = 0;
  const sup = new FleetSupervisor({
    dataDir: dir,
    config: resolveFleetConfig({}, {
      enabled: true,
      mode: "auto",
      lookbackHours: 48,
      paseo: { enabled: true, only: true, historyPerScan: 10 },
      review: { enabled: false },
      storage: { enabled: false }
    }),
    deps: {
      listPaseoThreads: (cfg) => source(cfg),
      deliver: async () => { deliverCalls += 1; return { status: "sent", route: "paseo-send" }; },
      run: async () => ({ code: 1, stdout: "", stderr: "" })
    }
  });

  await sup.tick("scan-sleeping-1");
  const openQuestions = sup.store.openQuestions().filter((q) => q.threadKey === "paseo:srv_local.recent-sleeping");
  assert.equal(openQuestions.length, 1, "agent question in sleeping unarchived Paseo chat surfaces to Needs You");
  assert.equal(deliverCalls, 0, "automated background nudges never wake unloaded Paseo sessions");
});

test("deriveProjectInfo rejects opaque hex imported-history and codex-worktrees hashes", () => {
  const imported = deriveProjectInfo({
    cwd: "/home/dev/.paseo/imported-history/bff097fc034e75e02608",
    workspace: "wks_019a2233",
    projectName: "Imported history"
  });
  assert.equal(imported.name, "unknown");

  const codexRoot = deriveProjectInfo({
    cwd: "/Users/shooby/.paseo/codex-worktrees/6baf",
    workspace: "6baf"
  });
  assert.equal(codexRoot.name, "unknown");

  const realWord = deriveProjectInfo({
    cwd: "/Users/shooby/Dev/cafe",
    workspace: "cafe"
  });
  assert.equal(realWord.name, "cafe");
});
