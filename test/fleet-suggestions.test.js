import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FleetStore } from "../src/fleet/store.js";
import { FleetSupervisor } from "../src/fleet/supervisor.js";
import { SuggestionManager, autoGate, suggestionFingerprint } from "../src/fleet/suggestions.js";
import { DAY_MS } from "../src/fleet/diagnose.js";
import { resolveFleetConfig } from "../src/fleet/contracts.js";
import { createFleetRoute } from "../src/fleet/routes.js";
import { createFleetCapability, RemoteFleetSupervisor } from "../src/fleet/remote.js";
import { isMobileRouteAllowed } from "../src/mobile-node.js";
import { createNotifier } from "../src/fleet/notify.js";

const NOW = new Date(2026, 9, 13, 12).getTime();
const explanation = { remedy: "code", nextAction: "Reproduce the repeated ask and repair its cause", anomalyId: "anomaly-0", area: "policy", rootCause: "The same unanswered ask returns", proposedFix: "Keep closed asks closed", acceptance: "No repeated ask", evidenceActionIds: ["a1"], confidence: 0.85, minutesSavedPerDay: 4 };
const report = { anomalies: [{ id: "anomaly-0", metric: "questions-unanswered", area: "policy", eventsPerDay: 10, evidenceActionIds: ["a1"], feedbackIds: [] }] };
function fixture(t, mode = "propose") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-suggestions-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = NOW;
  const now = () => clock;
  const store = new FleetStore({ dir: path.join(dir, "fleet"), now });
  const calls = { explain: 0, duplicate: 0, pushes: 0 };
  const config = resolveFleetConfig({}, { home: dir, selfFix: { mode } });
  const manager = new SuggestionManager({ store, config, now, queueFix: (input) => store.queueFix(input),
    models: { explain: async () => { calls.explain += 1; return explanation; }, duplicate: async () => { calls.duplicate += 1; return false; } },
    notify: async (q, { allowPush } = {}) => {
      if (q.pushedAt || !allowPush) return { pushed: false };
      calls.pushes += 1;
      store.recordPush(new Date(clock).toISOString());
      store.markQuestionNotified(q.id, { pushedAt: new Date(clock).toISOString() });
      return { pushed: true };
    } });
  const candidate = (i = 0, patch = {}) => {
    const value = { ...explanation, metric: `metric-${i}`, score: 30 - i, evidence: { actionIds: ["a1"], feedbackIds: [] }, ...patch };
    return { ...value, fingerprint: suggestionFingerprint(value) };
  };
  return { dir, store, config, manager, calls, candidate, now, setNow: (n) => { clock = n; } };
}

test("no model without anomalies, one explanation plus luna duplicate check when anomalous", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.manager.propose({ anomalies: [] }), []);
  assert.equal(f.calls.explain, 0); assert.equal(f.calls.duplicate, 0);
  const [s] = await f.manager.propose(report);
  assert.equal(s.score, 34);
  assert.deepEqual(s.evidence.actionIds, ["a1"]);
  assert.equal(f.calls.explain, 1); assert.equal(f.calls.duplicate, 1);
  await f.manager.publish([s]);
  assert.deepEqual(await f.manager.propose(report), []);
  assert.equal(f.calls.duplicate, 1, "exact fingerprint bypasses model duplicate check");
});

test("fingerprint canonicalization, semantic dedupe and untrusted evidence filtering", async (t) => {
  const f = fixture(t);
  assert.equal(suggestionFingerprint({ metric: "M", area: "policy", rootCause: "Same cause!" }), suggestionFingerprint({ metric: "m", area: "Policy", rootCause: " same  cause " }));
  f.manager.models.explain = async () => ({ ...explanation, evidenceActionIds: ["invented"] });
  assert.deepEqual((await f.manager.propose(report))[0].evidence.actionIds, []);
  f.manager.models.duplicate = async () => true;
  assert.deepEqual(await f.manager.propose(report), []);
});

test("covered anomalies leave the explanation call for other metrics and areas", async (t) => {
  for (const status of ["open", "fix-queued", "never", "snoozed"]) {
    const f = fixture(t);
    f.store.saveSuggestion({ ...f.candidate(0, { metric: report.anomalies[0].metric }), id: "existing", status,
      updatedAt: new Date(NOW - 8 * DAY_MS).toISOString(), snoozedUntil: new Date(NOW + DAY_MS).toISOString() });
    const otherMetric = { ...report.anomalies[0], id: "other-metric", metric: "repeat-nudge" };
    const otherArea = { ...report.anomalies[0], id: "other-area", area: "review" };
    let seen;
    f.manager.models.explain = async ({ anomalies }) => {
      f.calls.explain += 1; seen = anomalies;
      return { ...explanation, anomalyId: anomalies[0].id };
    };
    const [candidate] = await f.manager.propose({ anomalies: [...report.anomalies, otherMetric, otherArea] });
    assert.deepEqual(seen, [otherMetric, otherArea], status);
    assert.equal(candidate.metric, "repeat-nudge");
    assert.equal(f.calls.explain, 1);
    assert.deepEqual(await f.manager.propose(report), []);
    assert.equal(f.calls.explain, 1, "all covered means no model call");
  }
});

test("at most three open and one push per local day, including repeated refresh", async (t) => {
  const f = fixture(t);
  await f.manager.publish([f.candidate(3), f.candidate(2), f.candidate(1), f.candidate(0)]);
  assert.equal(f.store.suggestions().length, 3);
  assert.equal(f.store.openQuestions().length, 3);
  assert.equal(f.calls.pushes, 1);
  await f.manager.refresh(); assert.equal(f.calls.pushes, 1);
  f.setNow(NOW + DAY_MS);
  f.manager.respond(f.store.suggestions()[0].id, "Never");
  await f.manager.publish([f.candidate(4)]); assert.equal(f.calls.pushes, 2);
  const reloaded = new FleetStore({ dir: f.store.dir, now: f.now });
  assert.equal(reloaded.suggestions().filter((s) => s.status === "open").length, 3);
});

test("quiet hours and shared pushPerHour gate suggestions; retry later in the day", async (t) => {
  const f = fixture(t);
  f.setNow(new Date(2026, 9, 13, 23).getTime());
  await f.manager.publish([f.candidate()]); assert.equal(f.calls.pushes, 0);
  f.setNow(new Date(2026, 9, 14, 8).getTime());
  for (let i = 0; i < 3; i += 1) f.store.recordPush(new Date(f.now()).toISOString());
  await f.manager.refresh(); assert.equal(f.calls.pushes, 0);
  f.setNow(f.now() + 3600001);
  await f.manager.refresh(); assert.equal(f.calls.pushes, 1);
});

test("the daily push cap still creates every local outreach question", async (t) => {
  const f = fixture(t);
  const items = [];
  let pushes = 0;
  const notifier = createNotifier({ config: { ...f.config, push: "buzzkit" }, store: f.store, now: f.now,
    readFile: () => "https://push.example.invalid/endpoint", fetchImpl: async () => { pushes += 1; return { ok: true }; },
    runtime: { outreach: { append: (item) => { items.push(item); return { id: `out-${items.length}` }; } } } });
  f.manager.notify = notifier.notifyQuestion;
  await f.manager.publish([f.candidate(0), f.candidate(1), f.candidate(2)]);
  assert.equal(items.length, 3); assert.equal(pushes, 1);
  assert.equal(f.store.openQuestions().filter((q) => q.outreachId).length, 3);
});

test("Never blocks permanently, Not now snoozes seven days; both survive reload", async (t) => {
  const f = fixture(t);
  await f.manager.publish([f.candidate(0), f.candidate(1)]);
  const [never, later] = f.store.suggestions();
  f.manager.respond(never.id, "Never"); f.manager.respond(later.id, "Not now");
  assert.equal(f.store.openQuestions().length, 0);
  f.setNow(NOW + 6 * DAY_MS); await f.manager.refresh();
  assert.equal(f.store.suggestions().find((s) => s.id === later.id).status, "snoozed");
  f.setNow(NOW + 7 * DAY_MS); await f.manager.refresh();
  assert.equal(f.store.suggestions().find((s) => s.id === later.id).status, "open");
  f.setNow(NOW + 30 * DAY_MS);
  await f.manager.publish([f.candidate(0)]);
  const reloaded = new FleetStore({ dir: f.store.dir });
  assert.equal(reloaded.suggestions().filter((s) => s.fingerprint === never.fingerprint).length, 1);
  assert.equal(reloaded.suggestions().find((s) => s.id === never.id).status, "never");
});

test("Fix it uses the same queueFix path, is idempotent and links feedback", async (t) => {
  const f = fixture(t);
  const feedback = f.store.recordFeedback({ intent: "change", utterance: "Stop repeating", target: { threadKey: "t" } });
  await f.manager.publish([f.candidate(0, { evidence: { actionIds: ["a1"], feedbackIds: [feedback.id] } })]);
  const s = f.store.suggestions()[0];
  assert.equal(f.store.feedback()[0].status, "triaged");
  const result = await f.manager.respond(s.id, "Fix it");
  assert.equal(result.fix.state, "queued");
  assert.deepEqual(result.fix.evidence.suggestionIds, [s.id]);
  assert.equal(f.store.feedback()[0].status, "fix-queued");
  f.manager.respond(s.id, "Fix it"); assert.equal(f.store.fixes().length, 1);
  assert.equal(f.store.openQuestions().length, 0);
});

test("auto gate: confidence, mode, global/area locks and three-per-day cap", () => {
  const base = { mode: "auto", fixes: [], now: NOW };
  assert.equal(autoGate(explanation, base), true);
  for (const mode of ["propose", "off"]) assert.equal(autoGate(explanation, { ...base, mode }), false);
  assert.equal(autoGate({ ...explanation, confidence: 0.79 }, base), false);
  assert.equal(autoGate({ ...explanation, confidence: 0.8 }, base), true);
  assert.equal(autoGate(explanation, { ...base, areaLocks: { policy: "fix-1" } }), false);
  assert.equal(autoGate(explanation, { ...base, fixes: [{ area: "review", state: "queued" }] }), false);
  assert.equal(autoGate(explanation, { ...base, fixes: Array.from({ length: 3 }, () => ({ createdAt: new Date(NOW).toISOString(), state: "done" })) }), false);
  assert.equal(autoGate(explanation, { ...base, fixes: [{ state: "done", createdAt: new Date(NOW - DAY_MS).toISOString() }] }), true);
});

test("auto queues once without a question or push; off never calls models or queues", async (t) => {
  const f = fixture(t, "auto");
  await f.manager.publish([f.candidate()]);
  assert.equal(f.store.fixes().length, 1); assert.equal(f.store.openQuestions().length, 0); assert.equal(f.calls.pushes, 0);
  await f.manager.refresh(); assert.equal(f.store.fixes().length, 1);
  const off = fixture(t, "off");
  assert.deepEqual(await off.manager.propose(report), []);
  assert.equal(off.calls.explain, 0);
  assert.equal(resolveFleetConfig({ OPENAGI_FLEET_SELF_FIX: "0" }).selfFix.mode, "off");
  assert.equal(resolveFleetConfig({ OPENAGI_FLEET_SELF_FIX: "auto" }).selfFix.mode, "auto");
});

test("auto acceptance after a lock clears resolves the existing outreach card once", async (t) => {
  const f = fixture(t, "auto");
  const resolved = [];
  const items = [];
  const runtime = { outreach: {
    append: (item) => { items.push(item); return { id: `out-${items.length}` }; },
    resolve: (...args) => resolved.push(args)
  }, nodeCapabilities: { dispatch: async () => { throw new Error("Coding node offline"); } } };
  const supervisor = new FleetSupervisor({ dataDir: f.dir, config: f.config, runtime, deps: { now: f.now } });
  supervisor._store = f.store;
  supervisor.selfFixHub.nodeId = "coder";
  f.store.state.fixLocks = { policy: "busy" };
  await supervisor.suggestionManager.publish([f.candidate()]);
  const question = f.store.openQuestions()[0];
  assert.equal(question.outreachId, "out-1");
  assert.equal(items.length, 1);
  assert.equal(f.store.fixes().length, 0);
  f.store.state.fixLocks = {};
  await supervisor.suggestionManager.refresh();
  assert.equal(f.store.fixes().length, 1);
  assert.equal(f.store.suggestions()[0].status, "fix-queued");
  assert.equal(f.store.suggestions()[0].fixId, f.store.fixes()[0].id, "the hub queue is awaited, so the suggestion links its fix");
  assert.equal(f.store.fixes()[0].auto, true, "an auto-accepted fix keeps its automatic provenance");
  assert.equal(f.store.fixes()[0].confidence, explanation.confidence);
  assert.equal(f.store.openQuestions().length, 0);
  assert.deepEqual(resolved, [["out-1", "Fix it", { status: "acted" }]]);
  await supervisor.suggestionManager.refresh();
  assert.equal(resolved.length, 1);
});

test("auto mode asks instead when this computer cannot reach a coding node", async (t) => {
  const f = fixture(t, "auto");
  const supervisor = new FleetSupervisor({ dataDir: f.dir, config: f.config, deps: { now: f.now } });
  supervisor._store = f.store;
  await supervisor.suggestionManager.publish([f.candidate()]);
  assert.equal(f.store.fixes().length, 0);
  assert.equal(f.store.suggestions()[0].status, "open");
  assert.equal(f.store.openQuestions()[0].kind, "suggestion");
});

test("an answer given while the push is in flight is kept", async (t) => {
  const f = fixture(t);
  f.manager.notify = async (q) => { await f.manager.respond(q.meta.suggestionId, "Never"); return { pushed: true }; };
  await f.manager.publish([f.candidate()]);
  const [s] = f.store.suggestions();
  assert.equal(s.status, "never");
  assert.ok(s.pushedAt);
});

test("behind an OPENAGI_FLEET_NODE main, Fix it queues in the main's hub", async (t) => {
  const f = fixture(t);
  const supervisor = new FleetSupervisor({ dataDir: f.dir, config: f.config, deps: { now: f.now, diagnoseModels: f.manager.models } });
  supervisor._store = f.store; supervisor._suggestionManager = f.manager;
  await f.manager.publish([f.candidate(0), f.candidate(1)]);
  const capability = createFleetCapability(supervisor);
  const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-suggestions-hub-"));
  t.after(() => fs.rmSync(hubDir, { recursive: true, force: true }));
  const remote = new RemoteFleetSupervisor({ nodeId: "test", dataDir: hubDir, runtime: { nodeCapabilities: { dispatch: async (_node, cap, operation, payload) => {
    if (cap !== "fleet-supervisor") throw new Error("Coding node offline");
    return capability.invoke(operation, payload);
  } } } });
  await remote.refresh();
  const [first, second] = f.store.suggestions();
  const card = remote.getState().questions.find((q) => q.meta?.suggestionId === first.id);
  const answered = await remote.answerQuestion(card.id, "Fix it");
  assert.deepEqual(answered.fix.evidence.suggestionIds, [first.id]);
  assert.equal(f.store.fixes().length, 0, "the computer only links the fix");
  assert.equal(f.store.suggestions().find((s) => s.id === first.id).fixId, answered.fix.id);
  assert.equal(f.store.question(card.id).status, "answered");
  assert.deepEqual(remote.getState().fixes.map((x) => x.id), [answered.fix.id]);
  await assert.rejects(remote.respondSuggestion(second.id, "Fix it"), /already holds/);
  await remote.stopFix(answered.fix.id);
  const { fix } = await remote.respondSuggestion(second.id, "Fix it");
  assert.equal(f.store.suggestions().find((s) => s.id === second.id).fixId, fix.id);
  assert.deepEqual(remote.getState().fixes.map((x) => x.id).sort(), [answered.fix.id, fix.id].sort());
});

test("an owner Fix it stays manual even in auto mode", async (t) => {
  const f = fixture(t, "auto");
  const supervisor = new FleetSupervisor({ dataDir: f.dir, config: f.config, deps: { now: f.now } });
  supervisor._store = f.store;
  await supervisor.suggestionManager.publish([f.candidate(0, { confidence: 0.5 })]);
  assert.equal(f.store.fixes().length, 0, "below the auto gate, the owner decides");
  const { fix } = await supervisor.respondSuggestion(f.store.suggestions()[0].id, "Fix it");
  assert.equal(fix.auto, undefined);
  assert.equal(f.store.suggestions()[0].fixId, fix.id);
});

test("suggestion responses work through question, routes, remote capability and phone allowlist", async (t) => {
  const f = fixture(t);
  const supervisor = new FleetSupervisor({ dataDir: f.dir, config: f.config, deps: { now: f.now, diagnoseModels: f.manager.models } });
  supervisor._store = f.store; supervisor._suggestionManager = f.manager;
  await f.manager.publish([f.candidate()]);
  const q = f.store.openQuestions()[0];
  await supervisor.answerQuestion(q.id, "Not now");
  assert.equal(f.store.suggestions()[0].status, "snoozed");
  assert.equal(f.store.fixes().length, 0);
  const route = createFleetRoute({ supervisor });
  assert.equal((await route("POST", "/fleet/api/diagnose")).status, 405);
  assert.equal((await route("GET", "/fleet/api/diagnose", new URL("http://local/fleet/api/diagnose?window=no"))).status, 400);
  assert.equal((await route("GET", "/fleet/api/suggestions/missing")).status, 404);
  const capability = createFleetCapability(supervisor);
  const remote = new RemoteFleetSupervisor({ nodeId: "test", runtime: { nodeCapabilities: { dispatch: (_node, _cap, operation, payload) => capability.invoke(operation, payload) } } });
  assert.equal((await remote.suggestions()).length, 1);
  const diag = await remote.diagnose({ window: "7d", area: "review" });
  assert.equal(diag.window, "7d"); assert.equal(diag.area, "review");
  await remote.respondSuggestion(f.store.suggestions()[0].id, "never");
  assert.equal(isMobileRouteAllowed("GET", "/fleet/api/diagnose"), true);
  assert.equal(isMobileRouteAllowed("POST", "/fleet/api/suggestions/sg_abc"), true);
  assert.equal(isMobileRouteAllowed("POST", "/fleet/api/suggestions/sg_abc/merge"), false);
});

test("explanations bind exactly to one anomaly without action evidence", async (t) => {
  const f = fixture(t);
  const feedback = f.store.recordFeedback({ intent: "change", utterance: "Too many asks", target: { threadKey: "t" } });
  const anomalies = [
    { id: "unanswered", metric: "questions-unanswered", area: "policy", eventsPerDay: 20, evidenceActionIds: [] },
    { id: "feedback", metric: "feedback:t", area: "policy", eventsPerDay: 2, evidenceActionIds: [], feedbackIds: [feedback.id] },
    { id: "feedback-other", metric: "feedback:t", area: "policy", eventsPerDay: 5, evidenceActionIds: [] }
  ];
  f.manager.models.explain = async () => ({ ...explanation, anomalyId: "feedback", evidenceActionIds: [] });
  const [suggestion] = await f.manager.propose({ anomalies });
  assert.equal(suggestion.metric, "feedback:t");
  assert.equal(suggestion.eventsPerDay, 2);
  assert.equal(suggestion.score, 2 * explanation.minutesSavedPerDay * explanation.confidence);
  assert.deepEqual(suggestion.evidence.feedbackIds, [feedback.id]);
  await f.manager.publish([suggestion]);
  assert.equal(f.store.feedback()[0].status, "triaged");
  for (const patch of [{ anomalyId: "missing" }, { anomalyId: undefined }, { anomalyId: "feedback", area: "review" }]) {
    f.manager.models.explain = async () => ({ ...explanation, ...patch });
    await assert.rejects(f.manager.propose({ anomalies }), /Invalid diagnosis|no matching anomaly/);
  }
});

test("explicit self-fix overrides win over environment modes", async (t) => {
  for (const value of ["off", "0", "auto", "propose"]) {
    for (const mode of ["off", "propose", "auto"]) assert.equal(resolveFleetConfig({ OPENAGI_FLEET_SELF_FIX: value }, { selfFix: { mode } }).selfFix.mode, mode);
  }
  const f = fixture(t);
  f.manager.config = resolveFleetConfig({ OPENAGI_FLEET_SELF_FIX: "off" }, { home: f.dir, selfFix: { mode: "propose" } });
  assert.equal((await f.manager.propose(report)).length, 1);
  assert.equal(resolveFleetConfig({ OPENAGI_FLEET_SELF_FIX: "off" }).selfFix.mode, "off");
});
