// Task-list hygiene sweep: rule-based dedupe, LLM re-home + action-tag +
// stale-judge, and archival of old terminal tasks.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "../src/task-store.js";
import { TaskSweep } from "../src/task-sweep.js";

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
