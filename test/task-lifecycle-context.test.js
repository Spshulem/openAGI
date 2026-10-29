import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../src/task-store.js";
import { TaskSweep } from "../src/task-sweep.js";
import { ProactiveObserver } from "../src/proactive-observer.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { ComputerUseLog } from "../src/computer-use-log.js";
import { registerComputerUseTools } from "../src/integrations/computer-use.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-lifecycle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtime = {};
  runtime.tasks = new TaskStore({ runtime, dataDir: dir });
  return { runtime, dir };
}

test("task sweep receives the clock and dated context rather than an undated title", async t => {
  const { runtime } = fixture(t);
  const item = runtime.tasks.add({ title: "Confirm Thursday workshop", description: "One-off appointment", dueDate: "2026-08-06T12:00:00Z", scheduledFor: "2026-08-06", tags: ["plan-action"] }, { source: "imessage", queue: "agent" });
  let seen;
  runtime.agentHost = { modelProvider: { isConfigured: () => true, generate: async request => { seen = request; return { text: "[]" }; } } };
  const now = new Date("2026-10-29T16:00:00Z");
  await new TaskSweep({ runtime }).sweep({ now });
  assert.match(seen.instructions, /2026-10-29T16:00:00.000Z/);
  const [context] = JSON.parse(seen.input);
  assert.equal(context.createdAt, item.createdAt);
  assert.equal(context.dueDate, item.dueDate);
  assert.equal(context.scheduledFor, item.scheduledFor);
  assert.equal(context.description, item.description);
  assert.equal(context.status, "pending");
  assert.deepEqual(context.tags, ["plan-action"]);
  assert.equal(runtime.tasks.get(item.id).status, "pending", "age alone must not cancel work");
});

function observerFixture(t) {
  const f = fixture(t);
  f.observer = new ProactiveObserver({ runtime: f.runtime, dataDir: f.dir });
  f.observer.gatherReconciliationEvidence = async () => ({ ocr: { apps: [], snippets: [{ text: "fixture receipt" }, { text: "fixture confirmation" }] } });
  f.requests = [];
  f.runtime.agentHost = { modelProvider: { isConfigured: () => true, generate: async request => {
    f.requests.push(request);
    return { text: JSON.stringify({ updates: f.updates ?? [] }) };
  } } };
  return f;
}

test("completion scan reaches in-progress user tasks behind a large agent queue", async t => {
  const f = observerFixture(t);
  for (let i = 0; i < 35; i++) f.runtime.tasks.add({ title: `Agent work ${i}`, priority: 100 }, { queue: "agent" });
  const target = f.runtime.tasks.add({ title: "Finish report", status: "in_progress", priority: 1 }, { queue: "user" });
  f.updates = [{ taskId: target.id, action: "complete", confidence: 1, evidence: "fixture report receipt", sources: ["ocr", "calendar"] }];
  await f.observer.scanTasksAgainstActivity();
  assert.equal(f.runtime.tasks.get(target.id).status, "completed");
  assert.match(f.requests[0].input, /Finish report/);
});

test("bounded completion scans rotate through the user backlog", async t => {
  const f = observerFixture(t);
  const ids = [];
  for (let i = 0; i < 65; i++) ids.push(f.runtime.tasks.add({ title: `User work ${i}` }, { queue: "user" }).id);
  for (let i = 0; i < 3; i++) await f.observer.scanTasksAgainstActivity();
  assert.equal(f.requests.length, 3);
  for (const id of ids) assert.ok(f.requests.some(r => r.input.includes(id)), "every eligible task gets a turn");
  for (const r of f.requests) assert.ok((r.input.match(/  - id=/g) ?? []).length <= 30);
});

test("completion verdict cannot mutate a task outside the supplied candidate batch", async t => {
  const f = observerFixture(t);
  f.runtime.tasks.add({ title: "User work" }, { queue: "user" });
  const other = f.runtime.tasks.add({ title: "Blocked work", status: "blocked" }, { queue: "user" });
  f.updates = [{ taskId: other.id, action: "complete", confidence: 1, evidence: "fixture", sources: ["ocr", "calendar"] }];
  await f.observer.scanTasksAgainstActivity();
  assert.equal(f.runtime.tasks.get(other.id).status, "blocked");
});

for (const readyAfterRefresh of [true, false]) {
  test(`computer approval uses fresh same-node readiness (${readyAfterRefresh})`, async t => {
    const { runtime, dir } = fixture(t);
    const tools = runtime.tools = new ToolRegistry();
    runtime.computerUseLog = new ComputerUseLog({ dir: path.join(dir, "computer-use") });
    let cachedReady = !readyAfterRefresh;
    let refreshed = false;
    runtime.nodeCapabilities = {
      refresh: async () => { refreshed = true; cachedReady = readyAfterRefresh; },
      resolve: (_capability, selector = {}) => cachedReady && selector.nodeId === "node-approved" ? { nodeId: "node-approved", local: true } : null
    };
    registerComputerUseTools(tools, runtime);
    const result = await tools.invoke("start_computer_use_session", { goal: "Prepare a fixture report", nodeId: "node-approved" }, { sessionId: "fixture-chat", __confirmed: true });
    assert.equal(refreshed, true);
    assert.equal(result.ok, readyAfterRefresh);
    assert.equal(runtime.computerUseLog.listSessions({ status: "active" }).length, readyAfterRefresh ? 1 : 0);
  });
}

for (const output of ["not json", "[]"]) {
  test(`sweep reports incomplete relevance review for ${output}`, async t => {
    const { runtime } = fixture(t);
    runtime.tasks.add({ title: "Keep this work", tags: ["plan-action"] }, { queue: "agent" });
    runtime.agentHost = { modelProvider: { isConfigured: () => true, generate: async () => ({ text: output }) } };
    const result = await new TaskSweep({ runtime }).sweep();
    assert.equal(result.llmStatus, output === "[]" ? "partial" : "failed");
    assert.equal(result.llmReviewed, 0);
    assert.equal(runtime.tasks.list()[0].status, "pending");
    assert.deepEqual(runtime.tasks.list()[0].tags, ["plan-action"]);
  });
}
