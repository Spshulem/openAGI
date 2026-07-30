// test/brief-route.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

// dataDir is passed explicitly to BOTH the runtime and the interface:
// resolveDataDir() memoizes its first result, so relying on the env var would
// make a second instance in the same process silently reuse the first's dir.
async function bootApp(dataDir) {
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, authToken: null });
  const listened = await app.listen();
  return { runtime, app, base: listened.url ?? `http://127.0.0.1:${listened.port}` };
}

test("GET /brief/today returns a well-formed brief on an empty install", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-briefroute-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const res = await fetch(`${base}/brief/today`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(Array.isArray(json.items));
    assert.ok(json.older && typeof json.older.count === "number");
    assert.ok(json.generatedAt);
    assert.equal(json.planCachedAt, null);
    assert.ok(Array.isArray(json.degraded));
  } finally { await app.close(); }
});

test("GET /brief/today surfaces a real task with actionable buttons", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-briefroute2-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    runtime.tasks.add({ queue: "user", title: "Overdue thing", bucket: "today", dueDate: "2026-01-01T00:00:00.000Z" });
    const res = await fetch(`${base}/brief/today`);
    const json = await res.json();
    const item = json.items.find((i) => i.kind === "task");
    assert.ok(item, "the task should appear in the brief");
    assert.equal(item.title, "Overdue thing");
    assert.ok(item.why.includes("overdue"));
    const done = item.actions.find((a) => a.id === "complete");
    assert.ok(done && done.path.startsWith("/tasks/"));
    // The action must actually work when dispatched verbatim.
    const applied = await fetch(`${base}${done.path}`, { method: done.method, headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(applied.status, 200);
  } finally { await app.close(); }
});

test("GET /brief/today honours ?limit=", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-briefroute3-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    for (let i = 0; i < 6; i += 1) runtime.tasks.add({ queue: "user", title: `T${i}`, bucket: "today" });
    const res = await fetch(`${base}/brief/today?limit=2`);
    const json = await res.json();
    assert.ok(json.items.length <= 2);
  } finally { await app.close(); }
});
