// test/mobile-summary-route.test.js
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

test("the summary answers an empty install without throwing", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobsum-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const res = await fetch(`${base}/mobile/summary`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json.today, []);
    assert.equal(json.counts.today, 0);
    assert.equal(json.counts.pendingActions, 0);
    assert.ok(json.generatedAt);
    assert.ok(typeof json.brief.headline === "string");
    assert.ok(res.headers.get("etag"));
    assert.equal(res.headers.get("cache-control"), "no-store");
  } finally { await app.close(); }
});

test("today's tasks are returned newest-priority-first with overdue flagged", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobsum2-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    runtime.tasks.add({ queue: "user", title: "Low", bucket: "today", priority: 10 });
    runtime.tasks.add({ queue: "user", title: "High", bucket: "today", priority: 90 });
    runtime.tasks.add({ queue: "user", title: "Overdue", bucket: "today", priority: 50, dueDate: "2020-01-01T00:00:00.000Z" });
    runtime.tasks.add({ queue: "user", title: "Later", bucket: "this_week", priority: 99 });
    const json = await (await fetch(`${base}/mobile/summary`)).json();
    assert.deepEqual(json.today.map((t) => t.title), ["High", "Overdue", "Low"]);
    assert.equal(json.today.find((t) => t.title === "Overdue").overdue, true);
    assert.equal(json.today.find((t) => t.title === "High").overdue, false);
    assert.equal(json.counts.today, 3);
    assert.equal(json.counts.overdue, 1);
    assert.equal(json.counts.this_week, 1);
  } finally { await app.close(); }
});

// The task store holds "" for a cleared due date. The wire contract is a date
// or null, and both phone decoders reject an empty string — so one such task
// failed the entire summary against a real brain.
test("an empty-string due date reaches the phone as null, never as \"\"", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobsum-emptydue-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    runtime.tasks.add({ queue: "user", title: "Cleared due date", bucket: "today", priority: 50, dueDate: "" });
    const json = await (await fetch(`${base}/mobile/summary`)).json();
    const task = json.today.find((t) => t.title === "Cleared due date");
    assert.ok(task, "the task is present");
    assert.equal(task.dueDate, null);
    assert.equal(task.overdue, false);
  } finally { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("completed tasks leave the widget payload", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobsum3-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    const task = runtime.tasks.add({ queue: "user", title: "Done soon", bucket: "today" });
    await fetch(`${base}/tasks/${task.id}/complete`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ completedVia: "mobile" })
    });
    const json = await (await fetch(`${base}/mobile/summary`)).json();
    assert.deepEqual(json.today, []);
    assert.equal(json.counts.today, 0);
  } finally { await app.close(); }
});

test("the task limit is bounded so a widget cannot ask for the whole store", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobsum4-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    for (let i = 0; i < 40; i += 1) runtime.tasks.add({ queue: "user", title: `T${i}`, bucket: "today" });
    const json = await (await fetch(`${base}/mobile/summary?limit=500`)).json();
    assert.equal(json.today.length, 20);
    assert.equal(json.counts.today, 40);
  } finally { await app.close(); }
});

test("an unchanged summary is a 304", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobsum5-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    runtime.tasks.add({ queue: "user", title: "Stable", bucket: "today" });
    const first = await fetch(`${base}/mobile/summary`);
    const etag = first.headers.get("etag");
    const second = await fetch(`${base}/mobile/summary`, { headers: { "if-none-match": etag } });
    assert.equal(second.status, 304);
    runtime.tasks.add({ queue: "user", title: "New thing", bucket: "today" });
    const third = await fetch(`${base}/mobile/summary`, { headers: { "if-none-match": etag } });
    assert.equal(third.status, 200);
    assert.notEqual(third.headers.get("etag"), etag);
  } finally { await app.close(); }
});

test("the ETag ignores generatedAt so a quiet daemon keeps answering 304", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobsum6-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    runtime.tasks.add({ queue: "user", title: "Stable", bucket: "today" });
    const a = await fetch(`${base}/mobile/summary`);
    await new Promise((r) => setTimeout(r, 15));
    const b = await fetch(`${base}/mobile/summary`);
    assert.equal(a.headers.get("etag"), b.headers.get("etag"));
    const aJson = await a.json();
    const bJson = await b.json();
    assert.notEqual(aJson.generatedAt, bJson.generatedAt);
  } finally { await app.close(); }
});
