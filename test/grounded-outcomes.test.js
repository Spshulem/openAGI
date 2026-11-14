import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DraftStore } from "../src/draft-store.js";
import { GroundedOutcomes, editedDraftScore } from "../src/learning/grounded-outcomes.js";
import { OutcomeStore } from "../src/outcome-store.js";
import { TaskStore } from "../src/task-store.js";

const DAY = 86_400_000;

function setup({ outreach = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-fates-"));
  const runtime = {};
  runtime.outcomes = new OutcomeStore({ dir: path.join(dir, "outcomes") });
  runtime.drafts = new DraftStore({ dir: path.join(dir, "drafts"), runtime });
  runtime.tasks = new TaskStore({ runtime, dataDir: dir });
  runtime.outreach = { list: () => outreach };
  runtime.grounded = new GroundedOutcomes({ runtime });
  return runtime;
}

const work = (rt, kind, refId) => rt.outcomes.byWorkRef(kind, refId);

function saveDraft(rt, body = "one two three four five six seven eight nine ten", signal = null) {
  const draft = rt.drafts.add({ title: "Reply", body, kind: "email" });
  rt.grounded.onDraftCreated(draft, signal);
  return draft;
}

test("draft approved without edits scores 1", () => {
  const rt = setup();
  const d = saveDraft(rt, undefined, { id: "sig", scrutinyAction: "act", scrutinyScore: 0.7, scrutinyDimensions: { evidence: 0.4 } });
  rt.drafts.approve(d.id);
  const o = work(rt, "work-draft", d.id);
  assert.equal(o.groundedFate, "approved");
  assert.equal(o.groundedScore, 1);
  assert.equal(o.signalId, "sig");
});

test("edited draft scores by how much of it survived, and the original is kept", () => {
  const rt = setup();
  const d = saveDraft(rt, "a b c d e f g h i j");
  rt.drafts.edit(d.id, { body: "a b c d e v w x y z" });
  rt.drafts.edit(d.id, { body: "a b c d e v w x y z" });
  assert.equal(rt.drafts.get(d.id).originalBody, "a b c d e f g h i j");
  rt.drafts.approve(d.id);
  const o = work(rt, "work-draft", d.id);
  assert.equal(o.groundedFate, "approved-edited");
  assert.ok(Math.abs(o.groundedScore - editedDraftScore(0.5)) < 0.01);
});

test("discarded draft scores 0; sent without approval scores 1", () => {
  const rt = setup();
  const a = saveDraft(rt);
  rt.drafts.discard(a.id);
  assert.equal(work(rt, "work-draft", a.id).groundedScore, 0);
  const b = saveDraft(rt, "different body for the second draft here");
  rt.drafts.markSent(b.id, { channel: "email" });
  assert.equal(work(rt, "work-draft", b.id).groundedFate, "sent");
  assert.equal(work(rt, "work-draft", b.id).groundedScore, 1);
});

test("legacy edited draft without an original gets a work outcome and 0.7", () => {
  const rt = setup();
  const d = rt.drafts.add({ title: "Old", body: "legacy body text", kind: "email" });
  d.editedAt = new Date().toISOString();           // edited before this change: no originalBody
  rt.drafts.approve(d.id);
  const o = work(rt, "work-draft", d.id);
  assert.equal(o.at, d.createdAt);
  assert.equal(o.groundedScore, 0.7);
  assert.deepEqual(o.metadata.groundedDetail, { similarityUnknown: true });
});

test("suggestion statuses map to fates", () => {
  const rt = setup();
  const s = (id) => ({ id, proposedAt: new Date().toISOString() });
  for (const [id, status, score] of [["r", "rejected", 0], ["d", "dismissed", 0.1], ["a", "accepted", 0.7]]) {
    rt.grounded.onSuggestionProposed(s(id));
    rt.grounded.onSuggestionResolved(s(id), status);
    assert.equal(work(rt, "work-suggestion", id).groundedScore, score, status);
  }
});

test("an accepted suggestion whose task gets done becomes accepted-done", () => {
  const rt = setup();
  const sug = { id: "sx", proposedAt: new Date().toISOString() };
  rt.grounded.onSuggestionProposed(sug);
  rt.grounded.onSuggestionResolved(sug, "accepted");
  const task = rt.tasks.add({ title: "Do the thing", sourceMeta: { suggestionId: "sx" } }, { source: "suggestion", queue: "user" });
  rt.tasks.complete(task.id, "manual");
  const o = work(rt, "work-suggestion", "sx");
  assert.equal(o.groundedFate, "accepted-done");
  assert.equal(o.groundedScore, 1);
});

test("auto-dismissed suggestions are weak silence when delivered, ungraded when not", () => {
  const rt = setup({ outreach: [{ sourceRef: { kind: "suggestion", id: "seen" }, status: "seen" }] });
  rt.grounded.onSuggestionResolved({ id: "seen", proposedAt: new Date().toISOString() }, "auto-dismissed");
  rt.grounded.onSuggestionResolved({ id: "never", proposedAt: new Date().toISOString() }, "auto-dismissed");
  const a = work(rt, "work-suggestion", "seen");
  assert.equal(a.groundedFate, "silence-delivered");
  assert.equal(a.groundedScore, 0.2);
  assert.equal(a.groundedWeak, true);
  const b = work(rt, "work-suggestion", "never");
  assert.equal(b.groundedFate, "silence-undelivered");
  assert.equal(b.groundedScore, null);
});

test("agent-completed task: held after 7 days, or reopened (and the sweep leaves reopened alone)", () => {
  const rt = setup();
  const kept = rt.tasks.add({ title: "Kept" }, { source: "agent", queue: "agent" });
  const undone = rt.tasks.add({ title: "Undone" }, { source: "agent", queue: "agent" });
  rt.tasks.complete(kept.id, "agent", { byAgent: true });
  rt.tasks.complete(undone.id, "agent", { byAgent: true });
  rt.tasks.update(undone.id, { status: "pending" });
  assert.equal(work(rt, "work-task", undone.id).groundedFate, "reopened");
  assert.equal(work(rt, "work-task", undone.id).groundedScore, 0.1);
  assert.ok(rt.tasks.get(undone.id).reopenedAt);
  assert.deepEqual(rt.tasks.get(undone.id).statusHistory.map((h) => h.status), ["completed", "pending"]);
  const result = rt.grounded.sweep({ now: new Date(Date.now() + 8 * DAY) });
  assert.equal(result.byFate.held, 1);
  const held = work(rt, "work-task", kept.id);
  assert.equal(held.groundedFate, "held");
  assert.equal(held.groundedWeak, true);
  assert.equal(work(rt, "work-task", undone.id).groundedFate, "reopened");
});

test("sweep grades ignored drafts and stalled suggestions once", () => {
  const rt = setup({ outreach: [] });
  const d = saveDraft(rt);
  const sug = { id: "stall", proposedAt: new Date().toISOString() };
  rt.grounded.onSuggestionResolved(sug, "accepted");
  const later = new Date(Date.now() + 31 * DAY);
  const first = rt.grounded.sweep({ now: later });
  assert.equal(first.byFate["ignored-undelivered"], 1);
  assert.equal(first.byFate["accepted-stalled"], 1);
  assert.equal(work(rt, "work-draft", d.id).groundedScore, null);
  assert.equal(work(rt, "work-suggestion", "stall").groundedScore, 0.5);
  const second = rt.grounded.sweep({ now: later });
  assert.equal(second.grounded, 0);
});

test("a direct rating grades the outcome it targets", () => {
  const rt = setup();
  const d = saveDraft(rt);
  rt.grounded.onRated(work(rt, "work-draft", d.id), "down");
  assert.equal(work(rt, "work-draft", d.id).groundedFate, "rated-down");
  assert.equal(work(rt, "work-draft", d.id).groundedScore, 0.15);
});

test("with no outcome store every method returns null and nothing throws", () => {
  const g = new GroundedOutcomes({ runtime: {} });
  assert.equal(g.onDraftCreated({ id: "x" }), null);
  assert.equal(g.onDraftResolved({ id: "x" }, "approved"), null);
  assert.equal(g.onSuggestionProposed({ id: "x" }), null);
  assert.equal(g.onSuggestionResolved({ id: "x" }, "accepted"), null);
  assert.equal(g.onAgentTaskCompleted({ id: "x" }), null);
  assert.equal(g.onTaskReopened({ id: "x" }), null);
  assert.equal(g.onRated(null, "up"), null);
  assert.deepEqual(g.sweep(), { grounded: 0, byFate: {} });
});

test("end to end through a runtime: save_draft in a turn, then approval, grades the draft against that turn", async () => {
  const { createDurableRuntime, DeterministicModelProvider } = await import("../src/index.js");
  class DraftProvider extends DeterministicModelProvider {
    async generate({ toolRegistry, context }) {
      // This test is about grading, not the approval gate an 'ask' verdict adds.
      await toolRegistry.invoke("save_draft", { title: "Follow-up", body: "Thanks for the call today.", kind: "email" },
        { ...context, __scrutinyPolicy: null });
      return { provider: "t", model: "t", text: "Drafted.", toolCalls: [{ name: "save_draft", ok: true }] };
    }
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-fates-e2e-"));
  const runtime = createDurableRuntime({ dataDir, modelProvider: new DraftProvider(), autoConnectMcp: false });
  await runtime.agentHost.handleMessage({ channel: "local", from: "user", text: "draft a follow-up to the vendor" });
  const draft = runtime.drafts.list({ status: "pending" })[0];
  assert.ok(draft, "a draft was saved");
  const turn = runtime.outcomes.recent(20).find((o) => o.kind === "agent-reply");
  runtime.drafts.approve(draft.id);
  const graded = runtime.outcomes.byWorkRef("work-draft", draft.id);
  assert.equal(graded.groundedFate, "approved");
  assert.equal(graded.signalId, turn.signalId);
});
