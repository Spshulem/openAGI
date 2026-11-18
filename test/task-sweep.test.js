// Task-list hygiene sweep: rule-based dedupe, LLM re-home + action-tag +
// stale-judge, and archival of old terminal tasks.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "../src/task-store.js";
import { TaskSweep } from "../src/task-sweep.js";
import { buildMobileSummary, summaryETag } from "../src/mobile-summary.js";

const dataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "openagi-sweep-"));

// Fake model provider: parses the sweep's JSON input and applies `decide(title)`
// to each task, echoing the index back. constructor.name is "Object" so the
// sweep's DeterministicModelProvider guard lets it through.
function llmProvider(decide) {
  return {
    isConfigured: () => true,
    generate: async ({ input }) => {
      const arr = JSON.parse(input);
      return { text: JSON.stringify(arr.map((t) => ({ i: t.i, ...decide(t.title) }))) };
    }
  };
}

test("rule-based dedupe cancels near-identical titles within a queue", async () => {
  const store = new TaskStore({ runtime: {}, dataDir: dataDir() });
  store.add({ title: "Reply on Slack" }, { source: "imessage", queue: "user" });
  store.add({ title: "Reply on Slack." }, { source: "imessage", queue: "user" });
  store.add({ title: "reply on  slack" }, { source: "imessage", queue: "user" });
  store.add({ title: "Unique thing" }, { source: "imessage", queue: "user" });

  const sweep = new TaskSweep({ runtime: { tasks: store, agentHost: { modelProvider: null } } });
  const r = await sweep.sweep();

  assert.equal(r.deduped, 2, "two of the three slack dupes cancelled");
  const pending = store.list({ status: "pending" });
  assert.equal(pending.filter((t) => t.title.toLowerCase().includes("slack")).length, 1, "one slack task survives");
  assert.ok(pending.some((t) => t.title === "Unique thing"), "unrelated task untouched");
});

test("LLM pass re-homes to agent queue, tags external sends draft-only, and judges staleness", async () => {
  const store = new TaskStore({ runtime: {}, dataDir: dataDir() });
  const reply = store.add({ title: "Reply to +1480 about dinner" }, { source: "imessage", queue: "user" });
  const decide = store.add({ title: "Decide whether to take the meeting" }, { source: "imessage", queue: "user" });
  const obsolete = store.add({ title: "Old obsolete thing" }, { source: "imessage", queue: "user" });
  const manual = store.add({ title: "Manual stale item" }, { source: "manual", queue: "user" });

  const provider = llmProvider((title) => {
    if (title.startsWith("Reply")) return { queue: "agent", action: "draft", stale: false };
    if (title.startsWith("Decide")) return { queue: "user", action: null, stale: false };
    return { queue: "user", stale: true }; // both "obsolete" + "manual stale"
  });
  const sweep = new TaskSweep({ runtime: { tasks: store, agentHost: { modelProvider: provider } } });
  const r = await sweep.sweep();

  const replyNow = store.get(reply.id);
  assert.equal(replyNow.queue, "agent", "agent-actionable reply re-homed to agent queue");
  assert.ok(replyNow.tags.includes("plan-action"), "external send marked draft-only");
  assert.equal(r.requeued, 1);

  assert.equal(store.get(decide.id).queue, "user", "decision stays with the user");

  assert.equal(store.get(obsolete.id).status, "cancelled", "stale auto-sourced task cancelled");
  assert.ok(r.cancelledStale >= 1);

  const manualNow = store.get(manual.id);
  assert.equal(manualNow.status, "pending", "stale MANUAL task is not auto-cancelled");
  assert.ok(manualNow.tags.includes("review"), "manual stale task flagged for review instead");
  assert.ok(r.flagged >= 1);
});

test("archives terminal tasks older than the window", async () => {
  const store = new TaskStore({ runtime: {}, dataDir: dataDir() });
  const done = store.add({ title: "Finished thing" }, { source: "imessage", queue: "agent" });
  store.complete(done.id);
  const keep = store.add({ title: "Still pending" }, { source: "imessage", queue: "user" });

  // archiveDays -1 → cutoff is in the future, so every terminal task qualifies.
  const sweep = new TaskSweep({ runtime: { tasks: store, agentHost: { modelProvider: null } }, archiveDays: -1 });
  const r = await sweep.sweep();

  assert.equal(r.archived, 1, "the completed task is archived");
  assert.equal(store.get(done.id), null, "archived task removed from active store");
  assert.ok(store.get(keep.id), "pending task retained");
});

test("review receives time and bounded context for an expired one-time task", async (t) => {
  const dir = dataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new TaskStore({ runtime: {}, dataDir: dir });
  const expired = store.add({ title: "Review the group order", description: "Order closes at 2026-01-01T12:00:00Z.", dueDate: "2026-01-01T12:00:00Z" }, { source: "inbox", queue: "user" });
  const keep = store.add({ title: "Finish a long-term project", description: "x".repeat(1500), dueDate: "2026-01-01" }, { source: "observer", queue: "user" });
  const now = new Date("2026-02-01T12:00:00Z");
  const provider = {
    isConfigured: () => true,
    generate: async ({ input, instructions }) => {
      assert.ok(instructions.includes(now.toISOString()));
      assert.match(instructions, /Age or an overdue date ALONE is not evidence/);
      const tasks = JSON.parse(input);
      const order = tasks.find((v) => v.title === expired.title);
      assert.equal(order.description, expired.description);
      assert.equal(order.dueDate, expired.dueDate);
      assert.equal(order.createdAt, expired.createdAt);
      assert.equal(order.updatedAt, expired.updatedAt);
      assert.equal(tasks.find((v) => v.title === keep.title).description.length, 1000);
      return { text: JSON.stringify(tasks.map((v) => ({ i: v.i, queue: "user", action: null, stale: v.title === expired.title }))) };
    }
  };
  const runtime = { tasks: store, agentHost: { modelProvider: provider } };
  const sweep = runtime.taskSweep = new TaskSweep({ runtime });
  const before = summaryETag(buildMobileSummary(runtime, { now }));
  const result = await sweep.sweep({ now });
  assert.equal(result.review.status, "reviewed");
  assert.equal(store.get(expired.id).status, "cancelled");
  assert.equal(store.get(keep.id).status, "pending", "overdue work is retained without evidence it is obsolete");
  assert.equal(buildMobileSummary(runtime, { now }).taskReview.lastReviewedAt, now.toISOString());
  assert.notEqual(summaryETag(buildMobileSummary(runtime, { now })), before);
  assert.deepEqual(new TaskSweep({ runtime }).reviewStatus, sweep.reviewStatus, "review status survives daemon restart");
});

test("failed or unavailable model review never advances the last successful review", async (t) => {
  const dir = dataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new TaskStore({ runtime: {}, dataDir: dir });
  const task = store.add({ title: "Keep this unfinished work" }, { source: "inbox", queue: "user" });
  const runtime = { tasks: store, agentHost: { modelProvider: llmProvider(() => ({ queue: "user", action: null, stale: false })) } };
  const sweep = new TaskSweep({ runtime });
  await sweep.sweep({ now: new Date("2026-02-01T00:00:00Z") });
  const successful = sweep.reviewStatus.lastReviewedAt;
  for (const text of ["not json", "[]", '[{"i":0,"queue":"user","stale":"true"}]']) {
    runtime.agentHost.modelProvider = { isConfigured: () => true, generate: async () => ({ text }) };
    await sweep.sweep({ now: new Date("2026-02-02T00:00:00Z") });
    assert.equal(sweep.reviewStatus.status, "failed");
    assert.equal(sweep.reviewStatus.lastReviewedAt, successful);
    assert.equal(store.get(task.id).status, "pending");
  }
  runtime.agentHost.modelProvider = null;
  await sweep.sweep();
  assert.equal(sweep.reviewStatus.status, "unavailable");
  assert.equal(sweep.reviewStatus.lastReviewedAt, successful);
  fs.writeFileSync(sweep.reviewFile, "corrupt optional metadata");
  assert.equal(new TaskSweep({ runtime }).reviewStatus, null, "metadata damage cannot block startup");
});

test("an empty sweep reports no tasks, and summary refresh does not run a review", async (t) => {
  const dir = dataDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = { tasks: new TaskStore({ runtime: {}, dataDir: dir }) };
  runtime.taskSweep = new TaskSweep({ runtime });
  assert.equal(buildMobileSummary(runtime).taskReview, null);
  const { review } = await runtime.taskSweep.sweep();
  assert.equal(review.status, "no_tasks");
  assert.ok(review.lastReviewedAt);
  buildMobileSummary(runtime);
  assert.deepEqual(runtime.taskSweep.reviewStatus, review);
});
