import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDefaultRuntime, createHostedInterface } from "../src/index.js";

test("JSON and streaming messages correlate responses with private operational logs", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-diagnostics-"));
  const runtime = createDefaultRuntime({ dataDir });
  runtime.agentHost.handleMessage = async (input) => {
    if (input.text === "fail") throw new Error("provider unavailable Bearer private-fixture");
    return { session: { id: "telegram:PRIVATE_CHAT:main" }, model: { provider: "test", model: "fixture" }, reply: "PRIVATE_REPLY" };
  };
  const channels = { start() {}, stop() {}, handleLocalMessage: (input, options) => runtime.agentHost.handleMessage(input, options) };
  const app = createHostedInterface(runtime, { dataDir, port: 0, channels, tickerMs: 60_000 });
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const oldWrite = process.stderr.write;
  const oldLevel = process.env.OPENAGI_LOG_LEVEL;
  let output = "";
  process.stderr.write = (text) => { output += text; return true; };
  process.env.OPENAGI_LOG_LEVEL = "debug";
  t.after(() => {
    process.stderr.write = oldWrite;
    if (oldLevel === undefined) delete process.env.OPENAGI_LOG_LEVEL;
    else process.env.OPENAGI_LOG_LEVEL = oldLevel;
  });
  const address = await app.listen();
  const success = await fetch(`${address.url}/message?token=PRIVATE_QUERY`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "PRIVATE_PROMPT", metadata: { requestId: "req-success" } })
  });
  assert.equal(success.headers.get("x-request-id"), "req-success");
  assert.equal((await success.json()).reply, "PRIVATE_REPLY");
  for (const streaming of [false, true]) {
    const response = await fetch(`${address.url}/message`, {
      method: "POST", headers: { "content-type": "application/json", ...(streaming ? { accept: "text/event-stream" } : {}) },
      body: JSON.stringify({ text: "fail" })
    });
    const requestId = response.headers.get("x-request-id");
    assert.match(requestId, /^[a-f0-9-]{36}$/);
    const body = await response.text();
    assert.ok(body.includes(requestId), "failure carries the same ID as its response header");
    assert.ok(output.includes(requestId), "failure log carries the response ID");
  }
  assert.match(output, /agent-turn-completed/);
  assert.match(output, /http-request/);
  assert.match(output, /sse-open/);
  assert.match(output, /sse-close/);
  assert.doesNotMatch(output, /PRIVATE_PROMPT|PRIVATE_REPLY|PRIVATE_QUERY|PRIVATE_CHAT|private-fixture/);
});
