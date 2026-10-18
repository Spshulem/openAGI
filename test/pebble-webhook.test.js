import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { PebbleWebhook } from "../src/integrations/pebble.js";

async function fixture(t, { text = "Remember the fixture key is blue", testEvent = false, audioOnly = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pebble-webhook-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const memories = [], tasks = [];
  const now = Date.now(), secret = "fixture-signing-secret";
  const runtime = {
    memory: { remember(item) { memories.push(item); return { id: "memory-fixture" }; } },
    tasks: { add(task, options) { tasks.push({ ...task, ...options }); return { id: "task-fixture" }; } },
    agentHost: { handleMessage() { throw new Error("Speech must not become owner authority."); } }
  };
  const receiver = new PebbleWebhook({ runtime, dir, env: { PEBBLE_WEBHOOK_SECRET: secret }, now: () => now });
  const form = new FormData();
  if (!audioOnly) form.set("transcription", text);
  else form.set("audio", new Blob(["fixture audio"], { type: "audio/mp4" }), "fixture.m4a");
  form.set("recordedAt", String(now)); form.set("client", "ring");
  if (testEvent) form.set("test", "true");
  const response = new Response(form);
  const raw = Buffer.from(await response.arrayBuffer());
  const headers = { "content-type": response.headers.get("content-type"), "x-index-webhook-version": "1", "x-index-timestamp": String(Math.floor(now / 1000)), "x-index-delivery": "recording-fixture", "x-index-trigger": testEvent ? "test-event" : "single-click-hold", ...(testEvent ? { "x-index-test": "true" } : {}) };
  const prefix = `v1\n${headers["x-index-timestamp"]}\nrecording-fixture\n${headers["x-index-trigger"]}\n${testEvent ? "1" : "0"}\n`;
  headers["x-index-signature"] = createHmac("sha256", secret).update(prefix).update(raw).digest("hex");
  return { receiver, runtime, raw, headers, memories, tasks, dir, secret, now };
}

test("signed Pebble multipart voice memos persist once, including across restart", async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.receiver.handle(f.headers, f.raw), f.receiver.handle(f.headers, f.raw)]);
  assert.equal(results[0].status, 202); assert.equal(f.memories.length, 1);
  assert.equal(f.memories[0].content, "Remember the fixture key is blue");
  const restarted = new PebbleWebhook({ runtime: f.runtime, dir: f.dir, env: { PEBBLE_WEBHOOK_SECRET: f.secret }, now: () => f.now });
  assert.equal((await restarted.handle(f.headers, f.raw)).body.duplicate, true);
  assert.equal(f.memories.length, 1);
});
test("missing, tampered, stale and unsupported Pebble signatures fail before any write", async t => {
  const f = await fixture(t);
  for (const changes of [{ "x-index-signature": "wrong" }, { "x-index-timestamp": "1000000000" }, { "x-index-webhook-version": "2" }, { "x-index-delivery": "../outside" }, { "x-index-trigger": "other" }]) assert.equal((await f.receiver.handle({ ...f.headers, ...changes }, f.raw)).status, 401);
  assert.equal((await f.receiver.handle(f.headers, Buffer.concat([f.raw, Buffer.from("tamper")]))).status, 401);
  f.receiver.env.PEBBLE_WEBHOOK_SECRET = "";
  assert.equal((await f.receiver.handle(f.headers, f.raw)).status, 401);
  assert.equal(f.memories.length, 0);
});
test("Pebble test events never create memories or reminders", async t => {
  const f = await fixture(t, { text: "remind me to test fixture", testEvent: true });
  assert.equal((await f.receiver.handle(f.headers, f.raw)).body.test, true);
  assert.equal(f.memories.length, 0); assert.equal(f.tasks.length, 0);
});
test("Pebble reminder speech creates a task without claiming a scheduled notification", async t => {
  const f = await fixture(t, { text: "remind me to buy fixture batteries" });
  const result = await f.receiver.handle(f.headers, f.raw);
  assert.equal(result.body.taskId, "task-fixture"); assert.equal(result.body.scheduled, false);
  assert.match(f.tasks[0].sourceId, /^pebble-/); assert.equal(f.tasks[0].source, "pebble-index");
});
test("recording-only payloads get an actionable response instead of inventing a transcript", async t => {
  const f = await fixture(t, { audioOnly: true });
  assert.equal((await f.receiver.handle(f.headers, f.raw)).status, 422);
  assert.equal(f.memories.length, 0);
});
