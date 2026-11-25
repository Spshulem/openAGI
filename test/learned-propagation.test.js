// Propagation by measured need: the randomized specialist comparison
// (OPENAGI_ROUTING_MODE=experiment) and need-based spawning by topic
// (OPENAGI_LEARNED_PROPAGATION).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableRuntime, DeterministicModelProvider } from "../src/index.js";
import { PropagationController, clusterRuleFires } from "../src/propagation-controller.js";
import { SpecialistRouter } from "../src/specialist-router.js";
import { ClusterStats } from "../src/learning/cluster-stats.js";
import { GroundedOutcomes } from "../src/learning/grounded-outcomes.js";
import { OutcomeStore } from "../src/outcome-store.js";
import { specialistExperimentVerdicts } from "../src/learning/specialist-experiment.js";
import { LEARNED_ENV_UNSET, fakeScoringService, withEnv } from "./support/fake-scoring-service.js";

const DAY_MS = 86_400_000;
const SCOPE = "weekly acme pipeline follow-up email";

function tempDir(t, prefix = "openagi-learned-propagation-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function sequence(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

function makeSpecialist(controller = new PropagationController()) {
  return controller.propagate({
    signal: { domain: "sales", taskType: "follow-up", tags: ["message", "local", "acme"], summary: SCOPE, specialistScope: SCOPE },
    workflow: null,
    scrutiny: { reasons: ["r"] },
    tools: []
  }).specialist;
}

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

// ── A. randomized comparison ─────────────────────────────────────────────

test("experiment mode routes about half of 1,000 matched turns with a seeded random source", async () => {
  const sp = makeSpecialist();
  const router = new SpecialistRouter({ mode: "experiment", random: seededRandom(7) });
  let routed = 0;
  for (let i = 0; i < 1000; i += 1) {
    const decision = await router.decide(SCOPE, ["message"], [sp]);
    assert.ok(decision.candidate);
    assert.equal(decision.route, decision.arm === "specialist");
    if (decision.route) routed += 1;
  }
  assert.ok(routed > 450 && routed < 550, `routed ${routed} of 1000`);
});

test("experiment mode follows an injected random sequence exactly", async () => {
  const sp = makeSpecialist();
  const router = new SpecialistRouter({ mode: "experiment", random: sequence([0.1, 0.9, 0.49, 0.5]) });
  const arms = [];
  for (let i = 0; i < 4; i += 1) arms.push((await router.decide(SCOPE, ["message"], [sp])).arm);
  assert.deepEqual(arms, ["specialist", "generalist", "specialist", "generalist"]);
});

test("the arm is reported whenever a candidate matched: shadow generalist, live specialist; never without a match", async () => {
  const sp = makeSpecialist();
  const shadow = await new SpecialistRouter({ mode: "shadow" }).decide(SCOPE, ["message"], [sp]);
  assert.equal(shadow.arm, "generalist");
  assert.equal(shadow.route, false);
  const live = await new SpecialistRouter({ mode: "live" }).decide(SCOPE, ["message"], [sp]);
  assert.equal(live.arm, "specialist");
  assert.equal(live.route, true);
  const unmatched = await new SpecialistRouter({ mode: "experiment", random: () => 0 }).decide("nothing related at all", ["message"], [sp]);
  assert.equal(Object.hasOwn(unmatched, "arm"), false);
  assert.equal(unmatched.route, false);
  assert.deepEqual(await new SpecialistRouter({ mode: "off" }).decide(SCOPE, ["message"], [sp]), { mode: "off", route: false, candidate: null, all: [] });
});

class DraftingProvider extends DeterministicModelProvider {
  async generate({ toolRegistry, context }) {
    await toolRegistry.invoke("save_draft", { title: "Acme follow-up", body: "Following up on the pipeline.", kind: "email" },
      { ...context, __scrutinyPolicy: null });
    return { provider: "t", model: "t", text: "Drafted.", toolCalls: [{ name: "save_draft", ok: true }] };
  }
}

async function experimentTurn(t, random) {
  const runtime = createDurableRuntime({
    dataDir: tempDir(t),
    modelProvider: new DraftingProvider(),
    autoConnectMcp: false,
    routerOptions: { mode: "experiment", random }
  });
  const sp = makeSpecialist(runtime.propagation);
  runtime.agentHost.ensureSpecialistAgent(sp, "main");
  await settle();
  await runtime.agentHost.handleMessage({ channel: "local", from: "user", text: SCOPE });
  const outcomes = [...runtime.outcomes.outcomes.values()];
  return {
    runtime,
    sp,
    turn: outcomes.find((o) => o.kind === "agent-reply"),
    draft: outcomes.find((o) => o.kind === "work-draft")
  };
}

test("experiment: the arm and candidate reach the turn's outcome and the work it produced", async (t) => {
  await withEnv(LEARNED_ENV_UNSET, async () => {
    const specialistArm = await experimentTurn(t, () => 0.1);
    assert.equal(specialistArm.turn.agentId, specialistArm.sp.id, "the specialist took the turn");
    assert.equal(specialistArm.turn.metadata.routing.arm, "specialist");
    assert.equal(specialistArm.turn.metadata.routing.routed, true);
    assert.equal(specialistArm.draft.metadata.routingArm, "specialist");
    assert.equal(specialistArm.draft.metadata.routingCandidateId, specialistArm.sp.id);

    const generalistArm = await experimentTurn(t, () => 0.9);
    assert.equal(generalistArm.turn.agentId, "main");
    assert.equal(generalistArm.turn.metadata.routing.arm, "generalist");
    assert.equal(generalistArm.turn.metadata.routing.candidateId, generalistArm.sp.id);
    assert.equal(generalistArm.draft.metadata.routingArm, "generalist");
    assert.equal(generalistArm.draft.metadata.routingCandidateId, generalistArm.sp.id);
  });
});

test("experiment mode registers the daily verdict job; the default does not", async (t) => {
  await withEnv(LEARNED_ENV_UNSET, () => {
    const plain = createDurableRuntime({ dataDir: tempDir(t), modelProvider: new DeterministicModelProvider(), autoConnectMcp: false });
    assert.equal(plain.cron.listJobs().some((job) => job.id === "specialist-experiment"), false);
    const experiment = createDurableRuntime({
      dataDir: tempDir(t), modelProvider: new DeterministicModelProvider(), autoConnectMcp: false, routerOptions: { mode: "experiment" }
    });
    const job = experiment.cron.listJobs().find((entry) => entry.id === "specialist-experiment");
    assert.equal(job?.task, "specialist-experiment");
    assert.equal(job?.dailyAt, "04:55");
  });
});

function graded(candidateId, arm, score, { weak = false, nested = false } = {}) {
  return {
    groundedScore: score,
    groundedWeak: weak,
    metadata: nested ? { routing: { candidateId, arm } } : { routingCandidateId: candidateId, routingArm: arm }
  };
}

function arms(candidateId, specialistScores, generalistScores) {
  return [
    ...specialistScores.map((score, i) => graded(candidateId, "specialist", score, { nested: i % 2 === 0 })),
    ...generalistScores.map((score) => graded(candidateId, "generalist", score))
  ];
}

const spread = (n, center) => Array.from({ length: n }, (_, i) => Math.max(0, Math.min(1, center + ((i % 5) - 2) * 0.05)));

test("verdicts: clearly better earns its keep, clearly worse retires, too few per arm is undecided", () => {
  const outcomes = [
    ...arms("agent_better", spread(25, 0.85), spread(25, 0.4)),
    ...arms("agent_worse", spread(25, 0.3), spread(25, 0.8)),
    ...arms("agent_few", spread(10, 0.9), spread(10, 0.2)),
    ...arms("agent_tied", spread(30, 0.6), spread(30, 0.6)),
    // Weak and arm-less outcomes never count.
    ...Array.from({ length: 30 }, () => graded("agent_few", "specialist", 0.9, { weak: true })),
    { groundedScore: 1, groundedWeak: false, metadata: { routingCandidateId: "agent_few" } }
  ];
  const verdicts = specialistExperimentVerdicts(outcomes);
  assert.equal(verdicts.get("agent_better").verdict, "earned");
  assert.ok(verdicts.get("agent_better").interval[0] > 0);
  assert.equal(verdicts.get("agent_worse").verdict, "retire");
  assert.ok(verdicts.get("agent_worse").interval[1] < 0);
  assert.equal(verdicts.get("agent_few").verdict, "undecided");
  assert.equal(verdicts.get("agent_few").interval, null);
  assert.equal(verdicts.get("agent_few").specialist.n, 10);
  assert.equal(verdicts.get("agent_tied").verdict, "undecided");
  assert.deepEqual(specialistExperimentVerdicts(outcomes).get("agent_better"), verdicts.get("agent_better"), "deterministic");
});

test("the retirement sweep retires a specialist whose comparison says retire, and only that one", () => {
  const controller = new PropagationController();
  const worse = makeSpecialist(controller);
  const better = controller.propagate({
    signal: { domain: "ops", taskType: "triage", summary: "triage", specialistScope: "triage" }, workflow: null, scrutiny: {}, tools: []
  }).specialist;
  worse.experimentVerdict = "retire";
  better.experimentVerdict = "earned";
  const retired = controller.retirementSweep({ now: new Date() });
  assert.deepEqual(retired.map((sp) => sp.id), [worse.id]);
  assert.match(worse.retirementReason, /randomized comparison/);
  assert.equal(better.status, "available");
});

test("the daily job sets verdicts from the outcome store and persists them", async (t) => {
  const dataDir = tempDir(t);
  const runtime = createDurableRuntime({ dataDir, modelProvider: new DeterministicModelProvider(), autoConnectMcp: false });
  const sp = makeSpecialist(runtime.propagation);
  runtime.propagation.save();
  for (const outcome of arms(sp.id, spread(25, 0.3), spread(25, 0.8))) {
    const recorded = runtime.outcomes.recordWork({ kind: "work-draft", refId: `d_${Math.random()}`, metadata: outcome.metadata });
    runtime.outcomes.ground(recorded.id, { score: outcome.groundedScore, source: "test", fate: "approved" });
  }
  const summary = await runtime.runJobTask({ task: "specialist-experiment" });
  assert.deepEqual(summary, { specialists: 1, changed: 1, byVerdict: { retire: 1 } });
  assert.equal(sp.experimentVerdict, "retire");
  assert.equal(sp.experiment.specialist.n, 25);
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "agents", "specialists.json"), "utf8"));
  assert.equal(stored.specialists.find((entry) => entry.id === sp.id).experimentVerdict, "retire");
});

test("work outcomes carry the routing arm only when the signal has one", (t) => {
  const outcomes = new OutcomeStore({ dir: tempDir(t) });
  const grounded = new GroundedOutcomes({ runtime: { outcomes } });
  const signal = { id: "sig_1", scrutinyAction: "act", routingCandidateId: "agent_x", routingArm: "generalist" };
  const draft = grounded.onDraftCreated({ id: "draft_1", title: "t" }, signal);
  assert.equal(draft.metadata.routingArm, "generalist");
  assert.equal(draft.metadata.routingCandidateId, "agent_x");
  const task = grounded.onAgentTaskCompleted({ id: "task_1", title: "t" }, signal);
  assert.equal(task.metadata.routingArm, "generalist");
  assert.equal(task.metadata.byAgent, true);
  const plain = grounded.onDraftCreated({ id: "draft_2", title: "t" }, { id: "sig_2" });
  assert.equal(Object.hasOwn(plain.metadata, "routingArm"), false);
  assert.equal(Object.hasOwn(plain.metadata, "routingCandidateId"), false);
});

// ── B. need-based spawning ───────────────────────────────────────────────

const plainSignal = { requiresSpecialist: false, repetition: 0.1, risk: 0.1, novelty: 0.1 };

test("the cluster rule fires at n = 15 and mean = overall - 0.15, not at n = 14 or mean = overall - 0.05", () => {
  assert.equal(clusterRuleFires({ n: 15, mean: 0.45, overallMean: 0.6 }), true);
  assert.equal(clusterRuleFires({ n: 14, mean: 0.45, overallMean: 0.6 }), false);
  assert.equal(clusterRuleFires({ n: 15, mean: 0.55, overallMean: 0.6 }), false);
  assert.equal(clusterRuleFires(null), false);
  assert.equal(clusterRuleFires({ n: 30, mean: null, overallMean: 0.6 }), false);
  const controller = new PropagationController();
  const fires = controller.shouldPropagate({ signal: plainSignal, scrutiny: {}, clusterStats: { n: 15, mean: 0.45, overallMean: 0.6 }, learnedMode: "shadow" });
  assert.equal(fires.learnedDecision, true);
  const tooFew = controller.shouldPropagate({ signal: plainSignal, scrutiny: {}, clusterStats: { n: 14, mean: 0.45, overallMean: 0.6 }, learnedMode: "shadow" });
  assert.equal(tooFew.learnedDecision, false);
});

test("shadow leaves the decision unchanged and adds the learned one", () => {
  const controller = new PropagationController();
  for (const signal of [plainSignal, { ...plainSignal, repetition: 0.9 }, { ...plainSignal, requiresSpecialist: true }]) {
    const off = controller.shouldPropagate({ signal, scrutiny: {} });
    const shadow = controller.shouldPropagate({ signal, scrutiny: {}, clusterStats: { n: 20, mean: 0.2, overallMean: 0.7 }, learnedMode: "shadow" });
    const { learnedDecision, ...rest } = shadow;
    assert.deepEqual(rest, off);
    assert.equal(learnedDecision, true);
  }
  assert.deepEqual(Object.keys(controller.shouldPropagate({ signal: plainSignal, scrutiny: {} })),
    ["decision", "repeated", "novelAndRisky", "explicitlyRequired", "underCovered", "memoryCoverage", "blockedBy"]);
});

test("live drops the keyword triggers but keeps explicit requests, and spawns where the generalist is weak", () => {
  const controller = new PropagationController();
  const repeated = { ...plainSignal, repetition: 0.9 };
  assert.equal(controller.shouldPropagate({ signal: repeated, scrutiny: {} }).decision, true, "keyword rule spawns");
  const live = controller.shouldPropagate({ signal: repeated, scrutiny: {}, learnedMode: "live" });
  assert.equal(live.decision, false);
  assert.equal(live.ruleDecision, true);
  assert.equal(controller.shouldPropagate({ signal: { ...plainSignal, requiresSpecialist: true }, scrutiny: {}, learnedMode: "live" }).decision, true);
  assert.equal(controller.shouldPropagate({ signal: plainSignal, scrutiny: { action: "propagate" }, learnedMode: "live" }).decision, true);
  assert.equal(controller.shouldPropagate({ signal: plainSignal, scrutiny: {}, clusterStats: { n: 20, mean: 0.2, overallMean: 0.7 }, learnedMode: "live" }).decision, true);
});

test("ClusterStats: 30-day stats, regrades replace, removals withdraw, old buckets are pruned, and it persists", (t) => {
  const dir = tempDir(t);
  let now = Date.parse("2026-03-31T12:00:00Z");
  const stats = new ClusterStats({ dir, now: () => now });
  assert.equal(fs.existsSync(path.join(dir, "cluster-stats.json")), false, "nothing written before first use");
  assert.deepEqual(stats.stats(7), { n: 0, mean: null });
  stats.record(7, 0.2, new Date(now - 1 * DAY_MS).toISOString(), "out_a");
  stats.record(7, 0.4, new Date(now - 2 * DAY_MS).toISOString(), "out_b");
  stats.record("9", 1, new Date(now).toISOString(), "out_c");
  stats.record(7, 1, new Date(now - 32 * DAY_MS).toISOString(), "out_old");
  assert.deepEqual(stats.stats(7), { n: 2, mean: 0.30000000000000004 });
  assert.equal(stats.overall().n, 3);
  stats.record(7, 0.6, new Date(now - 1 * DAY_MS).toISOString(), "out_a");
  assert.equal(stats.stats(7).n, 2, "a regrade replaces");
  assert.ok(Math.abs(stats.stats(7).mean - 0.5) < 1e-9);
  stats.remove("out_b");
  assert.deepEqual(stats.stats(7), { n: 1, mean: 0.6 });
  const reloaded = new ClusterStats({ dir, now: () => now });
  assert.deepEqual(reloaded.stats(7), { n: 1, mean: 0.6 });
  assert.deepEqual(reloaded.stats(9), { n: 1, mean: 1 });
  now += 40 * DAY_MS;
  reloaded.record(9, 0.5, new Date(now).toISOString(), "out_d");
  const file = JSON.parse(fs.readFileSync(path.join(dir, "cluster-stats.json"), "utf8"));
  assert.deepEqual(Object.keys(file.clusters), ["9"]);
  assert.deepEqual(Object.keys(file.entries), ["out_d"]);
});

function serviceRuntime(t, routes = {}, extra = {}) {
  const service = fakeScoringService(tempDir(t), routes);
  const dataDir = tempDir(t);
  const runtime = createDurableRuntime({ dataDir, modelClient: service.client, modelProvider: new DeterministicModelProvider(), autoConnectMcp: false, ...extra });
  return { service, runtime, dataDir };
}

test("work outcomes get their topic, and grading folds the generalist's grades into it", async (t) => {
  await withEnv(LEARNED_ENV_UNSET, async () => {
    const { service, runtime, dataDir } = serviceRuntime(t);
    const draft = runtime.drafts.add({ title: "Acme follow-up", body: "Hello", kind: "email" });
    runtime.grounded.onDraftCreated(draft, { id: "sig_1" });
    const specialistDraft = runtime.drafts.add({ title: "Acme renewal", body: "Hello", kind: "email" });
    runtime.grounded.onDraftCreated(specialistDraft, { id: "sig_2", specialistId: "agent_s" });
    await settle();
    const outcome = runtime.outcomes.byWorkRef("work-draft", draft.id);
    assert.equal(outcome.metadata.clusterId, 7);
    assert.deepEqual(service.calls.find((call) => call.key === "POST /cluster-of").body, { text: "Acme follow-up" });
    runtime.drafts.approve(draft.id);
    runtime.drafts.approve(specialistDraft.id);
    assert.deepEqual(runtime.clusterStats.stats(7), { n: 1, mean: 1 }, "only the generalist's work counts");
    assert.ok(fs.existsSync(path.join(dataDir, "learning", "cluster-stats.json")));
  });
});

test("nothing asks for topics while need-based spawning is off", async (t) => {
  await withEnv({ ...LEARNED_ENV_UNSET, OPENAGI_LEARNED_PROPAGATION: "off" }, async () => {
    const { service, runtime, dataDir } = serviceRuntime(t);
    const draft = runtime.drafts.add({ title: "Acme follow-up", body: "Hello", kind: "email" });
    runtime.grounded.onDraftCreated(draft, { id: "sig_1" });
    await settle();
    runtime.drafts.approve(draft.id);
    assert.equal(service.calls.some((call) => call.key === "POST /cluster-of"), false);
    assert.equal(runtime.learnedClusterStats(), null);
    assert.equal(fs.existsSync(path.join(dataDir, "learning")), false);
  });
});

function seedWeakTopic(runtime) {
  const stats = runtime.learnedClusterStats();
  const at = new Date().toISOString();
  for (let i = 0; i < 15; i += 1) stats.record(7, 0.2, at, `weak_${i}`);
  for (let i = 0; i < 30; i += 1) stats.record(3, 0.9, at, `strong_${i}`);
}

const SIGNAL = {
  id: "sig_topic", source: "test", type: "message", summary: "acme pipeline numbers", content: "acme pipeline numbers",
  citations: ["a", "b"], urgency: 0.5, impact: 0.5, risk: 0.1, novelty: 0.1, repetition: 0.1
};

test("processSignal: shadow records the need-based decision and spawns nothing more", async (t) => {
  await withEnv(LEARNED_ENV_UNSET, () => {
    const { runtime } = serviceRuntime(t);
    seedWeakTopic(runtime);
    const before = runtime.propagation.list().length;
    const output = runtime.processSignal({ ...SIGNAL, learned: { cluster: 7 } }, { isolatedContext: true });
    assert.deepEqual(output.learnedPropagation, { mode: "shadow", clusterId: 7, explicitlyRequired: false, ruleDecision: false, learnedDecision: true });
    assert.equal(output.propagation.created, false);
    assert.equal(runtime.propagation.list().length, before);
  });
});

test("processSignal: live spawns where the generalist is weak on the topic", async (t) => {
  await withEnv({ ...LEARNED_ENV_UNSET, OPENAGI_LEARNED_PROPAGATION: "live" }, () => {
    const { runtime } = serviceRuntime(t);
    seedWeakTopic(runtime);
    const output = runtime.processSignal({ ...SIGNAL, learned: { cluster: 7 } }, { isolatedContext: true });
    assert.equal(output.learnedPropagation.learnedDecision, true);
    assert.equal(output.learnedPropagation.ruleDecision, false);
    assert.equal(output.propagation.created, true);
    const strong = runtime.processSignal({ ...SIGNAL, id: "sig_strong", learned: { cluster: 3 } }, { isolatedContext: true });
    assert.equal(strong.learnedPropagation.learnedDecision, false);
  });
});

test("a chat turn in shadow records its topic and the need-based decision on its outcome", async (t) => {
  await withEnv(LEARNED_ENV_UNSET, async () => {
    const { runtime } = serviceRuntime(t);
    seedWeakTopic(runtime);
    await runtime.agentHost.handleMessage({ channel: "local", from: "user", text: "how are the acme pipeline numbers" });
    await settle();
    const turn = runtime.outcomes.recent(10).find((o) => o.kind === "agent-reply");
    assert.equal(turn.metadata.learnedPropagation.mode, "shadow");
    assert.equal(turn.metadata.learnedPropagation.clusterId, 7);
    assert.equal(turn.metadata.learnedPropagation.learnedDecision, true);
    assert.equal(typeof turn.metadata.learnedPropagation.ruleDecision, "boolean");
  });
});
