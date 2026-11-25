import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FleetStore } from "../src/fleet/store.js";
import { feedbackPatch, fixRevision, normalizeFeedback, normalizeFixRequest, normalizeTarget } from "../src/fleet/feedback.js";
import { createFleetRoute } from "../src/fleet/routes.js";
import { createFleetCapability, RemoteFleetSupervisor } from "../src/fleet/remote.js";

const T0 = Date.parse("2026-10-13T20:00:00.000Z");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-feedback-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "fleet");
}

// The store-backed half of FleetSupervisor these routes call.
function supervisorOver(store) {
  return {
    getState: () => ({ mode: "observe", questions: [], actions: [], snapshot: { threads: [] } }),
    recordFeedback: (input) => store.recordFeedback(input),
    feedback: (options) => store.feedback(options),
    queueFix: (input) => store.queueFix(input),
    fixes: (options) => store.fixes(options),
    reviseFix: (id, words) => store.reviseFix(id, words),
    stopFix: (id) => store.stopFix(id)
  };
}

const FIX = { title: "Stop re-asking merged PRs", problem: "Merged PRs still raise questions.", area: "policy", acceptance: "No question for a merged PR." };

test("feedback records: the owner's words, a known intent, a clipped target, secrets redacted", () => {
  const record = normalizeFeedback({ utterance: "  I don't like that ", intent: "change", source: "g2-voice", target: { threadKey: "codex:t1", view: "supervisor", evil: "x", questionId: 7 } }, { now: T0 });
  assert.match(record.id, /^fb_[a-f0-9]{16}$/);
  assert.equal(record.at, "2026-10-13T20:00:00.000Z");
  assert.equal(record.utterance, "I don't like that");
  assert.equal(record.source, "g2-voice");
  assert.deepEqual(record.target, { view: "supervisor", threadKey: "codex:t1" });
  assert.equal(record.status, "new");
  assert.equal(normalizeFeedback({ utterance: "x", intent: "fix", source: "nope" }).source, "text");
  assert.throws(() => normalizeFeedback({ utterance: "", intent: "change" }), /words/);
  assert.throws(() => normalizeFeedback({ utterance: "x", intent: "merge" }), /Intent/);
  assert.doesNotMatch(normalizeFeedback({ utterance: "key " + "sk-" + "a".repeat(40), intent: "change" }).utterance, /sk-a{40}/);
  assert.equal(normalizeTarget(null), null);
  assert.equal(normalizeTarget({ evil: "x" }), null);
});

test("feedback status moves forward only; declined ends any open record", () => {
  const record = { status: "triaged" };
  assert.deepEqual(feedbackPatch(record, { status: "fix-queued", fixId: "fix_1" }), { status: "fix-queued", fixId: "fix_1" });
  assert.throws(() => feedbackPatch(record, { status: "new" }), /back/);
  assert.deepEqual(feedbackPatch(record, { status: "declined" }), { status: "declined" });
  assert.throws(() => feedbackPatch({ status: "merged" }, { status: "declined" }), /already merged/);
  assert.throws(() => feedbackPatch(record, { status: "shipped" }), /Status/);
});

test("fix requests need a title, problem, area and acceptance; revisions stop once abandoned", () => {
  const fix = normalizeFixRequest({ ...FIX, evidence: { feedbackId: "fb_1", actionIds: ["fa_1", "bad id!"] } }, { now: T0 });
  assert.equal(fix.state, "queued");
  assert.deepEqual(fix.evidence, { feedbackIds: ["fb_1"], suggestionIds: [], actionIds: ["fa_1"] });
  for (const field of ["title", "problem", "acceptance"]) assert.throws(() => normalizeFixRequest({ ...FIX, [field]: "" }));
  assert.throws(() => normalizeFixRequest({ ...FIX, area: "release" }), /Area/);
  assert.equal(fixRevision(fix, "Also cover closed PRs.", { now: T0 }).revisions.length, 1);
  assert.throws(() => fixRevision({ ...fix, state: "abandoned" }, "x"), /stopped/);
  assert.throws(() => fixRevision(fix, "  "), /change/);
});

test("FleetStore keeps feedback, fixes and self sessions across a reload", (t) => {
  const dir = tempDir(t);
  const store = new FleetStore({ dir, now: () => T0 });
  const feedback = store.recordFeedback({ utterance: "Fix that", intent: "fix", source: "mac-voice", target: { questionId: "fq_1" } });
  store.recordFeedback({ utterance: "Explain this", intent: "explain" });
  assert.deepEqual(store.feedback().map((record) => record.utterance), ["Explain this", "Fix that"]);
  assert.equal(store.feedback({ status: "new" }).length, 2);
  const fix = store.queueFix({ ...FIX, evidence: { feedbackIds: [feedback.id] } });
  assert.equal(store.feedback().find((record) => record.id === feedback.id).status, "fix-queued");
  assert.equal(store.feedback().find((record) => record.id === feedback.id).fixId, fix.id);
  assert.equal(store.reviseFix(fix.id, "Cover closed PRs too.").revisions.length, 1);
  assert.equal(store.reviseFix("fix_missing", "x"), null);
  assert.equal(store.addSelfSession("codex-session-1", fix.id), true);
  assert.equal(store.addSelfSession("codex-session-1", fix.id), false);
  assert.equal(store.updateFeedback(feedback.id, { status: "pr-open" }).status, "pr-open");

  const reloaded = new FleetStore({ dir, now: () => T0 });
  assert.equal(reloaded.feedback().length, 2);
  assert.equal(reloaded.fix(fix.id).revisions[0].instructions, "Cover closed PRs too.");
  assert.deepEqual(reloaded.selfSessions(), ["codex-session-1"]);
  const second = reloaded.queueFix({ ...FIX, title: "Second", area: "voice" });
  assert.deepEqual(reloaded.stopFix("all").map((item) => item.id).sort(), [fix.id, second.id].sort());
  assert.ok(reloaded.fixes().every((item) => item.state === "abandoned"));
  assert.deepEqual(reloaded.stopFix("all"), []);
});

test("/fleet/api/feedback and /fleet/api/fixes, locally and from the hub through the node capability", async (t) => {
  const store = new FleetStore({ dir: tempDir(t), now: () => T0 });
  const route = createFleetRoute({ supervisor: supervisorOver(store) });
  const posted = await route("POST", "/fleet/api/feedback", null, async () => ({ utterance: "I don't like that", intent: "change", source: "web" }));
  assert.equal(posted.status, 200);
  assert.equal(posted.body.feedback.source, "web");
  assert.equal((await route("POST", "/fleet/api/feedback", null, async () => ({ utterance: "x", intent: "nope" }))).status, 400);
  assert.equal((await route("GET", "/fleet/api/feedback")).body.feedback.length, 1);
  const queued = await route("POST", "/fleet/api/fixes", null, async () => FIX);
  assert.equal(queued.body.fix.state, "queued");
  const revised = await route("POST", `/fleet/api/fixes/${queued.body.fix.id}/revise`, null, async () => ({ instructions: "Smaller diff." }));
  assert.equal(revised.body.fix.revisions.length, 1);
  assert.equal((await route("POST", "/fleet/api/fixes/fix_missing/revise", null, async () => ({ instructions: "x" }))).status, 404);

  // The hub reaches the same store over the fleet-supervisor capability.
  const capability = createFleetCapability(supervisorOver(store));
  const runtime = { nodeCapabilities: { dispatch: async (_node, _cap, operation, payload) => capability.invoke(operation, payload) } };
  const remote = new RemoteFleetSupervisor({ runtime, nodeId: "mac" });
  const fromHub = await remote.recordFeedback({ utterance: "Fix that", intent: "fix", source: "g2-voice" });
  assert.equal(fromHub.source, "g2-voice");
  assert.equal((await remote.feedback()).length, 2);
  const hubFix = await remote.queueFix({ ...FIX, area: "voice" });
  assert.equal((await remote.fixes()).length, 2);
  assert.equal((await remote.reviseFix(hubFix.id, "Add a test.")).revisions.length, 1);
  const stopped = await remote.stopFix("all");
  assert.equal(stopped.length, 2);
  await assert.rejects(capability.invoke("request", { method: "POST", path: "/fleet/api/fixes/x/merge" }), /Unsupported/);
});
