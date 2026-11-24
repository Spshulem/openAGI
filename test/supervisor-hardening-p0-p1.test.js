import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { _resetDataDirCache } from "../src/data-dir.js";
import { FleetStore, actionableDecisionMaterialHash } from "../src/fleet/store.js";
import { FleetSupervisor } from "../src/fleet/supervisor.js";
import { deliverPaseo, isPermanentlyDisconnectedRuntimeError } from "../src/fleet/paseo-delivery.js";
import { startPaseoSession } from "../src/fleet/coordinator.js";
import { paseoThread } from "../src/fleet/sources/paseo.js";
import { createHubProactiveGuard, dedupeDecisionDeltas, isClosedOrContradictoryDecision, isProactiveSupervisorMessage } from "../src/fleet/proactive-gate.js";
import { isSuppressedFromProactiveChat, normalizePreferences, applyPreferencePatch } from "../src/fleet/preferences.js";
import { registerFleetTools } from "../src/fleet/tools.js";
import { imageHistory } from "../src/message-attachments.js";
import { dedupeExactDoubledDictation } from "../src/agent-host.js";
import { isSupervisorActionableDirective, ownerPrincipal } from "../src/owner-authority.js";
import { ToolRegistry, registerCoreTools } from "../src/tool-registry.js";
import { PendingActionStore } from "../src/pending-actions.js";
import { InMemoryAgentStore } from "../src/agent-store.js";

const NOW = Date.parse("2026-11-24T19:00:00.000Z");

function makeTmpDir(t, prefix = "sup-harden-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeChatRuntime(initialMessages = []) {
  const msgs = [...initialMessages];
  const store = {
    sessions: new Map([["devices:supervisor:main", { id: "devices:supervisor:main", messages: [...initialMessages] }]]),
    getSession(id) {
      return this.sessions.get(id) ?? { id, messages: [] };
    },
    appendMessage(id, m) {
      const s = this.sessions.get(id) ?? { id, messages: [] };
      this.sessions.set(id, s);
      const entry = {
        id: m.id ?? `msg_${s.messages.length + 1}`,
        role: m.role,
        content: m.content ?? m.text,
        createdAt: m.createdAt ?? new Date(NOW).toISOString(),
        metadata: m.metadata ?? {}
      };
      s.messages.push(entry);
      msgs.push(entry);
      return s;
    }
  };
  return { msgs, runtime: { events: { emit() {} }, agentHost: { store } } };
}

test("Paseo queueing: busy running session queues durably without creating a clone and drains automatically once idle", async (t) => {
  const dir = makeTmpDir(t, "paseo-queue-");
  let nowMs = NOW;
  const deliveredCalls = [];
  let liveBusy = true;

  const sup = new FleetSupervisor({
    dataDir: dir,
    runtime: { events: { emit() {} } },
    config: { enabled: true, mode: "auto", paseo: { enabled: true, only: true } },
    deps: {
      now: () => nowMs,
      executor: {
        async deliver(opts) {
          deliveredCalls.push(opts);
          if (liveBusy && opts.queue) {
            return { status: "busy", busy: true, route: "paseo-send", detail: "Session is mid-turn" };
          }
          return { status: "sent", route: "paseo-send", actionId: "act_sent_1", messageId: "m_1", verifiedAt: new Date(nowMs).toISOString(), detail: "Paseo message and turn confirmed" };
        }
      }
    }
  });

  const runningThread = {
    key: "paseo:srv_1.agent_busy",
    kind: "paseo",
    id: "agent_busy",
    title: "PR #325 Active Work",
    workspace: "openAGI",
    agentStatus: "running",
    archived: false,
    excluded: null,
    prRefs: ["Spshulem/openAGI#325"],
    meta: { serverId: "srv_1", paseoCwd: "/home/dev/openAGI", provider: "codex", isLocalHost: true }
  };
  sup.lastThreads.set(runningThread.key, runningThread);

  // 1. Sending while running queues durably instead of interrupting or spawning a clone.
  const first = await sup.sendOwnerMessage(runningThread.key, "Please rebase onto main once your tests finish");
  assert.equal(first.delivery.status, "queued");
  assert.equal(first.delivery.queued, true);
  assert.equal(first.delivery.route, "paseo-queue");
  assert.ok(first.delivery.queueId);
  assert.equal(deliveredCalls.length, 0, "did not interrupt running session");
  assert.equal(sup.store.queuedOwnerMessages(runningThread.key).length, 1);

  // 2. fleet_send_message tool wrapper accepts status='queued' cleanly (does not throw).
  const registry = new ToolRegistry();
  registerFleetTools(registry, sup);
  const sendTool = registry.get("fleet_send_message");
  const toolRes = await sendTool.handler(
    { key: runningThread.key, message: "Also check Android build after rebase" },
    { __confirmed: true }
  );
  assert.equal(toolRes.status, "queued");
  assert.equal(toolRes.queued, true);
  assert.equal(sup.store.queuedOwnerMessages(runningThread.key).length, 2);

  // 3. While still running, drain leaves queue intact.
  const whileBusy = await sup.drainQueuedOwnerMessages({ byKey: new Map([[runningThread.key, runningThread]]), started: nowMs + 10_000 });
  assert.equal(whileBusy.length, 0);
  assert.equal(sup.store.queuedOwnerMessages(runningThread.key).length, 2);

  // 4. Once idle, drain delivers FIFO (one per turn per thread) and clears delivered item.
  liveBusy = false;
  const idleThread = { ...runningThread, agentStatus: "idle" };
  const drain1 = await sup.drainQueuedOwnerMessages({ byKey: new Map([[idleThread.key, idleThread]]), started: nowMs + 30_000 });
  assert.equal(drain1.length, 1);
  assert.equal(drain1[0].status, "sent");
  assert.equal(deliveredCalls.length, 1);
  assert.equal(deliveredCalls[0].message, "Please rebase onto main once your tests finish");
  assert.equal(sup.store.queuedOwnerMessages(runningThread.key).length, 1);

  const drain2 = await sup.drainQueuedOwnerMessages({ byKey: new Map([[idleThread.key, idleThread]]), started: nowMs + 60_000 });
  assert.equal(drain2.length, 1);
  assert.equal(drain2[0].status, "sent");
  assert.equal(deliveredCalls[1].message, "Also check Android build after rebase");
  assert.equal(sup.store.queuedOwnerMessages(runningThread.key).length, 0);
});

test("deliverPaseo: transient capacity error never spawns a clone; queue=true reports busy on mid-turn live agent", async (t) => {
  const dir = makeTmpDir(t, "paseo-deliv-");
  assert.equal(isPermanentlyDisconnectedRuntimeError("Selected model is at capacity. Please try a different model."), false);
  assert.equal(isPermanentlyDisconnectedRuntimeError("HTTP 429 rate limit exceeded"), false);
  assert.equal(isPermanentlyDisconnectedRuntimeError("ACP agent disconnected (exit code 0)"), true);

  let createCalls = 0;
  let sendCalls = 0;
  const busyAgent = {
    id: "sess_live",
    title: "Live build",
    status: "running",
    activeTurn: { turnId: "t_1" },
    provider: "codex",
    cwd: "/workspace/app",
    workspaceId: "wks_1",
    updatedAt: "2026-11-24T18:55:00Z"
  };
  const factory = () => ({
    connect: async () => {},
    close: async () => {},
    hosts: { list: async () => ({ self: { serverId: "srv_1" }, hosts: [] }) },
    agents: {
      create: async () => { createCalls += 1; return { id: "clone" }; },
      ref: () => ({
        refresh: async () => {},
        current: () => busyAgent,
        send: async () => { sendCalls += 1; },
        timeline: { refetch: async () => ({ agent: busyAgent, entries: [] }) }
      })
    }
  });

  const busyRes = await deliverPaseo({
    config: { paseo: { enabled: true } },
    thread: paseoThread(busyAgent, "srv_1"),
    text: "[OpenAGI supervisor] Owner says: update tests",
    store: { dir },
    actionId: "act_q",
    base: { messageHash: "h1", playbook: "owner-message" },
    queue: true,
    factory
  });
  assert.equal(busyRes.status, "busy");
  assert.equal(busyRes.busy, true);
  assert.equal(sendCalls, 0);
  assert.equal(createCalls, 0);
});

test("Anti-clone guard & dead-session failover redirect: Continue/Resume reuses existing session and dead session redirects to replacement", async (t) => {
  const dir = makeTmpDir(t, "anti-clone-");
  const sentTo = [];
  const sup = new FleetSupervisor({
    dataDir: dir,
    runtime: { events: { emit() {} } },
    config: { enabled: true, mode: "auto", paseo: { enabled: true, only: true } },
    deps: {
      now: () => NOW,
      executor: {
        async deliver({ thread, message }) {
          sentTo.push({ key: thread.key, message });
          return { status: "sent", route: "paseo-send", actionId: "act_1", detail: "Sent" };
        }
      }
    }
  });

  const liveSession = {
    key: "paseo:srv_1.live_325",
    kind: "paseo",
    id: "live_325",
    title: "Active Work PR #325 failover",
    workspace: "openAGI",
    agentStatus: "running",
    archived: false,
    excluded: null,
    prRefs: ["Spshulem/openAGI#325"],
    meta: { serverId: "srv_1", paseoCwd: "/home/dev/openAGI", provider: "claude", isLocalHost: true }
  };
  sup.lastThreads.set(liveSession.key, liveSession);

  let createCalled = false;
  const started = await startPaseoSession(sup, {
    serverId: "srv_1",
    cwd: "/home/dev/openAGI",
    title: "Resume Active Work PR #325 failover",
    prompt: "Continue Active Work PR #325 and check CI",
    factory: () => ({
      connect: async () => {},
      close: async () => {},
      hosts: { list: async () => ({ self: { serverId: "srv_1" }, hosts: [] }) },
      agents: { create: async () => { createCalled = true; return { id: "bad_clone" }; } }
    })
  });
  assert.equal(createCalled, false, "must NOT create a duplicate Resume/Continue session");
  assert.equal(started.reused, true);
  assert.equal(started.status, "queued_existing");
  assert.equal(started.key, liveSession.key);
  assert.equal(sup.store.queuedOwnerMessages(liveSession.key).length, 1);

  // Dead failed-over session redirects to live replacement automatically.
  const deadOld = {
    key: "paseo:srv_1.dead_old",
    kind: "paseo",
    id: "dead_old",
    title: "AppFolio Rubric",
    agentStatus: "error",
    archived: false,
    excluded: null,
    meta: { serverId: "srv_1", paseoCwd: "/home/dev/bb", provider: "codex" }
  };
  const liveReplacement = {
    key: "paseo:srv_1.live_new",
    kind: "paseo",
    id: "live_new",
    title: "AppFolio Rubric",
    agentStatus: "idle",
    archived: false,
    excluded: null,
    meta: { serverId: "srv_1", paseoCwd: "/home/dev/bb", provider: "claude" }
  };
  sup.lastThreads.set(deadOld.key, deadOld);
  sup.lastThreads.set(liveReplacement.key, liveReplacement);
  sup.store.recordProviderFailover(deadOld.key, { newKey: liveReplacement.key, failureSig: "sig_1" });

  const redir = await sup.sendOwnerMessage(deadOld.key, "Check the report link");
  assert.equal(redir.delivery.status, "sent");
  assert.equal(redir.delivery.redirectedFrom, deadOld.key);
  assert.equal(sentTo.at(-1).key, liveReplacement.key);
});

test("Proactive check-ins: single-publisher local-host filter, duplicate project collapse, closed-goal drop, cadence off/quiet, and agent-judged suppression/rewrite", async (t) => {
  const dir = makeTmpDir(t, "proactive-gate-");
  let nowMs = NOW;
  const { msgs, runtime } = makeChatRuntime([
    { id: "u1", role: "user", content: "Stop pinging me about AppFolio, I saw it." },
    { id: "a1", role: "assistant", content: "Got it, I'll hold off on AppFolio." }
  ]);

  let agentDecision = { send: false, reason: "Spencer just said he already saw this" };
  const judgedInputs = [];
  const sup = new FleetSupervisor({
    dataDir: dir,
    runtime,
    config: { enabled: true, mode: "auto", proactiveSupervisorChat: true },
    deps: {
      now: () => nowMs,
      judgeProactiveUpdate: async (payload) => {
        judgedInputs.push(payload);
        return agentDecision;
      }
    }
  });

  // 1. Screenshot 3 exact repro: two duplicate AppFolio sessions, one closed-goal zombie + one active, plus a remote host thread.
  const closedZombieThread = {
    key: "paseo:srv_1.appfolio_closed",
    kind: "paseo",
    title: "🧭 AppFolio Rubric Expectations Review",
    agentStatus: "idle",
    lastAgentText: "The goal is already closed, so I did no new work this turn.",
    prRefs: ["buildbetter-app/buildbetter#10423"],
    meta: { serverId: "srv_1", isLocalHost: true }
  };
  const liveAppfolio1 = {
    key: "paseo:srv_1.appfolio_1",
    kind: "paseo",
    title: "🧭 AppFolio Rubric Expectations Review",
    agentStatus: "idle",
    lastAgentText: "BuildBot3 full run missing on #10423. Should I keep going or stop?",
    prRefs: ["buildbetter-app/buildbetter#10423"],
    meta: { serverId: "srv_1", isLocalHost: true }
  };
  const liveAppfolio2 = {
    key: "paseo:srv_1.appfolio_2",
    kind: "paseo",
    title: "🧭 AppFolio Rubric Expectations Review",
    agentStatus: "idle",
    lastAgentText: "BuildBot3 full run missing on #10423. Should I keep going or stop?",
    prRefs: ["buildbetter-app/buildbetter#10423"],
    meta: { serverId: "srv_1", isLocalHost: true }
  };
  const remoteHostThread = {
    key: "paseo:srv_remote.other",
    kind: "paseo",
    title: "Remote host task",
    agentStatus: "idle",
    lastAgentText: "Should we enable feature flag X? Options: Enable, Keep off.",
    meta: { serverId: "srv_remote", isLocalHost: false }
  };
  for (const th of [closedZombieThread, liveAppfolio1, liveAppfolio2, remoteHostThread]) {
    sup.lastThreads.set(th.key, th);
  }
  assert.equal(isClosedOrContradictoryDecision({ kind: "agent-ask" }, closedZombieThread), true);

  sup.store.upsertQuestion({
    dedupeKey: "ask:af_closed", kind: "agent-ask", threadKey: closedZombieThread.key, prRef: "buildbetter-app/buildbetter#10423",
    title: "#10423 stuck. BuildBot3 full run missing. Help?", options: ["Keep going", "Stop"],
    contextSnapshot: { threadTitle: closedZombieThread.title, recentMessages: [{ role: "user", text: "Review AppFolio" }, { role: "assistant", text: closedZombieThread.lastAgentText }] }
  });
  sup.store.upsertQuestion({
    dedupeKey: "ask:af_1", kind: "agent-ask", threadKey: liveAppfolio1.key, prRef: "buildbetter-app/buildbetter#10423",
    title: "#10423 stuck. BuildBot3 full run missing. Help?", options: ["Keep going", "Stop"],
    contextSnapshot: { threadTitle: liveAppfolio1.title, recentMessages: [{ role: "user", text: "Review AppFolio" }, { role: "assistant", text: liveAppfolio1.lastAgentText }] }
  });
  sup.store.upsertQuestion({
    dedupeKey: "ask:af_2", kind: "agent-ask", threadKey: liveAppfolio2.key, prRef: "buildbetter-app/buildbetter#10423",
    title: "#10423 stuck. BuildBot3 full run missing. Help?", options: ["Keep going", "Stop"],
    contextSnapshot: { threadTitle: liveAppfolio2.title, recentMessages: [{ role: "user", text: "Review AppFolio" }, { role: "assistant", text: liveAppfolio2.lastAgentText }] }
  });
  sup.store.upsertQuestion({
    dedupeKey: "ask:remote", kind: "agent-ask", threadKey: remoteHostThread.key,
    title: "Enable feature flag X?", options: ["Enable", "Keep off"],
    contextSnapshot: { threadTitle: remoteHostThread.title, recentMessages: [{ role: "user", text: "Feature flag X" }, { role: "assistant", text: remoteHostThread.lastAgentText }] }
  });

  // Agent receives ONLY 1 deduplicated local AppFolio item (no zombie, no duplicate, no remote host), and suppresses it!
  const suppressedRes = await sup.maybePostProactiveSupervisorDigest({ started: nowMs });
  assert.equal(suppressedRes.posted, false);
  assert.equal(suppressedRes.suppressed, true);
  assert.equal(judgedInputs.length, 1);
  assert.equal((judgedInputs[0].candidateText.match(/AppFolio Rubric/g) ?? []).length >= 1, true);
  assert.equal((judgedInputs[0].candidateText.match(/\*\*New: /g) ?? []).length, 1, "duplicate & zombie & remote items collapsed before agent review");
  assert.equal(judgedInputs[0].candidateText.includes("Remote host task"), false);
  assert.equal(msgs.length, 2, "nothing posted when agent judged it unhelpful");

  // 2. When a genuinely new decision arrives and agent approves with custom phrasing, it posts tagged proactive=true.
  nowMs += 60_000;
  agentDecision = { send: true, reason: "New merge-ready PR", message: "Quick heads-up: PR #400 (Voice rollout) is green and ready for your merge call." };
  const readyThread = {
    key: "paseo:srv_1.voice_400",
    kind: "paseo",
    title: "Voice rollout PR #400",
    agentStatus: "idle",
    lastAgentText: "CI is green on PR #400. Ready to merge?",
    prRefs: ["Spshulem/openAGI#400"],
    meta: { serverId: "srv_1", isLocalHost: true }
  };
  sup.lastThreads.set(readyThread.key, readyThread);
  sup.store.upsertQuestion({
    dedupeKey: "ready:Spshulem/openAGI#400", kind: "ready", mergeAsk: true, threadKey: readyThread.key, prRef: "Spshulem/openAGI#400",
    title: "PR #400 ready to merge?", options: ["Merge", "Hold"],
    contextSnapshot: { threadTitle: readyThread.title, recentMessages: [{ role: "user", text: "Ship voice rollout" }, { role: "assistant", text: readyThread.lastAgentText }] }
  });

  const approvedRes = await sup.maybePostProactiveSupervisorDigest({ started: nowMs });
  assert.equal(approvedRes.posted, true);
  assert.equal(approvedRes.agentReviewed, true);
  assert.equal(msgs.length, 3);
  assert.equal(msgs[2].content, "Quick heads-up: PR #400 (Voice rollout) is green and ready for your merge call.");
  assert.equal(msgs[2].metadata.proactive, true);
  assert.equal(msgs[2].metadata.proactiveMeta.agentReviewed, true);

  // 3. cadence: 'off' suppresses everything; quiet_until_ready suppresses routine agent-ask but keeps merge-ready.
  assert.equal(isSuppressedFromProactiveChat({ kind: "ready", mergeAsk: true }, { cadence: "off" }), true);
  assert.equal(isSuppressedFromProactiveChat({ kind: "agent-ask" }, { cadence: "quiet_until_ready" }), true);
  assert.equal(isSuppressedFromProactiveChat({ kind: "ready", mergeAsk: true }, { cadence: "quiet_until_ready" }), false);

  // 4. Hub-level proactive guard deduplicates across paired nodes & enforces cooldown.
  let hubNow = NOW;
  const hubGuard = createHubProactiveGuard({
    getPreferences: () => ({ cadence: "balanced", checkinCooldownMinutes: 20 }),
    getRecentMessages: () => msgs,
    judgeProactiveUpdate: async ({ candidateText }) => ({ send: true, message: candidateText }),
    now: () => hubNow
  });
  const h1 = await hubGuard.evaluate({ text: "**Supervisor check-in: one decision needs you.**\nPR #500", decisionKeys: ["ready:repo#500"] });
  assert.equal(h1.send, true);
  // Second node posting the exact same decision 5s later is deduped on the hub!
  hubNow += 5_000;
  const h2 = await hubGuard.evaluate({ text: "**Supervisor check-in: one decision needs you.**\nPR #500", decisionKeys: ["ready:repo#500"] });
  assert.equal(h2.send, false);
  assert.match(h2.reason, /deduped/);
  // Different decision 1 minute later respects hub cooldown!
  hubNow += 60_000;
  const h3 = await hubGuard.evaluate({ text: "**Supervisor check-in: one decision needs you.**\nPR #501", decisionKeys: ["ready:repo#501"] });
  assert.equal(h3.send, false);
  assert.equal(h3.reason, "hub_cooldown");
  // After 21 minutes cooldown passes!
  hubNow += 21 * 60_000;
  const h4 = await hubGuard.evaluate({ text: "**Supervisor check-in: one decision needs you.**\nPR #501", decisionKeys: ["ready:repo#501"] });
  assert.equal(h4.send, true);

  // 5. actionableDecisionMaterialHash ignores volatile body-only prose edits.
  const m1 = actionableDecisionMaterialHash({ kind: "agent-ask", threadKey: "paseo:s.1", title: "Deploy staging?", body: "Attempt 1 details", options: ["Yes", "No"] });
  const m2 = actionableDecisionMaterialHash({ kind: "agent-ask", threadKey: "paseo:s.1", title: "Deploy staging?", body: "Context refreshed with 3 more lines", options: ["Yes", "No"] });
  assert.equal(m1, m2);

  // 6. Preferences persist cadence='off', checkinCooldownMinutes, and checkinFormat.
  const patched = applyPreferencePatch(normalizePreferences({}), {
    cadence: "off",
    checkinCooldownMinutes: 45,
    checkinFormat: "One bullet per project: Goal, Current state, Exact decision."
  });
  assert.equal(patched.cadence, "off");
  assert.equal(patched.checkinCooldownMinutes, 45);
  assert.match(patched.checkinFormat, /One bullet per project/);
});

test("Post-send verification never blasts completed 'Got it' turns or 'fixed the failed test' as owner blockers", async (t) => {
  const dir = makeTmpDir(t, "ftw-clean-");
  let nowMs = NOW;
  const { msgs, runtime } = makeChatRuntime();
  const sup = new FleetSupervisor({
    dataDir: dir,
    runtime,
    config: { enabled: true, mode: "auto" },
    deps: { now: () => nowMs }
  });
  const thread = {
    key: "paseo:srv_1.done_chat",
    kind: "paseo",
    title: "Fix test flake",
    agentStatus: "idle",
    lastAgentAt: new Date(nowMs - 60_000).toISOString(),
    lastActivityAt: new Date(nowMs - 60_000).toISOString(),
    lastAgentText: "Earlier status",
    prRefs: [],
    meta: { serverId: "srv_1" }
  };
  sup.registerFollowThroughWatch(thread, "Fix the failing unit test", { source: "owner-message" });
  // Open a normal completion "Got it" card on this thread.
  sup.store.upsertQuestion({
    dedupeKey: "completed:paseo:srv_1.done_chat:1",
    kind: "completed",
    threadKey: thread.key,
    title: "Fix test flake: finished",
    options: ["Got it"]
  });
  nowMs += 45_000;
  const finishedThread = {
    ...thread,
    lastAgentAt: new Date(nowMs - 5_000).toISOString(),
    lastActivityAt: new Date(nowMs - 5_000).toISOString(),
    lastAgentText: "Fixed the failed test and all 120 unit tests now pass."
  };
  const outcomes = await sup.reconcileFollowThroughWatches({
    byKey: new Map([[finishedThread.key, finishedThread]]),
    items: [{ thread: finishedThread, classified: { state: "idle-no-pr" } }],
    started: nowMs
  });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].outcome, "completed");
  assert.equal(msgs.length, 0, "must NOT blast 'stopped on an owner blocker' for completed Got it cards");
});

test("Context isolation: proactive blasts never evict real conversation turns, and exact doubled dictation collapses cleanly", () => {
  const history = [];
  for (let i = 1; i <= 10; i += 1) {
    history.push({ role: "user", content: `Real user turn ${i}` });
    history.push({ role: "assistant", content: `Real assistant reply ${i}` });
  }
  // Pile 30 proactive check-in blasts on top!
  for (let j = 1; j <= 30; j += 1) {
    history.push({
      role: "assistant",
      content: `**Supervisor check-in: 2 decisions need you.**\nSpam blast #${j}`,
      metadata: { proactive: true }
    });
  }
  const visible = imageHistory(history, "Latest user turn", []);
  const realTurns = visible.filter((m) => !isProactiveSupervisorMessage(m));
  const proactiveTurns = visible.filter((m) => isProactiveSupervisorMessage(m));
  assert.equal(realTurns.length, 12, "preserves all 12 recent real conversational messages");
  assert.equal(proactiveTurns.length, 2, "caps proactive blasts in model input at 2");
  assert.equal(realTurns.at(-1).content, "Real assistant reply 10");

  assert.equal(
    dedupeExactDoubledDictation("Where is the kudos link?Where is the kudos link?"),
    "Where is the kudos link?"
  );
  assert.equal(
    dedupeExactDoubledDictation("Can you stop sending check-ins? Can you stop sending check-ins?"),
    "Can you stop sending check-ins?"
  );
  assert.equal(
    dedupeExactDoubledDictation("Normal message with no duplicate"),
    "Normal message with no duplicate"
  );
});

test("Owner directives & bookkeeping: no 'yes <N>' friction on real owner follow-ups or bookkeeping while passive reads stay blocked", async (t) => {
  // Natural follow-ups that previously triggered Say 'yes 74' / 'yes 14' / 'yes 61'
  for (const phrase of [
    "I thought I told you to talk to Bob to stop the report from opening every single time. What's going on with that?",
    "The CEO update, we can take that off our project list for right now.",
    "Stop sending status updates like this",
    "I'm still waiting for the kudos link",
    "Change your reasoning effort to xhigh"
  ]) {
    assert.equal(isSupervisorActionableDirective(phrase), true, phrase);
  }
  // Passive status reads stay blocked from autonomous side effects.
  for (const passive of ["what's the latest?", "what did codex say?", "what is running in paseo?"]) {
    assert.equal(isSupervisorActionableDirective(passive), false, passive);
  }

  // Bookkeeping tools run directly on tainted non-voice owner turns in Supervisor chat without Say 'yes <N>'.
  const dir = makeTmpDir(t, "owner-book-");
  const pendingActions = new PendingActionStore({ dir });
  const registry = new ToolRegistry();
  registry.pendingActions = pendingActions;
  let trackedCalled = false;
  let prefsCalled = false;
  registry.register({
    name: "fleet_track_work",
    needsConfirmation: true,
    supervisorAutoApprove: true,
    handler: async (_args, ctx) => {
      assert.equal(ctx.__confirmed, true);
      trackedCalled = true;
      return { ok: true };
    }
  });
  registry.register({
    name: "fleet_preferences",
    needsConfirmation: true,
    supervisorAutoApprove: true,
    handler: async (_args, ctx) => {
      assert.equal(ctx.__confirmed, true);
      prefsCalled = true;
      return { status: "updated" };
    }
  });

  const owner = ownerPrincipal("phone", "iphone-1");
  const ctx = {
    sessionId: "devices:supervisor:main",
    __owner: owner,
    __turn: { untrusted: true, intent: "CEO update is done", supervisorAutoApprove: true }
  };
  const r1 = await registry.invoke("fleet_track_work", { goal: "Update" }, ctx);
  assert.equal(r1.ok, true);
  assert.equal(trackedCalled, true);
  assert.notEqual(r1.result?.status, "awaiting_owner_confirmation");

  const r2 = await registry.invoke("fleet_preferences", { cadence: "off" }, ctx);
  assert.equal(r2.ok, true);
  assert.equal(prefsCalled, true);
});

test("set_provider live self-configuration: inspects, updates model + reasoningEffort live, and refuses unconfigured provider safely", async (t) => {
  const dir = makeTmpDir(t, "self-cfg-");
  const prevEnv = {
    OPENAGI_DATA_DIR: process.env.OPENAGI_DATA_DIR,
    OPENAGI_PROVIDER: process.env.OPENAGI_PROVIDER,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    OPENAI_REASONING_EFFORT_TASK_CHAT: process.env.OPENAI_REASONING_EFFORT_TASK_CHAT,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY
  };
  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetDataDirCache();
  });

  process.env.OPENAGI_DATA_DIR = dir;
  _resetDataDirCache();
  process.env.OPENAGI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "sk-test-fake-key-1234567890";
  process.env.OPENAI_MODEL = "gpt-5.4";
  delete process.env.OPENAI_REASONING_EFFORT_TASK_CHAT;
  delete process.env.ANTHROPIC_API_KEY;

  const store = new InMemoryAgentStore({ storePath: path.join(dir, "sessions.json") });
  store.saveSession({ id: "devices:supervisor:main", messages: [], metadata: {} });
  const runtime = {
    agentHost: { store, modelProvider: { constructor: { name: "OpenAIResponsesProvider" }, model: "gpt-5.4" } },
    budget: null
  };
  const registry = new ToolRegistry();
  registerCoreTools(registry, runtime);

  // 1. Refuses switching to unconfigured Anthropic cleanly without breaking OpenAI.
  const bad = await registry.invoke("set_provider", { preference: "anthropic" }, { sessionId: "devices:supervisor:main" });
  assert.equal(bad.ok, true);
  assert.equal(bad.result.ok, false);
  assert.match(bad.result.error, /not configured/i);
  assert.equal(process.env.OPENAGI_PROVIDER, "openai");

  // 2. Updates model + reasoningEffort live on OpenAI and persists!
  const good = await registry.invoke(
    "set_provider",
    { model: "gpt-6.2-sol", reasoningEffort: "extra high" },
    { sessionId: "devices:supervisor:main" }
  );
  assert.equal(good.ok, true);
  assert.equal(good.result.ok, true);
  assert.equal(good.result.model, "gpt-6.2-sol");
  assert.equal(good.result.reasoningEffort, "xhigh");
  assert.equal(process.env.OPENAI_MODEL, "gpt-6.2-sol");
  assert.equal(process.env.OPENAI_REASONING_EFFORT_TASK_CHAT, "xhigh");
  assert.equal(runtime.agentHost.modelProvider.model, "gpt-6.2-sol");
});

test("Codex review fixes: hub cooldown stays pending, material changes pass dedupe, concurrent hub evaluations serialize", async (t) => {
  // 1. Concurrent evaluations with identical payload serialize so only the first posts.
  let nowMs = Date.parse("2026-11-24T19:00:00.000Z");
  let judgeCalls = 0;
  const hubGuard = createHubProactiveGuard({
    getPreferences: () => ({ cadence: "balanced", checkinCooldownMinutes: 30 }),
    getRecentMessages: () => [],
    now: () => nowMs,
    judgeProactiveUpdate: async ({ candidateText }) => {
      judgeCalls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { send: true, text: candidateText, reason: "approved" };
    }
  });
  const [r1, r2] = await Promise.all([
    hubGuard.evaluate({
      text: "**Supervisor check-in: one decision needs you.**\nMerge PR #401?",
      decisionKeys: ["ready:acme/app#401"],
      decisionTokens: ["ready:acme/app#401:head_aaa"]
    }),
    hubGuard.evaluate({
      text: "**Supervisor check-in: one decision needs you.**\nMerge PR #401?",
      decisionKeys: ["ready:acme/app#401"],
      decisionTokens: ["ready:acme/app#401:head_aaa"]
    })
  ]);
  assert.equal(r1.send, true);
  assert.equal(r2.send, false);
  assert.equal(r2.reason, "hub_deduped");
  assert.equal(judgeCalls, 1, "second concurrent request must wait and be deduped before calling judge");

  // 2. Different decision inside cooldown returns deferred: true (temporary), NOT permanent suppression.
  nowMs += 5 * 60_000;
  const duringCooldown = await hubGuard.evaluate({
    text: "**Supervisor check-in: one decision needs you.**\nMerge PR #402?",
    decisionKeys: ["ready:acme/app#402"],
    decisionTokens: ["ready:acme/app#402:head_bbb"]
  });
  assert.equal(duringCooldown.send, false);
  assert.equal(duringCooldown.deferred, true);
  assert.equal(duringCooldown.reason, "hub_cooldown");

  // 3. After cooldown expires, BOTH the deferred PR #402 AND a materially changed PR #401 (new head) pass!
  nowMs += 31 * 60_000;
  const afterCooldown = await hubGuard.evaluate({
    text: "**Supervisor check-in: one decision needs you.**\nMerge PR #402?",
    decisionKeys: ["ready:acme/app#402"],
    decisionTokens: ["ready:acme/app#402:head_bbb"]
  });
  assert.equal(afterCooldown.send, true);

  nowMs += 31 * 60_000;
  const updatedHead = await hubGuard.evaluate({
    text: "**Supervisor check-in: one decision needs you.**\nPR #401 updated with new head commit — merge?",
    decisionKeys: ["ready:acme/app#401"],
    decisionTokens: ["ready:acme/app#401:head_ccc"]
  });
  assert.equal(updatedHead.send, true, "materially changed decision token must remain announceable within 4h");

  // 4. Supervisor.maybePostProactiveSupervisorDigest does NOT commit surfacedDecisions when hub defers on cooldown.
  const dir = makeTmpDir(t, "hub-defer-");
  fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({
    remote: "http://hub.local:43210",
    ownerProxyToken: "test-token"
  }));
  const sessionStore = new InMemoryAgentStore({ storePath: path.join(dir, "sessions.json") });
  sessionStore.saveSession({ id: "devices:supervisor:main", messages: [], metadata: {} });
  let remoteMode = "defer";
  const sup = new FleetSupervisor({
    dataDir: dir,
    runtime: { agentHost: { store: sessionStore } },
    config: { mode: "propose", proactiveSupervisorChat: true, paseo: { enabled: true, only: true } },
    deps: {
      supervisorChatFetch: async () => ({
        ok: true,
        json: async () => (remoteMode === "defer"
          ? { ok: true, suppressed: true, deferred: true, reason: "hub_cooldown" }
          : { ok: true, appended: [{ id: "m1" }] })
      })
    }
  });
  const row = {
    key: "paseo:local.defer-1",
    kind: "paseo",
    id: "defer-1",
    title: "Checkout fix",
    workspace: "app",
    agentStatus: "idle",
    prRefs: ["acme/app#700"],
    meta: { serverId: "local", isLocalHost: true, paseoCwd: "/work/app" }
  };
  sup.lastThreads.set(row.key, row);
  sup.store.upsertQuestion({
    dedupeKey: "ready:acme/app#700",
    kind: "ready",
    threadKey: row.key,
    prRef: "acme/app#700",
    title: "Checkout fix PR #700 ready to merge",
    body: "All checks green.",
    options: ["merged", "later"],
    contextSnapshot: {
      threadTitle: "Checkout fix",
      workspace: "app",
      pr: { ref: "acme/app#700", state: "OPEN", ciState: "SUCCESS", head: "sha700" }
    }
  });

  const firstAttempt = await sup.maybePostProactiveSupervisorDigest({ started: Date.now() });
  assert.equal(firstAttempt.suppressed, true);
  assert.equal(firstAttempt.deferred, true);

  // When hub later accepts (cooldown expired), the decision is STILL pending and posts!
  remoteMode = "post";
  const secondAttempt = await sup.maybePostProactiveSupervisorDigest({ started: Date.now() + 60_000 });
  assert.equal(secondAttempt.posted, true, "cooldown-deferred decision must remain pending until posted");
});

test("Codex review fixes: queued drain holds on permission prompt, preserves >4000-char directives, and new-work sessions stay distinct", async (t) => {
  const dir = makeTmpDir(t, "queue-perm-");
  const deliveries = [];
  const sup = new FleetSupervisor({
    dataDir: dir,
    config: { mode: "propose", paseo: { enabled: true, only: true } },
    deps: {
      executor: {
        async deliver({ message, holdOnPermission }) {
          deliveries.push({ text: message, holdOnPermission });
          return { status: "sent", route: "paseo-send", detail: "delivered" };
        }
      }
    }
  });
  const longDirective = `ActiveWork goal: ${"A".repeat(4500)}\nACCEPTANCE_CRITERIA_TAIL_MARKER`;
  const runningThread = {
    key: "paseo:host1.agent-long",
    kind: "paseo",
    id: "agent-long",
    title: "Fix Android production login",
    workspace: "app",
    cwd: "/work/app",
    agentStatus: "running",
    meta: { serverId: "host1", paseoCwd: "/work/app", workspaceId: "wks_1", updatedAt: "2026-11-24T19:00:00.000Z" }
  };
  sup.lastThreads.set(runningThread.key, runningThread);

  // 1. Enqueue preserves full 4,500+ char directive without truncating trailing acceptance criteria.
  const queuedRes = await sup.sendOwnerMessage(runningThread.key, longDirective);
  assert.equal(queuedRes.delivery.status, "queued");
  const stored = sup.store.queuedOwnerMessages(runningThread.key);
  assert.equal(stored.length, 1);
  assert.ok(stored[0].message.includes("ACCEPTANCE_CRITERIA_TAIL_MARKER"));

  // 2. If the session pauses at a permission prompt, drain MUST keep the message queued instead of answering Allow/Deny!
  sup.lastThreads.set(runningThread.key, {
    ...runningThread,
    agentStatus: "idle",
    state: "needs-human",
    requiresAttention: true,
    attentionReason: "permission",
    meta: { ...runningThread.meta, blockedOnOwner: true, pendingPermission: { id: "perm-9", kind: "tool" } }
  });
  const heldDrain = await sup.drainQueuedOwnerMessages();
  assert.equal(heldDrain.length, 0);
  assert.equal(deliveries.length, 0);
  assert.equal(sup.store.queuedOwnerMessages(runningThread.key).length, 1);

  // 3. Even if live deliverPaseo encounters a fresh permission prompt right at send time, holdOnPermission=true holds it!
  let respondCalled = false;
  const permAgent = {
    id: "agent-long",
    status: "idle",
    cwd: "/work/app",
    workspaceId: "wks_1",
    updatedAt: "2026-11-24T19:00:00.000Z",
    pendingPermissions: [{ id: "perm-live", kind: "tool", actions: [{ id: "allow", behavior: "allow", label: "Allow" }] }]
  };
  const fakeFactory = () => ({
    connect: async () => {},
    close: async () => {},
    hosts: { list: async () => ({ self: { serverId: "host1" }, hosts: [] }) },
    agents: {
      ref: () => ({
        refresh: async () => {},
        current: () => permAgent,
        respondPermission: async () => { respondCalled = true; },
        timeline: { refetch: async () => ({ agent: permAgent, entries: [] }) }
      })
    }
  });
  const liveHeld = await deliverPaseo({
    config: { paseo: { enabled: true } },
    thread: { ...runningThread, agentStatus: "idle" },
    text: "Also update the tests",
    store: { dir },
    actionId: "act-perm-hold",
    base: { playbook: "owner-message", messageHash: "h1" },
    factory: fakeFactory,
    queue: true,
    holdOnPermission: true
  });
  assert.equal(liveHeld.status, "busy");
  assert.equal(liveHeld.permissionRequired, true);
  assert.equal(respondCalled, false, "queued prose must never answer a permission prompt");

  // 4. Once permission clears and session is idle, drain delivers the full untruncated directive.
  sup.lastThreads.set(runningThread.key, {
    ...runningThread,
    agentStatus: "idle",
    state: "idle",
    requiresAttention: false,
    attentionReason: null,
    meta: { ...runningThread.meta, blockedOnOwner: false, pendingPermission: null }
  });
  const sentDrain = await sup.drainQueuedOwnerMessages();
  assert.equal(sentDrain.length, 1);
  assert.equal(sentDrain[0].status, "sent");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].holdOnPermission, true);
  assert.ok(deliveries[0].text.includes("ACCEPTANCE_CRITERIA_TAIL_MARKER"));

  // 5. Distinct new-work title ("Fix Android production checkout" vs "Fix Android production login") creates a new session!
  let createdNew = false;
  const fakeCreateFactory = () => ({
    connect: async () => {},
    close: async () => {},
    hosts: { list: async () => ({ self: { serverId: "host1" }, hosts: [] }) },
    agents: {
      list: async () => ({ agents: [] }),
      providers: async () => ({ providers: [{ provider: "claude", available: true, models: [{ id: "claude-opus-4-6" }], modes: [{ id: "bypassPermissions" }] }] }),
      create: async (opts) => {
        createdNew = true;
        return { id: "agent-new-checkout", title: opts.title, cwd: opts.cwd, provider: opts.provider, model: opts.model, status: "running" };
      }
    }
  });
  const created = await startPaseoSession(sup, {
    title: "Fix Android production checkout",
    prompt: "Investigate checkout failure on Android",
    cwd: "/work/app",
    serverId: "host1",
    factory: fakeCreateFactory
  });
  assert.equal(createdNew, true, "distinct new-work title must not fuzzy-merge into existing login session");
  assert.notEqual(created.reused, true);
});

test("Codex review fixes: set_provider writes CHATGPT_MODEL / CODEX_CLI_MODEL / CLAUDE_CLI_MODEL for subscription providers", async (t) => {
  const dir = makeTmpDir(t, "sub-model-");
  const prevEnv = {
    OPENAGI_DATA_DIR: process.env.OPENAGI_DATA_DIR,
    OPENAGI_PROVIDER: process.env.OPENAGI_PROVIDER,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    CHATGPT_MODEL: process.env.CHATGPT_MODEL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY
  };
  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetDataDirCache();
  });

  process.env.OPENAGI_DATA_DIR = dir;
  _resetDataDirCache();
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.OPENAGI_PROVIDER = "auto";
  delete process.env.CHATGPT_MODEL;
  delete process.env.OPENAI_MODEL;

  const store = new InMemoryAgentStore({ storePath: path.join(dir, "sessions.json") });
  store.saveSession({ id: "devices:supervisor:main", messages: [], metadata: {} });
  const runtime = {
    agentHost: { store, modelProvider: { constructor: { name: "ChatGPTPlanProvider" }, model: "gpt-6.1-sol" } },
    budget: null
  };
  const registry = new ToolRegistry();
  registerCoreTools(registry, runtime);

  const res = await registry.invoke("set_provider", { model: "gpt-6.2-sol" }, { sessionId: "devices:supervisor:main" });
  assert.equal(res.ok, true);
  assert.equal(res.result.ok, true);
  assert.equal(process.env.CHATGPT_MODEL, "gpt-6.2-sol");
  assert.equal(process.env.OPENAI_MODEL, undefined);
});

test("Codex round-2 fixes: security preferences stay gated, unconfirmed queued sends never replay, unsupported effort rolls back, duplicate/blocked reuse never clones, and local hub posts share guard", async (t) => {
  // 1. fleet_preferences with defaultPermissionMode='bypass' stays gated on a tainted status-read turn.
  const dir1 = makeTmpDir(t, "pref-sec-");
  const pendingActions = new PendingActionStore({ dir: dir1 });
  const reg = new ToolRegistry();
  reg.pendingActions = pendingActions;
  let prefCalls = 0;
  reg.register({
    name: "fleet_preferences",
    needsConfirmation: true,
    supervisorAutoApprove: true,
    handler: async () => { prefCalls += 1; return { status: "updated" }; }
  });
  const owner = ownerPrincipal("phone", "iphone-1");
  const statusCtx = {
    sessionId: "devices:supervisor:main",
    __owner: owner,
    __turn: { untrusted: true, intent: "What is the status of the checkout work?", supervisorAutoApprove: true }
  };
  const unsafePref = await reg.invoke("fleet_preferences", { defaultPermissionMode: "bypass" }, statusCtx);
  assert.equal(unsafePref.ok, true);
  assert.equal(unsafePref.result?.status, "awaiting_owner_confirmation");
  assert.equal(prefCalls, 0);

  // Notification cadence bookkeeping still runs directly without confirmation.
  const safePref = await reg.invoke("fleet_preferences", { cadence: "off" }, statusCtx);
  assert.equal(safePref.ok, true);
  assert.equal(safePref.result?.status, "updated");
  assert.equal(prefCalls, 1);

  // 2. Unconfirmed queued delivery is removed immediately and NEVER replayed on a subsequent drain.
  const dir2 = makeTmpDir(t, "unconfirmed-q-");
  let deliverCalls = 0;
  const sup2 = new FleetSupervisor({
    dataDir: dir2,
    config: { mode: "propose", paseo: { enabled: true, only: true } },
    deps: {
      executor: {
        async deliver() {
          deliverCalls += 1;
          return {
            status: "blocked",
            unconfirmed: true,
            route: "paseo-send",
            detail: "Previous delivery has no confirmed turn; no automatic resend"
          };
        }
      }
    }
  });
  const thread2 = {
    key: "paseo:host1.agent-unc",
    kind: "paseo",
    id: "agent-unc",
    title: "Checkout PR #910",
    cwd: "/work/app",
    agentStatus: "running",
    meta: { serverId: "host1", paseoCwd: "/work/app" }
  };
  sup2.lastThreads.set(thread2.key, thread2);
  await sup2.sendOwnerMessage(thread2.key, "Run final deploy checks");
  assert.equal(sup2.store.queuedOwnerMessages(thread2.key).length, 1);
  sup2.lastThreads.set(thread2.key, { ...thread2, agentStatus: "idle" });
  const firstDrain = await sup2.drainQueuedOwnerMessages();
  assert.equal(firstDrain.length, 1);
  assert.equal(firstDrain[0].status, "unconfirmed");
  assert.equal(sup2.store.queuedOwnerMessages(thread2.key).length, 0, "unconfirmed delivery must not remain in retry queue");
  const secondDrain = await sup2.drainQueuedOwnerMessages();
  assert.equal(secondDrain.length, 0);
  assert.equal(deliverCalls, 1, "must never automatically resend an unconfirmed delivery");

  // 3. set_provider rejects unsupported reasoningEffort ('xhigh' on 'gpt-5') and rolls back env cleanly.
  const dir3 = makeTmpDir(t, "effort-val-");
  const prevEnv = {
    OPENAGI_DATA_DIR: process.env.OPENAGI_DATA_DIR,
    OPENAGI_PROVIDER: process.env.OPENAGI_PROVIDER,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    OPENAI_REASONING_EFFORT_TASK_CHAT: process.env.OPENAI_REASONING_EFFORT_TASK_CHAT
  };
  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetDataDirCache();
  });
  process.env.OPENAGI_DATA_DIR = dir3;
  _resetDataDirCache();
  process.env.OPENAGI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "sk-test-fake-key-1234567890";
  process.env.OPENAI_MODEL = "gpt-5.4";
  delete process.env.OPENAI_REASONING_EFFORT_TASK_CHAT;
  const store3 = new InMemoryAgentStore({ storePath: path.join(dir3, "sessions.json") });
  store3.saveSession({ id: "devices:supervisor:main", messages: [], metadata: {} });
  const runtime3 = {
    agentHost: { store: store3, modelProvider: { constructor: { name: "OpenAIResponsesProvider" }, model: "gpt-5.4" } },
    budget: null
  };
  const reg3 = new ToolRegistry();
  registerCoreTools(reg3, runtime3);
  const badEffort = await reg3.invoke("set_provider", { model: "gpt-5", reasoningEffort: "xhigh" }, { sessionId: "devices:supervisor:main" });
  assert.equal(badEffort.ok, true);
  assert.equal(badEffort.result.ok, false);
  assert.match(badEffort.result.error, /not supported/i);
  assert.equal(process.env.OPENAI_MODEL, "gpt-5.4", "model env must roll back on unsupported effort");
  assert.equal(process.env.OPENAI_REASONING_EFFORT_TASK_CHAT, undefined, "unsupported effort must not be persisted");

  // 4. Duplicate or blocked match in startPaseoSession NEVER falls through to api.agents.create.
  let createCalls = 0;
  const dupFactory = () => ({
    connect: async () => {},
    close: async () => {},
    hosts: { list: async () => ({ self: { serverId: "host1" }, hosts: [] }) },
    agents: {
      list: async () => ({ agents: [] }),
      create: async () => { createCalls += 1; return { id: "clone-bad" }; }
    }
  });
  const dupSup = {
    config: { paseo: { enabled: true } },
    lastThreads: new Map([[thread2.key, { ...thread2, agentStatus: "idle" }]]),
    knownThreads: new Map(),
    store: { recordAction() {} },
    sendOwnerMessage: async () => ({ delivery: { status: "blocked", duplicate: true, route: "paseo-send", detail: "already in this chat" } })
  };
  const dupRes = await startPaseoSession(dupSup, {
    title: "Checkout PR #910",
    prompt: "Run final deploy checks",
    cwd: "/work/app",
    serverId: "host1",
    factory: dupFactory
  });
  assert.equal(dupRes.reused, true);
  assert.equal(dupRes.duplicate, true);
  assert.equal(createCalls, 0, "duplicate match must reuse existing session without spawning a clone");

  dupSup.sendOwnerMessage = async () => ({ delivery: { status: "blocked", route: null, detail: "permission prompt pending" } });
  const blkRes = await startPaseoSession(dupSup, {
    title: "Checkout PR #910",
    prompt: "Another instruction",
    cwd: "/work/app",
    serverId: "host1",
    factory: dupFactory
  });
  assert.equal(blkRes.status, "blocked");
  assert.equal(blkRes.reused, true);
  assert.equal(createCalls, 0, "blocked existing session must not silently fall through to create a clone");

  // 5. Local hub postSupervisorChatUpdate routes through runtime.hubProactiveGuard and shares cooldown with remote appends!
  const dir5 = makeTmpDir(t, "shared-hub-guard-");
  let now5 = Date.parse("2026-11-24T20:00:00.000Z");
  const sessionStore5 = new InMemoryAgentStore({ storePath: path.join(dir5, "sessions.json") });
  sessionStore5.saveSession({ id: "devices:supervisor:main", messages: [], metadata: {} });
  const sharedGuard = createHubProactiveGuard({
    getPreferences: () => ({ cadence: "balanced", checkinCooldownMinutes: 30 }),
    getRecentMessages: () => sessionStore5.getSession("devices:supervisor:main")?.messages ?? [],
    now: () => now5,
    judgeProactiveUpdate: async ({ candidateText }) => ({ send: true, text: candidateText, reason: "ok" })
  });
  const sup5 = new FleetSupervisor({
    dataDir: dir5,
    runtime: { agentHost: { store: sessionStore5 }, hubProactiveGuard: sharedGuard, events: { emit() {} } },
    config: { mode: "propose", proactiveSupervisorChat: true, paseo: { enabled: true, only: true } },
    deps: { now: () => now5 }
  });
  const localPost = await sup5.postSupervisorChatUpdate("**Supervisor check-in: one decision needs you.**\nLocal decision A", {
    dedupeKey: "local-a",
    metadata: { kind: "proactive_supervisor_delta", decisionKeys: ["k:a"], decisionTokens: ["k:a:h1"] }
  });
  assert.equal(localPost.posted, true);
  // 2 minutes later, a paired-node append hits the EXACT SAME hub guard and is deferred by global cooldown!
  now5 += 2 * 60_000;
  const remoteAttempt = await sharedGuard.evaluate({
    text: "**Supervisor check-in: one decision needs you.**\nRemote decision B",
    decisionKeys: ["k:b"],
    decisionTokens: ["k:b:h1"]
  });
  assert.equal(remoteAttempt.send, false);
  assert.equal(remoteAttempt.deferred, true);
  assert.equal(remoteAttempt.reason, "hub_cooldown");
});
