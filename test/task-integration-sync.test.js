import test from "node:test";
import assert from "node:assert/strict";
import { LinearTaskSource } from "../src/integrations/linear-tasks.js";
import { BuildBetterTaskSource } from "../src/integrations/buildbetter-tasks.js";
import { syncTaskIntegration } from "../src/task-integration-settings.js";

test("manual BuildBetter sync normalizes each ingest mode and reports partial failures", async () => {
  const run = (result) => syncTaskIntegration({ buildBetterTaskSource: {
    isConfigured: () => true, sync: async () => result
  } }, "buildbetter");
  assert.deepEqual(await run({ signals: { created: 3, updated: 2, completed: 1 } }),
    { ok: true, created: 3, updated: 2, completed: 1 });
  assert.equal((await run({ signals: { skipped: true, reason: "private upstream error" } })).ok, false);
  assert.deepEqual(await run({ transcripts: { created: 2, failed: 0 } }),
    { ok: true, created: 2, updated: 0, completed: 0 });
  assert.equal((await run({ signals: { created: 1 }, transcripts: { created: 1, failed: 1 } })).ok, false);
  assert.equal((await run({ signals: { created: 1 }, transcripts: { skipped: true } })).ok, false);
  assert.doesNotMatch(JSON.stringify(await run({ signals: { skipped: true, reason: "private upstream error" } })), /private upstream/);
});

function taskStore() {
  const rows = [];
  return {
    rows, list: () => rows,
    add(task, options) { const row = { ...task, ...options, id: String(rows.length + 1) }; rows.push(row); return row; },
    update(id, changes) { Object.assign(rows.find((row) => row.id === id), changes); }
  };
}

test("overlapping Linear manual and scheduled syncs import each external issue once", async () => {
  const tasks = taskStore();
  const source = new LinearTaskSource({ apiKey: "synthetic-key", runtime: { tasks } });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let queries = 0;
  source.query = async () => {
    queries += 1;
    await gate;
    return { viewer: { assignedIssues: { nodes: [{ id: "issue-1", title: "Synthetic issue", state: { type: "started" } }] } } };
  };
  const manual = syncTaskIntegration({ linearTaskSource: source }, "linear");
  const scheduled = source.sync();
  release();
  assert.equal((await manual).ok, true);
  assert.equal((await scheduled).created, 1);
  assert.equal(queries, 1);
  assert.equal(tasks.rows.length, 1);
  await source.sync();
  assert.equal(queries, 2, "a completed pass must not suppress future syncs");
});

test("BuildBetter manual, scheduled and webhook imports share the whole pass", async () => {
  const rows = [];
  const source = new BuildBetterTaskSource({ apiKey: "synthetic-key", userEmail: "test@example.com", ingestMode: "transcripts",
    runtime: { observations: { existsRef: async (ref) => rows.some((row) => row.ref === ref),
      record: async (row) => { rows.push(row); return { count: 1 }; } } } });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let queries = 0;
  source.getRecentCalls = async () => { queries += 1; await gate; return [{ id: 7, name: "Synthetic call" }]; };
  source.getTranscript = async () => "Synthetic transcript";
  const manual = syncTaskIntegration({ buildBetterTaskSource: source }, "buildbetter");
  const scheduled = source.sync();
  const webhook = source.triggerSync();
  release();
  assert.equal((await manual).ok, true);
  await Promise.all([scheduled, webhook]);
  assert.equal(queries, 2, "the webhook queues one fresh upstream snapshot after the active manual sync");
  assert.equal(rows.length, 1);
  assert.ok(source.lastSyncedAt);
  await source.sync();
  assert.equal(rows.length, 1);
});

test("a rejected import releases the source for the next retry", async () => {
  const source = new BuildBetterTaskSource({ apiKey: "synthetic-key", ingestMode: "signals" });
  let fail = true;
  source.syncSignals = async () => { if (fail) throw new Error("synthetic failure"); return { created: 1 }; };
  assert.equal((await syncTaskIntegration({ buildBetterTaskSource: source }, "buildbetter")).ok, false);
  fail = false;
  assert.equal((await syncTaskIntegration({ buildBetterTaskSource: source }, "buildbetter")).created, 1);
});
