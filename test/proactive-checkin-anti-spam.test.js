import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostedInterface } from "../src/hosted-interface.js";
import { createDurableRuntime } from "../src/abi-runtime.js";
import { InMemoryAgentStore } from "../src/agent-store.js";
import { FleetSupervisor } from "../src/fleet/supervisor.js";
import { RemoteFleetSupervisor } from "../src/fleet/remote.js";
import { isQuietHour, resolveQuietTimeZone } from "../src/fleet/notify.js";
import {
  countUnansweredProactiveMessages,
  createHubProactiveGuard,
  latestProactiveMessageAtMs,
  reviewProactiveUpdateWithAgent
} from "../src/fleet/proactive-gate.js";

function makeTmpDir(t, prefix = "proactive-antispam-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("isQuietHour: timezone-aware overnight wrap works for integer hours and HH:MM strings", () => {
  // 2026-11-25T09:00:00Z = 01:00 PST (America/Los_Angeles) -> quiet!
  const pst1am = new Date("2026-11-25T09:00:00.000Z");
  // 2026-11-25T16:30:00Z = 08:30 PST -> awake!
  const pst830am = new Date("2026-11-25T16:30:00.000Z");
  // 2026-11-25T05:30:00Z = 21:30 PST -> awake!
  const pst930pm = new Date("2026-11-25T05:30:00.000Z");
  // 2026-11-25T06:00:00Z = 22:00 PST -> quiet!
  const pst10pm = new Date("2026-11-25T06:00:00.000Z");

  assert.equal(isQuietHour(pst1am, { start: 22, end: 8 }, "America/Los_Angeles"), true);
  assert.equal(isQuietHour(pst1am, { start: "22:00", end: "08:00" }, "America/Los_Angeles"), true);
  assert.equal(isQuietHour(pst1am, { start: 22, end: 8 }, "UTC"), false, "09:00 UTC is not quiet in UTC");
  assert.equal(isQuietHour(pst830am, { start: "22:00", end: "08:00" }, "America/Los_Angeles"), false);
  assert.equal(isQuietHour(pst930pm, { start: "22:00", end: "08:00" }, "America/Los_Angeles"), false);
  assert.equal(isQuietHour(pst10pm, { start: "22:00", end: "08:00" }, "America/Los_Angeles"), true);
  assert.equal(isQuietHour(pst1am, false, "America/Los_Angeles"), false);
  assert.equal(isQuietHour(pst1am, [0, 0], "America/Los_Angeles"), false);

  assert.equal(resolveQuietTimeZone({ budget: { timeZone: "America/Los_Angeles" } }, null, {}), "America/Los_Angeles");
  assert.equal(resolveQuietTimeZone(null, { notify: { timeZone: "America/New_York" } }, {}), "America/New_York");
});

test("FleetSupervisor live daemon respects default quiet hours in owner timezone and defers without surfacing", async (t) => {
  const dir = makeTmpDir(t, "sup-quiet-");
  const pst2am = Date.parse("2026-11-25T10:00:00.000Z"); // 02:00 PST (10:00 UTC)
  const pst9am = Date.parse("2026-11-25T17:00:00.000Z"); // 09:00 PST (17:00 UTC)
  let nowMs = pst2am;
  const msgs = [];
  const store = {
    sessions: new Map([["devices:supervisor:main", { id: "devices:supervisor:main", messages: [] }]]),
    getSession(id) { return this.sessions.get(id) ?? { id, messages: [] }; },
    appendMessage(id, m) {
      const s = this.sessions.get(id) ?? { id, messages: [] };
      this.sessions.set(id, s);
      const entry = { id: m.id ?? `m_${s.messages.length + 1}`, role: m.role, content: m.content ?? m.text, createdAt: m.createdAt, metadata: m.metadata ?? {} };
      s.messages.push(entry);
      msgs.push(entry);
      return s;
    }
  };
  const sup = new FleetSupervisor({
    dataDir: dir,
    runtime: { events: { emit() {} }, agentHost: { store }, budget: { timeZone: "America/Los_Angeles" } },
    config: { enabled: true, mode: "auto", proactiveSupervisorChat: true },
    deps: {
      now: () => nowMs,
      judgeProactiveUpdate: async () => ({ send: true, message: "Morning heads-up: PR #77 is ready for your merge call." })
    }
  });
  // Simulate live daemon timer active (so default quiet hours apply automatically).
  sup.timer = {};
  const th = {
    key: "paseo:srv_local.q1",
    kind: "paseo",
    title: "Release PR #77",
    agentStatus: "idle",
    lastAgentText: "CI green on PR #77. Ready to merge?",
    prRefs: ["acme/app#77"],
    meta: { serverId: "srv_local", isLocalHost: true }
  };
  sup.lastThreads.set(th.key, th);
  sup.store.upsertQuestion({
    dedupeKey: "ready:acme/app#77",
    kind: "ready",
    mergeAsk: true,
    threadKey: th.key,
    prRef: "acme/app#77",
    title: "PR #77 ready to merge?",
    options: ["Merge", "Hold"],
    contextSnapshot: { threadTitle: "Release PR #77", recentMessages: [{ role: "user", text: "Finish PR #77" }, { role: "assistant", text: th.lastAgentText }] }
  });

  // At 02:00 PST (even on a UTC server), live daemon defers and leaves decision pending.
  const quietRes = await sup.maybePostProactiveSupervisorDigest({ started: nowMs });
  assert.equal(quietRes.posted, false);
  assert.equal(quietRes.deferred, true);
  assert.equal(quietRes.reason, "quiet_hours");
  assert.equal(msgs.length, 0);
  assert.equal(sup.store.diffSurfacedDecisions(sup.store.openQuestions(), { now: nowMs }).deltas.length, 1);

  // At 09:00 PST, quiet hours are over and the decision posts cleanly.
  nowMs = pst9am;
  const awakeRes = await sup.maybePostProactiveSupervisorDigest({ started: nowMs });
  assert.equal(awakeRes.posted, true);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].content, /PR #77/);
});

test("reviewProactiveUpdateWithAgent fails closed on LLM error / unparseable JSON / failClosed missing provider, without blocking follow_through_verification", async () => {
  const failingProvider = {
    name: "openai",
    isConfigured: () => true,
    async generate() { throw new Error("503 overloaded"); }
  };
  const errVerdict = await reviewProactiveUpdateWithAgent({
    candidateText: "**Supervisor check-in: one decision needs you.**",
    kind: "proactive_supervisor_delta",
    modelProvider: failingProvider
  });
  assert.equal(errVerdict.send, false);
  assert.equal(errVerdict.deferred, true);
  assert.equal(errVerdict.reason, "agent_review_error");

  const garbageProvider = {
    name: "openai",
    isConfigured: () => true,
    async generate() { return { text: "sorry, not valid json" }; }
  };
  const badJsonVerdict = await reviewProactiveUpdateWithAgent({
    candidateText: "**Supervisor check-in: one decision needs you.**",
    kind: "proactive_supervisor_delta",
    modelProvider: garbageProvider
  });
  assert.equal(badJsonVerdict.send, false);
  assert.equal(badJsonVerdict.deferred, true);
  assert.equal(badJsonVerdict.reason, "unparseable_agent_verdict");

  const noProvFailClosed = await reviewProactiveUpdateWithAgent({
    candidateText: "**Supervisor check-in: one decision needs you.**",
    kind: "proactive_supervisor_delta",
    modelProvider: null,
    failClosed: true
  });
  assert.equal(noProvFailClosed.send, false);
  assert.equal(noProvFailClosed.deferred, true);
  assert.equal(noProvFailClosed.reason, "no_live_model_provider");

  // Follow-through error alerts still fall back cleanly if LLM is down.
  const ftwFallback = await reviewProactiveUpdateWithAgent({
    candidateText: "**Post-send verification — Build hit a session error**",
    kind: "follow_through_verification",
    modelProvider: failingProvider,
    failClosed: true
  });
  assert.equal(ftwFallback.send, true);
});

test("hubProactiveGuard enforces quiet hours, unanswered owner reply cap, quiet_until_ready decisionKinds, review backoff, and restart timestamp recovery", async () => {
  let nowMs = Date.parse("2026-11-25T09:00:00.000Z"); // 01:00 PST
  const history = [];
  let prefs = { cadence: "quiet_until_ready", checkinCooldownMinutes: 20 };
  let providerCalls = 0;
  let shouldFail = false;
  const provider = {
    name: "openai",
    isConfigured: () => true,
    async generate() {
      providerCalls += 1;
      if (shouldFail) throw new Error("upstream 502");
      return { text: JSON.stringify({ send: true, reason: "actionable", message: "Heads-up: PR #900 is green and ready for your merge call." }) };
    }
  };

  const guard = createHubProactiveGuard({
    getPreferences: () => prefs,
    getRecentMessages: () => history,
    getModelProvider: () => provider,
    getLastPostedAtMs: () => latestProactiveMessageAtMs(history, { nowMs }),
    getQuietHours: () => ({ start: "22:00", end: "08:00" }),
    getTimeZone: () => "America/Los_Angeles",
    getMaxUnansweredProactive: (p) => (p?.cadence === "detailed" ? 2 : 1),
    failClosed: true,
    now: () => nowMs
  });

  // 1. Diverged paired node ("balanced") sends routine agent-ask while hub is quiet_until_ready -> suppressed centrally!
  const routineRes = await guard.evaluate({
    text: "**Supervisor check-in: one decision needs you.**\nRoutine ask",
    decisionKeys: ["ask:routine"],
    decisionKinds: ["agent-ask"]
  });
  assert.equal(routineRes.send, false);
  assert.equal(routineRes.reason, "cadence_quiet_until_ready");
  assert.equal(providerCalls, 0);

  // 2. Merge-ready ask at 01:00 PST -> deferred by quiet hours without calling LLM or committing dedupe!
  const quietRes = await guard.evaluate({
    text: "**Supervisor check-in: one decision needs you.**\nPR #900 ready",
    decisionKeys: ["ready:repo#900"],
    decisionTokens: ["ready:repo#900:sha1"],
    decisionKinds: ["ready"]
  });
  assert.equal(quietRes.send, false);
  assert.equal(quietRes.deferred, true);
  assert.equal(quietRes.reason, "quiet_hours");
  assert.equal(providerCalls, 0);

  // 3. At 09:00 PST, LLM errors -> fails closed + deferred, AND next retry 30s later hits 5m backoff!
  nowMs = Date.parse("2026-11-25T17:00:00.000Z"); // 09:00 PST
  shouldFail = true;
  const errRes = await guard.evaluate({
    text: "**Supervisor check-in: one decision needs you.**\nPR #900 ready",
    decisionKeys: ["ready:repo#900"],
    decisionTokens: ["ready:repo#900:sha1"],
    decisionKinds: ["ready"]
  });
  assert.equal(errRes.send, false);
  assert.equal(errRes.deferred, true);
  assert.equal(errRes.reason, "agent_review_error");
  assert.equal(providerCalls, 1);

  nowMs += 30_000;
  const backoffRes = await guard.evaluate({
    text: "**Supervisor check-in: one decision needs you.**\nPR #900 ready",
    decisionKeys: ["ready:repo#900"],
    decisionTokens: ["ready:repo#900:sha1"],
    decisionKinds: ["ready"]
  });
  assert.equal(backoffRes.send, false);
  assert.equal(backoffRes.deferred, true);
  assert.equal(backoffRes.reason, "agent_review_backoff");
  assert.equal(providerCalls, 1, "backoff avoided hammering failing provider");

  // 4. After 6 minutes, LLM recovers -> exact same decision (never prematurely deduped!) succeeds!
  nowMs += 6 * 60_000;
  shouldFail = false;
  const posted = await guard.evaluate({
    text: "**Supervisor check-in: one decision needs you.**\nPR #900 ready",
    decisionKeys: ["ready:repo#900"],
    decisionTokens: ["ready:repo#900:sha1"],
    decisionKinds: ["ready"],
    persist: async (finalText, { agentReviewed }) => {
      history.push({
        id: "m1",
        role: "assistant",
        content: finalText,
        createdAt: new Date(nowMs).toISOString(),
        metadata: { proactive: true, proactiveMeta: { kind: "proactive_supervisor_delta", agentReviewed } }
      });
      return { ok: true };
    }
  });
  assert.equal(posted.send, true);
  assert.equal(countUnansweredProactiveMessages(history), 1);

  // 5. Even 2 hours later (past cooldown), a second decision is deferred until Spencer replies!
  nowMs += 2 * 60 * 60_000;
  const awaitingRes = await guard.evaluate({
    text: "**Supervisor check-in: one decision needs you.**\nPR #901 ready",
    decisionKeys: ["ready:repo#901"],
    decisionTokens: ["ready:repo#901:sha1"],
    decisionKinds: ["ready"]
  });
  assert.equal(awaitingRes.send, false);
  assert.equal(awaitingRes.deferred, true);
  assert.equal(awaitingRes.reason, "awaiting_owner_reply");

  // 6. Follow-through verification bypasses unanswered cap & quiet hours!
  const ftw = await guard.evaluate({
    text: "**Post-send verification — PR #900 hit a session error**",
    kind: "follow_through_verification",
    persist: async (finalText) => {
      history.push({
        id: "m_ftw",
        role: "assistant",
        content: finalText,
        createdAt: new Date(nowMs).toISOString(),
        metadata: { proactive: true, proactiveMeta: { kind: "follow_through_verification" } }
      });
      return { ok: true };
    }
  });
  assert.equal(ftw.send, true);

  // 7. Once Spencer replies in chat, unanswered count resets to 0 and PR #901 can post!
  history.push({ id: "u1", role: "user", content: "Merge #900 please", createdAt: new Date(nowMs + 1000).toISOString() });
  assert.equal(countUnansweredProactiveMessages(history), 0);
  const afterReply = await guard.evaluate({
    text: "**Supervisor check-in: one decision needs you.**\nPR #901 ready",
    decisionKeys: ["ready:repo#901"],
    decisionTokens: ["ready:repo#901:sha1"],
    decisionKinds: ["ready"]
  });
  assert.equal(afterReply.send, true);

  // 8. Simulated hub restart recovers lastPostedAtMs directly from persisted history!
  assert.equal(latestProactiveMessageAtMs(history, { nowMs }), Date.parse(history[0].createdAt));
});

test("RemoteFleetSupervisor persists lastReportedPreferences across restarts for hub proactive gating", (t) => {
  const dir = makeTmpDir(t, "remote-prefs-");
  const nodeId = "node-bb3";
  const r1 = new RemoteFleetSupervisor({ runtime: {}, nodeId, dataDir: dir });
  r1.noteReportedPreferences({ cadence: "quiet_until_ready", checkinCooldownMinutes: 90, checkinFormat: "Bullets only" });

  // New instance after hub restart loads cached preferences immediately before first poll.
  const r2 = new RemoteFleetSupervisor({ runtime: {}, nodeId, dataDir: dir });
  assert.equal(r2.getState().preferences?.cadence, "quiet_until_ready");
  assert.equal(r2.getState().preferences?.checkinCooldownMinutes, 90);
  assert.equal(r2.getState().preferences?.checkinFormat, "Bullets only");

  // Different nodeId does not inherit another node's cached preferences.
  const rOther = new RemoteFleetSupervisor({ runtime: {}, nodeId: "node-other", dataDir: dir });
  assert.equal(rOther.reportedPreferences, null);
  assert.equal(rOther.getState().preferences?.cadence, "balanced");
  assert.equal(rOther.getState().preferences?.checkinCooldownMinutes, null);
});

test("POST /conversations/supervisor/append on hosted-interface enforces quiet hours, unanswered cap, fail-closed review, and marks proactiveGuarded=true", async (t) => {
  const dataDir = makeTmpDir(t, "hosted-proactive-");
  const runtime = createDurableRuntime({ dataDir });
  const store = new InMemoryAgentStore();
  let nowMs = Date.parse("2026-11-25T10:00:00.000Z"); // 02:00 PST
  runtime.agentHost = {
    store,
    modelProvider: {
      name: "openai",
      isConfigured: () => true,
      async generate() {
        return { text: JSON.stringify({ send: true, reason: "clear", message: "PR #555 is green and ready to merge." }) };
      }
    },
    handleMessage: async () => ({ reply: "ok", session: { id: "devices:supervisor:main" } })
  };
  const app = createHostedInterface(runtime, {
    dataDir,
    port: 0,
    authToken: "",
    proactiveTimeZone: "America/Los_Angeles",
    proactiveNow: () => nowMs
  });
  t.after(async () => { await app.close(); await runtime.observations?.close?.(); });
  const { url } = await app.listen();

  const postCheckin = (id, key) => fetch(`${url}/conversations/supervisor/append`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      conversationId: "main",
      messages: [{
        id,
        role: "assistant",
        text: `**Supervisor check-in: one decision needs you.**\n${key}`,
        at: new Date(nowMs).toISOString(),
        proactive: true,
        proactiveMeta: { kind: "proactive_supervisor_delta", decisionKeys: [key], decisionKinds: ["ready"] }
      }]
    })
  }).then((r) => r.json());

  // 02:00 PST -> deferred by quiet hours, proactiveGuarded=true
  const q1 = await postCheckin("msg_q1", "ready:r#555");
  assert.equal(q1.suppressed, true);
  assert.equal(q1.deferred, true);
  assert.equal(q1.reason, "quiet_hours");
  assert.equal(q1.proactiveGuarded, true);

  // 09:00 PST -> approved and rewritten by agent
  nowMs = Date.parse("2026-11-25T17:00:00.000Z");
  const p1 = await postCheckin("msg_q1", "ready:r#555");
  assert.equal(p1.proactiveGuarded, true);
  assert.equal(p1.appended.length, 1);
  assert.equal(p1.appended[0].text, "PR #555 is green and ready to merge.");

  // 11:00 PST (2h later, still no user reply) -> deferred by awaiting_owner_reply!
  nowMs = Date.parse("2026-11-25T19:00:00.000Z");
  const p2 = await postCheckin("msg_q2", "ready:r#556");
  assert.equal(p2.suppressed, true);
  assert.equal(p2.deferred, true);
  assert.equal(p2.reason, "awaiting_owner_reply");
  assert.equal(p2.proactiveGuarded, true);
});
