// Regression tests for review findings on the grounded-grade change.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DraftStore } from "../src/draft-store.js";
import { FileBackedPropagationController } from "../src/file-backed-propagation-controller.js";
import { GroundedOutcomes } from "../src/learning/grounded-outcomes.js";
import { OutcomeStore } from "../src/outcome-store.js";
import { PendingActionStore } from "../src/pending-actions.js";
import { TaskStore } from "../src/task-store.js";

const DAY = 86_400_000;
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function setup() {
  const dir = tmp("openagi-review-fixes-");
  const runtime = {};
  runtime.outcomes = new OutcomeStore({ dir: path.join(dir, "outcomes") });
  runtime.drafts = new DraftStore({ dir: path.join(dir, "drafts"), runtime });
  runtime.tasks = new TaskStore({ runtime, dataDir: dir });
  runtime.outreach = { list: () => [] };
  runtime.grounded = new GroundedOutcomes({ runtime });
  return runtime;
}

test("grounded specialist quality survives a reload of the durable controller", () => {
  const storePath = path.join(tmp("openagi-spec-persist-"), "specialists.json");
  const a = new FileBackedPropagationController({ storePath });
  const sp = a.propagate({ signal: { domain: "d", taskType: "t", summary: "scope" }, workflow: null, scrutiny: { reasons: [] }, tools: [] }).specialist;
  a.recordGroundedQuality(sp.id, 0.25);
  const b = new FileBackedPropagationController({ storePath });
  const again = b.list().find((s) => s.id === sp.id);
  assert.equal(again.groundedSamples, 1);
  assert.equal(again.groundedMean, 0.25);
});

test("the turn signal survives a queued approval, as plain data", () => {
  const store = new PendingActionStore({ dir: tmp("openagi-pending-signal-") });
  const signal = { id: "sig_1", scrutinyAction: "ask", scrutinyScore: 0.5, scrutinyDimensions: { evidence: 0.4, bogus: "x" }, specialistId: null };
  const action = store.enqueue({ toolName: "save_draft", args: { body: "x" }, context: { sessionId: "s", agentId: "main", __signal: signal }, summary: "s", reason: "r" });
  const saved = store.get(action.id);
  assert.deepEqual(saved.context.__signal, { id: "sig_1", scrutinyAction: "ask", scrutinyScore: 0.5, scrutinyDimensions: { evidence: 0.4 }, specialistId: null });
  assert.equal(saved.context.authority, null);
});

test("an explicit rating is a grounded grade", () => {
  const rt = setup();
  const reply = rt.outcomes.record({ kind: "agent-reply", scrutinyDimensions: { evidence: 0.5 } });
  rt.outcomes.resolve(reply.id, 0.7, "system-inferred");
  rt.outcomes.rate(reply.id, 0.1, "not helpful");
  const o = rt.outcomes.outcomes.get(reply.id);
  assert.equal(o.groundedScore, 0.1);
  assert.equal(o.groundedFate, "rated");
  assert.equal(o.groundedSource, "explicit-rating");
});

test("a suggestion graded after its task was already done counts as done", () => {
  const rt = setup();
  const task = rt.tasks.add({ title: "From a suggestion", sourceMeta: { suggestionId: "prop_done" } }, { source: "suggestion", queue: "user" });
  rt.tasks.complete(task.id, "manual");                       // before any work outcome existed
  rt.grounded.onSuggestionResolved({ id: "prop_done", proposedAt: new Date().toISOString() }, "accepted");
  const o = rt.outcomes.byWorkRef("work-suggestion", "prop_done");
  assert.equal(o.groundedFate, "accepted-done");
  assert.equal(o.groundedScore, 1);
});

test("only suggestions that became a task can stall; finished ones become done", () => {
  const rt = setup();
  const proposedAt = new Date().toISOString();
  for (const id of ["prop_skill", "prop_open", "prop_closed"]) rt.grounded.onSuggestionResolved({ id, proposedAt }, "accepted");
  rt.tasks.add({ title: "Open one", sourceMeta: { suggestionId: "prop_open" } }, { source: "suggestion", queue: "user" });
  const closed = rt.tasks.add({ title: "Closed one", sourceMeta: { suggestionId: "prop_closed" } }, { source: "suggestion", queue: "user" });
  closed.status = "completed";                                // completed outside complete(): no hook ran
  const result = rt.grounded.sweep({ now: new Date(Date.now() + 31 * DAY) });
  assert.equal(rt.outcomes.byWorkRef("work-suggestion", "prop_skill").groundedFate, "accepted");
  assert.equal(rt.outcomes.byWorkRef("work-suggestion", "prop_open").groundedFate, "accepted-stalled");
  assert.equal(rt.outcomes.byWorkRef("work-suggestion", "prop_closed").groundedFate, "accepted-done");
  assert.deepEqual(result.byFate, { "accepted-stalled": 1, "accepted-done": 1 });
});

test("completing an already completed task gives the agent no credit", () => {
  const rt = setup();
  const task = rt.tasks.add({ title: "Owner did it" }, { source: "chat", queue: "user" });
  rt.tasks.complete(task.id, "manual");
  rt.tasks.complete(task.id, "agent", { byAgent: true });
  assert.equal(rt.outcomes.byWorkRef("work-task", task.id), null);
});

test("an auto-created suggestion task grades the suggestion when it gets done", () => {
  const rt = setup();
  const sug = { id: "prop_auto", proposedAt: new Date().toISOString() };
  rt.grounded.onSuggestionProposed(sug);
  rt.grounded.onSuggestionResolved(sug, "auto-accepted");
  const before = rt.outcomes.byWorkRef("work-suggestion", "prop_auto");
  assert.equal(before.groundedFate, "auto-accepted");
  assert.equal(before.groundedScore, null);
  const task = rt.tasks.add({ title: "Auto task", sourceMeta: { suggestionId: "prop_auto" } }, { source: "suggestion", queue: "user" });
  rt.tasks.complete(task.id, "manual");
  assert.equal(rt.outcomes.byWorkRef("work-suggestion", "prop_auto").groundedFate, "accepted-done");
});
