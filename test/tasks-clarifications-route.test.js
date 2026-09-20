// test/tasks-clarifications-route.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

async function bootApp(dataDir) {
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, authToken: null });
  const listened = await app.listen();
  return { runtime, app, base: listened.url ?? `http://127.0.0.1:${listened.port}` };
}

// `/tasks/clarifications` is two segments, so `^/tasks/[^/]+$` matches it. The
// handler was declared after that pattern, so every caller got a 404 reading
// "unknown task" — the id lookup answering for a literal route. The phone's
// Inbox showed it as "this item is gone", which is how it was finally noticed.
test("GET /tasks/clarifications is not swallowed by the /tasks/:id handler", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-clarifroute-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const res = await fetch(`${base}/tasks/clarifications`);
    assert.equal(res.status, 200);
    const json = await res.json();
    // The shape is the clarification store's, never the task store's error.
    assert.notDeepEqual(json, { error: "unknown task" });
    assert.ok(Array.isArray(json) || Array.isArray(json?.clarifications),
      `expected a clarification list, got ${JSON.stringify(json).slice(0, 120)}`);
  } finally { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

// The id route must still work for a genuine id, so the fix is an ordering
// change and not a hole: a task that does not exist still answers 404.
test("GET /tasks/:id still answers for a real id and 404s for an unknown one", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-clarifroute-id-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    const created = runtime.tasks.add({ queue: "user", title: "Ship the widget", bucket: "today", priority: 50 });
    const found = await fetch(`${base}/tasks/${created.id}`);
    assert.equal(found.status, 200);
    assert.equal((await found.json()).title, "Ship the widget");

    const missing = await fetch(`${base}/tasks/task_does_not_exist`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "unknown task" });
  } finally { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
