import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FleetSupervisor } from "../src/fleet/supervisor.js";
import { paseoThread } from "../src/fleet/sources/paseo.js";
import { failoverPaseoSessionProvider, titlesMatchForFailover } from "../src/fleet/paseo-delivery.js";

function withTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nudge-failover-dedupe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeIdleThread({
  key = "paseo:srv_bb3.fd938468",
  id = "fd938468",
  serverId = "srv_bb3",
  title = "🧭 AppFolio Rubric Expectations Review",
  lastUserAt,
  lastAgentAt,
  lastAgentText,
  isLocalHost = true
}) {
  return {
    key,
    kind: "paseo",
    id,
    title,
    workspace: "buildbetter",
    repo: "buildbetter-app/buildbetter",
    branch: "main",
    agentStatus: "idle",
    archived: false,
    excluded: null,
    lastActivityAt: lastAgentAt,
    lastUserAt,
    lastUserText: "Generate and verify AppFolio Lifecycles report via buildbetter-staging MCP.",
    lastAgentAt,
    lastAgentText,
    lastAgentFull: lastAgentText,
    prRefs: [],
    meta: {
      serverId,
      isLocalHost,
      paseoCwd: "/home/dev/buildbetter",
      provider: "claude",
      requiresAttention: true,
      attentionReason: "finished",
      historyKnown: true,
      conversation: [
        { role: "user", text: "Generate and verify AppFolio Lifecycles report via buildbetter-staging MCP.", at: lastUserAt },
        { role: "assistant", text: lastAgentText, at: lastAgentAt }
      ]
    }
  };
}

test("titlesMatchForFailover matches original titles with emojis against Paseo 'Continue ...' titles", () => {
  assert.equal(titlesMatchForFailover("ZeroShot — iteration review", "Continue ZeroShot iteration review"), true);
  assert.equal(titlesMatchForFailover("🦉 Intruder Production Sync Follow-Through", "Continue Intruder production sync follow-through"), true);
  assert.equal(titlesMatchForFailover("🎙️ Stream Call Audio to GPT Live", "Continue Stream Call Audio to GPT Live"), true);
  assert.equal(titlesMatchForFailover("📜 Two-Week CEO Update Draft", "📜 Two-Week CEO Update Draft"), true);
  assert.equal(titlesMatchForFailover("ZeroShot — iteration review", "Unrelated Billing Migration"), false);
});

test("goal-continuation stops at maxNudgesWithoutProgress (attemptsWithoutProgress) and records non-null messageHash", async (t) => {
  const dir = withTempDir(t);
  let nowMs = Date.parse("2026-11-24T04:00:00.000Z");
  const delivered = [];
  let thread = makeIdleThread({
    key: "paseo:srv_bb3.sess_cap",
    id: "sess_cap",
    title: "Batch migration",
    lastUserAt: "2026-11-24T03:00:00.000Z",
    lastAgentAt: "2026-11-24T03:30:00.000Z",
    lastAgentText: "Processed batch 1."
  });

  const sup = new FleetSupervisor({
    dataDir: dir,
    runtime: { events: { emit() {} } },
    config: {
      enabled: true,
      mode: "auto",
      paseo: { enabled: true, only: true },
      review: { enabled: false },
      decisions: { enabled: false },
      limits: { nudgeCooldownMs: 10 * 60_000, maxNudgesWithoutProgress: 2 }
    },
    deps: {
      now: () => nowMs,
      listPaseoThreads: async () => [thread],
      fetchPrStates: async () => new Map(),
      executor: {
        deliver: async (args) => {
          delivered.push(args);
          return { status: "sent", route: args.route, detail: "ok" };
        },
        inFlight: () => [],
        whenIdle: async () => {}
      }
    }
  });
  sup.knownThreads.set(thread.key, thread);
  sup.trackWork({
    project: "app",
    goal: "Migrate all 20 tables",
    doneCriteria: "All 20 tables migrated",
    threadKey: thread.key,
    permittedNudges: "resume_owner"
  });

  // Simulate 5 ticks 20 minutes apart with the agent replying verbally without progress.
  for (let i = 0; i < 5; i += 1) {
    await sup._tick("timer");
    nowMs += 20 * 60_000;
    const replyIso = new Date(nowMs - 5 * 60_000).toISOString();
    thread = {
      ...thread,
      lastActivityAt: replyIso,
      lastAgentAt: replyIso,
      lastAgentText: `Still working on batch ${i + 2}.`,
      lastAgentFull: `Still working on batch ${i + 2}.`
    };
  }

  const goalNudges = delivered.filter((d) => d.playbook === "goal-continuation");
  assert.equal(goalNudges.length, 2, "hard-stops at maxNudgesWithoutProgress instead of looping forever");
  const ledger = sup.store.ledgerFor(thread.key);
  assert.equal(ledger.attemptsWithoutProgress, 2);
  assert.ok(ledger.nudges.every((n) => typeof n.messageHash === "string" && n.messageHash.length > 0), "every nudge stores a non-null messageHash");
});

test("fd938468 loop: agent reporting Definition of Done met via buildbetter-staging gets 0 nudges and switches goal to awaitingFollowup", async (t) => {
  const dir = withTempDir(t);
  let nowMs = Date.parse("2026-11-24T05:00:00.000Z");
  const delivered = [];
  const thread = makeIdleThread({
    key: "paseo:srv_4x2crHynU7yi.fd938468-c615-4aa5-821a-29d50ec616db",
    id: "fd938468-c615-4aa5-821a-29d50ec616db",
    serverId: "srv_4x2crHynU7yi",
    title: "🧭 AppFolio Rubric Expectations Review",
    lastUserAt: "2026-11-24T02:18:00.000Z",
    lastAgentAt: "2026-11-24T04:50:00.000Z",
    lastAgentText: "The Definition of Done is met. Generated through buildbetter-staging MCP (Revision 3 at https://app-staging.buildbetter.app/reports/123). All sections are populated with zero gaps. The goal is met — nothing left to run."
  });

  const sup = new FleetSupervisor({
    dataDir: dir,
    runtime: { events: { emit() {} } },
    config: {
      enabled: true,
      mode: "auto",
      paseo: { enabled: true, only: true },
      review: { enabled: false },
      decisions: { enabled: false },
      limits: { nudgeCooldownMs: 10 * 60_000, maxNudgesWithoutProgress: 3 }
    },
    deps: {
      now: () => nowMs,
      listPaseoThreads: async () => [thread],
      fetchPrStates: async () => new Map(),
      executor: {
        deliver: async (args) => {
          delivered.push(args);
          return { status: "sent", route: args.route, detail: "ok" };
        },
        inFlight: () => [],
        whenIdle: async () => {}
      }
    }
  });
  sup.knownThreads.set(thread.key, thread);
  sup.trackWork({
    project: "buildbetter",
    goal: "Generate and verify AppFolio Lifecycles & Rubric Expectations report via buildbetter-staging MCP",
    doneCriteria: "Report generated and verified with zero gaps",
    threadKey: thread.key,
    permittedNudges: "resume_owner"
  });

  await sup._tick("timer");
  nowMs += 20 * 60_000;
  await sup._tick("timer");

  assert.equal(delivered.length, 0, "neither prec_appfolio_staging_mcp nor goal-continuation fires once agent reports completion via buildbetter-staging");
  assert.equal(sup.activeWork.state.items[0].awaitingFollowup, true, "goal transitions to awaitingFollowup for owner sign-off");
});

test("precedent nudge fires at most once per owner turn even if agent keeps mentioning the same error", async (t) => {
  const dir = withTempDir(t);
  let nowMs = Date.parse("2026-11-24T05:00:00.000Z");
  const delivered = [];
  let thread = makeIdleThread({
    key: "paseo:srv_bb3.appfolio_blocked",
    id: "appfolio_blocked",
    title: "🧭 AppFolio Rubric Expectations Review",
    lastUserAt: "2026-11-24T04:00:00.000Z",
    lastAgentAt: "2026-11-24T04:40:00.000Z",
    lastAgentText: "Blocked: production BuildBetter MCP workspace returned no result for AppFolio Lifecycles create_report."
  });

  const sup = new FleetSupervisor({
    dataDir: dir,
    runtime: { events: { emit() {} } },
    config: {
      enabled: true,
      mode: "auto",
      paseo: { enabled: true, only: true },
      review: { enabled: false },
      decisions: { enabled: false },
      limits: { nudgeCooldownMs: 10 * 60_000, maxNudgesWithoutProgress: 3 }
    },
    deps: {
      now: () => nowMs,
      listPaseoThreads: async () => [thread],
      fetchPrStates: async () => new Map(),
      executor: {
        deliver: async (args) => {
          delivered.push(args);
          return { status: "sent", route: args.route, detail: "ok" };
        },
        inFlight: () => [],
        whenIdle: async () => {}
      }
    }
  });

  await sup._tick("timer");
  nowMs += 20 * 60_000;
  thread = { ...thread, lastAgentAt: new Date(nowMs - 2 * 60_000).toISOString(), lastActivityAt: new Date(nowMs - 2 * 60_000).toISOString() };
  await sup._tick("timer");
  nowMs += 20 * 60_000;
  thread = { ...thread, lastAgentAt: new Date(nowMs - 2 * 60_000).toISOString(), lastActivityAt: new Date(nowMs - 2 * 60_000).toISOString() };
  await sup._tick("timer");

  const precNudges = delivered.filter((d) => d.playbook === "precedent:prec_appfolio_staging_mcp");
  assert.equal(precNudges.length, 1, "same precedent directive is only sent once without a new owner turn");
});

test("remote Paseo host threads (isLocalHost: false) are never autonomously failed over or nudged by a peer supervisor", async (t) => {
  const dir = withTempDir(t);
  const nowMs = Date.parse("2026-11-24T07:15:00.000Z");
  const delivered = [];
  const created = [];

  const remoteQuotaAgent = {
    id: "661fed6f-remote",
    title: "OpenAGI — train custom small model (Nikhil)",
    status: "error",
    provider: "codex/gpt-6.2-sol",
    cwd: "/home/dev/openAGI",
    createdAt: "2026-11-24T06:00:00.000Z",
    updatedAt: "2026-11-24T07:10:00.000Z"
  };
  const remoteEntries = [
    { timestamp: "2026-11-24T07:05:00.000Z", item: { type: "user_message", text: "Train small model." } },
    { timestamp: "2026-11-24T07:10:00.000Z", item: { type: "assistant_message", text: "[System Error] You've hit your usage limit." } }
  ];
  const remoteQuotaThread = paseoThread(remoteQuotaAgent, "srv_4x2crHynU7yi", remoteEntries, true);
  remoteQuotaThread.meta.isLocalHost = false;

  const remoteGoalThread = makeIdleThread({
    key: "paseo:srv_4x2crHynU7yi.remote_goal",
    id: "remote_goal",
    serverId: "srv_4x2crHynU7yi",
    title: "Remote BuildBot3 Goal",
    lastUserAt: "2026-11-24T06:00:00.000Z",
    lastAgentAt: "2026-11-24T06:30:00.000Z",
    lastAgentText: "Blocked: production BuildBetter MCP workspace returned no result for AppFolio Lifecycles create_report.",
    isLocalHost: false
  });

  const factory = () => ({
    connect: async () => {},
    close: async () => {},
    hosts: { list: async () => ({ self: { serverId: "srv_mac" }, hosts: [{ serverId: "srv_4x2crHynU7yi", enabled: true, status: "online" }] }) },
    agents: {
      ref: () => ({ refresh: async () => {}, current: () => remoteQuotaAgent, timeline: { refetch: async () => ({ entries: remoteEntries }) } }),
      create: async (spec) => { created.push(spec); return { id: "dup-failover" }; }
    },
    providers: {
      waitForReady: async () => ({
        entries: [
          { provider: "codex", status: "ready", models: [{ id: "gpt-6.2-sol", isDefault: true }] },
          { provider: "claude", status: "ready", models: [{ id: "claude-opus-5-5", isDefault: true }] }
        ]
      })
    }
  });

  const sup = new FleetSupervisor({
    dataDir: dir,
    runtime: { events: { emit() {} } },
    config: { enabled: true, mode: "auto", paseo: { enabled: true, only: true }, review: { enabled: false }, decisions: { enabled: false } },
    deps: {
      now: () => nowMs,
      paseoFactory: factory,
      listPaseoThreads: async () => [remoteQuotaThread, remoteGoalThread],
      fetchPrStates: async () => new Map(),
      executor: {
        deliver: async (args) => { delivered.push(args); return { status: "sent", route: args.route, detail: "ok" }; },
        inFlight: () => [],
        whenIdle: async () => {}
      }
    }
  });
  sup.knownThreads.set(remoteGoalThread.key, remoteGoalThread);
  sup.trackWork({
    project: "buildbetter",
    goal: "Finish remote task",
    doneCriteria: "Done",
    threadKey: remoteGoalThread.key,
    permittedNudges: "resume_owner"
  });

  await sup._tick("timer");
  assert.equal(created.length, 0, "peer supervisor must not spawn failover sessions on a remote Paseo host");
  assert.equal(delivered.length, 0, "peer supervisor must not send precedent or goal-continuation nudges to a remote Paseo host");
});

test("auto-failover skips stale >24h historical error sessions and adopts existing continuations instead of creating duplicates", async (t) => {
  const dir = withTempDir(t);
  const nowMs = Date.parse("2026-11-24T07:15:00.000Z");
  const created = [];

  // 1. Two-week-old dead Codex chat with no active goal: must NOT auto-failover.
  const staleAgent = {
    id: "e8dab13d-old",
    title: "ZeroShot — iteration review",
    status: "error",
    provider: "codex/gpt-6.2-sol",
    cwd: "/home/dev/bbapp",
    createdAt: "2026-11-09T21:42:11.000Z",
    updatedAt: "2026-11-09T22:00:00.000Z"
  };
  const staleEntries = [
    { timestamp: "2026-11-09T21:55:00.000Z", item: { type: "user_message", text: "Review ZeroShot." } },
    { timestamp: "2026-11-09T22:00:00.000Z", item: { type: "assistant_message", text: "[System Error] You've hit your usage limit." } }
  ];
  const staleThread = paseoThread(staleAgent, "srv_bb3", staleEntries, true);
  staleThread.meta.isLocalHost = true;

  // 2. Recent quota-blocked session that ALREADY has an active Claude continuation on Paseo.
  const recentSourceAgent = {
    id: "5e12f1c0-src",
    title: "🦉 Intruder Production Sync Follow-Through",
    status: "error",
    provider: "codex/gpt-6.2-sol",
    cwd: "/home/dev/bbapp",
    createdAt: "2026-11-24T04:00:00.000Z",
    updatedAt: "2026-11-24T05:00:00.000Z"
  };
  const recentSourceEntries = [
    { timestamp: "2026-11-24T04:55:00.000Z", item: { type: "user_message", text: "Check Intruder sync." } },
    { timestamp: "2026-11-24T05:00:00.000Z", item: { type: "assistant_message", text: "[System Error] You've hit your usage limit." } }
  ];
  const recentSourceThread = paseoThread(recentSourceAgent, "srv_bb3", recentSourceEntries, true);
  recentSourceThread.meta.isLocalHost = true;

  const existingContinuationAgent = {
    id: "e000858e-existing",
    title: "Continue Intruder production sync follow-through",
    status: "idle",
    provider: "claude",
    model: "claude-opus-5-5",
    cwd: "/home/dev/bbapp",
    createdAt: "2026-11-24T05:02:00.000Z",
    updatedAt: "2026-11-24T05:05:00.000Z"
  };
  const existingContinuationThread = paseoThread(existingContinuationAgent, "srv_bb3", [
    { timestamp: "2026-11-24T05:02:00.000Z", item: { type: "user_message", text: "[OpenAGI supervisor] Automatic provider failover..." } },
    { timestamp: "2026-11-24T05:05:00.000Z", item: { type: "assistant_message", text: "Checked workspace." } }
  ], true);
  existingContinuationThread.meta.isLocalHost = true;

  const factory = () => ({
    connect: async () => {},
    close: async () => {},
    hosts: { list: async () => ({ self: { serverId: "srv_bb3" }, hosts: [] }) },
    agents: {
      list: async () => ({ entries: [{ agent: recentSourceAgent }, { agent: existingContinuationAgent }] }),
      ref: () => ({ refresh: async () => {}, current: () => recentSourceAgent, timeline: { refetch: async () => ({ entries: recentSourceEntries }) } }),
      create: async (spec) => { created.push(spec); return { id: `unexpected-${created.length}` }; }
    },
    providers: {
      waitForReady: async () => ({
        entries: [
          { provider: "codex", status: "ready", models: [{ id: "gpt-6.2-sol", isDefault: true }] },
          { provider: "claude", status: "ready", models: [{ id: "claude-opus-5-5", isDefault: true }] }
        ]
      })
    }
  });

  const sup = new FleetSupervisor({
    dataDir: dir,
    runtime: { events: { emit() {} } },
    config: { enabled: true, mode: "auto", paseo: { enabled: true, only: true }, review: { enabled: false }, decisions: { enabled: false } },
    deps: {
      now: () => nowMs,
      paseoFactory: factory,
      listPaseoThreads: async () => [staleThread, recentSourceThread, existingContinuationThread],
      fetchPrStates: async () => new Map(),
      executor: { deliver: async (a) => ({ status: "sent", route: a.route, detail: "ok" }), inFlight: () => [], whenIdle: async () => {} }
    }
  });

  await sup._tick("timer");
  assert.equal(created.length, 0, "neither the stale 15-day-old session nor the already-continued session spawns a new chat");
  assert.equal(
    sup.store.providerFailoverFor(recentSourceThread.key)?.newKey,
    existingContinuationThread.key,
    "existing continuation is linked in providerFailovers"
  );

  // Also test direct failoverPaseoSessionProvider API-level adoption when called directly.
  const directReuse = await failoverPaseoSessionProvider({
    config: { paseo: { enabled: true, url: "ws://127.0.0.1:6767/ws" } },
    thread: recentSourceThread,
    reason: "usage limit reached",
    factory
  });
  assert.equal(directReuse.ok, true);
  assert.equal(directReuse.reused, true);
  assert.equal(directReuse.newKey, existingContinuationThread.key);
  assert.equal(created.length, 0, "direct failover reuses Paseo's existing continuation without creating a duplicate");
});
