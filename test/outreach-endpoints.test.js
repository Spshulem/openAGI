// test/outreach-endpoints.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

async function bootApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "out-ep-"));
  process.env.OPENAGI_AUTH_TOKEN = ""; // local, no auth for the test
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0 });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  return { runtime, app, base, dataDir };
}

test("GET /outreach/feed?since=N returns items after the cursor", async () => {
  const { runtime, app, base } = await bootApp();
  runtime.outreach.append({ type: "draft", title: "A" });
  const b = runtime.outreach.append({ type: "draft", title: "B" });
  runtime.outreach.append({ type: "draft", title: "C" });
  const res = await fetch(`${base}/outreach/feed?since=${b.seq}`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(json.items.map((i) => i.title), ["C"]);
  assert.equal(json.cursor, runtime.outreach.nextSeq - 1);
  await app.close?.();
});

test("GET /outreach/digest returns the current rollup or null", async () => {
  const { runtime, app, base } = await bootApp();
  runtime.outreach.append({ type: "draft", title: "A" });
  const res = await fetch(`${base}/outreach/digest`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.ok("digest" in json);
  await app.close?.();
});

test("POST /outreach/:id/act approves a draft via delegation and is idempotent", async () => {
  const { runtime, app, base } = await bootApp();
  const draft = runtime.drafts.add({ kind: "reply", title: "Reply", body: "hello" });
  const item = runtime.outreach.append({
    type: "draft", sourceRef: { kind: "draft", id: draft.id },
    title: "Reply", needsDecision: false, actions: ["approve", "dismiss"]
  });
  const res = await fetch(`${base}/outreach/${item.id}/act`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "approve" })
  });
  assert.equal(res.status, 200);
  assert.equal(runtime.drafts.get(draft.id).status, "approved");
  assert.equal(runtime.outreach.get(item.id).status, "acted");

  const res2 = await fetch(`${base}/outreach/${item.id}/act`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "dismiss" })
  });
  assert.equal(res2.status, 200);
  assert.equal(runtime.outreach.get(item.id).decision.action, "approve");
  await app.close?.();
});

test("POST /outreach/:id/act on unknown id returns 404", async () => {
  const { app, base } = await bootApp();
  const res = await fetch(`${base}/outreach/nope/act`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "approve" })
  });
  assert.equal(res.status, 404);
  await app.close?.();
});

test("POST /outreach/:id/reply forwards the text to the agent with item context", async () => {
  const { runtime, app, base } = await bootApp();
  const item = runtime.outreach.append({ type: "stalled-task", sourceRef: { kind: "task", id: "task_9" }, title: "Stalled: X", needsDecision: true, actions: ["close", "keep"] });
  let lastForward = null;
  const fakeChannels = { handleLocalMessage: async (m) => { lastForward = m; return { reply: "ok" }; } };
  app.__setChannels(fakeChannels);
  const res = await fetch(`${base}/outreach/${item.id}/reply`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "close it and remind me Friday" })
  });
  assert.equal(res.status, 200);
  assert.match(lastForward.text, /close it and remind me Friday/);
  assert.match(lastForward.text, /Stalled: X/);
  await app.close?.();
});
