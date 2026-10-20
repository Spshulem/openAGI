import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import WebSocket from "ws";
import { DeviceModelHub, attachDeviceModelRelay, DEVICE_MODEL_UNAVAILABLE } from "../src/device-model-relay.js";
import { OnDeviceModelProvider, fitHistory, compactSystemPrompt } from "../src/on-device-provider.js";
import { createModelProvider } from "../src/model-provider.js";

const TOKEN = "owner-token-for-tests";

async function startRelay(t) {
  const hub = new DeviceModelHub();
  const relay = attachDeviceModelRelay({ getAuthToken: () => TOKEN, hub });
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url, "http://x").pathname === relay.path) relay.upgrade(req, socket, head);
    else socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${server.address().port}${relay.path}`;
  t.after(async () => {
    relay.close();
    await new Promise((resolve) => server.close(resolve));
  });
  return { hub, url };
}

// A fake phone: answers each generate frame with the next scripted reply.
async function connectDevice(url, replies, { token = TOKEN, contextSize = 4096 } = {}) {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const seen = [];
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data));
    if (frame.type !== "generate") return;
    seen.push(frame);
    const reply = replies.shift() ?? { text: "out of script" };
    if (reply.delta) socket.send(JSON.stringify({ type: "delta", id: frame.id, text: reply.delta }));
    if (reply.error) socket.send(JSON.stringify({ type: "error", id: frame.id, code: reply.error, message: "nope" }));
    else if (!reply.silent) socket.send(JSON.stringify({ type: "result", id: frame.id, ...reply }));
  });
  socket.send(JSON.stringify({ type: "hello", model: "fake-device", contextSize }));
  return { socket, seen };
}

function fakeRegistry(calls) {
  const tools = ["remember", "recall", "add_task", "run_shell"].map((name) => ({
    name, description: `${name} tool`, input_schema: { type: "object", properties: { content: { type: "string" } } }
  }));
  return {
    toAnthropicTools: () => tools,
    invoke: async (name, args) => { calls.push({ name, args }); return { ok: true, result: { saved: true } }; }
  };
}

async function untilConnected(hub) {
  while (!hub.info) await new Promise((resolve) => setTimeout(resolve, 5));
}

test("text reply streams deltas and returns the device's text", async (t) => {
  const { hub, url } = await startRelay(t);
  const device = await connectDevice(url, [{ delta: "Hel", text: "Hello there" }]);
  t.after(() => device.socket.close());
  await untilConnected(hub);
  const deltas = [];
  const provider = new OnDeviceModelProvider({ hub });
  const result = await provider.generate({
    input: "hi", agent: { name: "Pip" }, toolRegistry: fakeRegistry([]),
    onTextDelta: (delta) => deltas.push(delta)
  });
  assert.equal(result.text, "Hello there");
  assert.equal(result.model, "fake-device");
  assert.deepEqual(deltas.map((d) => [d.text, d.reset]), [["Hel", true]]);
  // Only the small-model tool set is advertised.
  assert.deepEqual(device.seen[0].tools.map((tool) => tool.name), ["remember", "recall", "add_task"]);
  assert.match(device.seen[0].system, /You are Pip/);
});

test("tool call runs in the daemon and its result goes back to the device", async (t) => {
  const { hub, url } = await startRelay(t);
  const device = await connectDevice(url, [
    { toolCall: { name: "remember", arguments: { content: "likes tea" } } },
    { text: "Saved." }
  ]);
  t.after(() => device.socket.close());
  await untilConnected(hub);
  const calls = [];
  const result = await new OnDeviceModelProvider({ hub }).generate({ input: "remember I like tea", toolRegistry: fakeRegistry(calls) });
  assert.equal(result.text, "Saved.");
  assert.deepEqual(calls, [{ name: "remember", args: { content: "likes tea" } }]);
  const second = device.seen[1].messages.slice(-2);
  assert.equal(second[0].toolCall.name, "remember");
  assert.equal(second[1].role, "tool");
  assert.match(second[1].content, /saved/);
});

test("hop limit forces a final answer without tools", async (t) => {
  const { hub, url } = await startRelay(t);
  const loop = { toolCall: { name: "recall", arguments: {} } };
  const device = await connectDevice(url, [loop, loop, { text: "Done." }]);
  t.after(() => device.socket.close());
  await untilConnected(hub);
  const calls = [];
  const result = await new OnDeviceModelProvider({ hub, maxToolHops: 2 }).generate({ input: "x", toolRegistry: fakeRegistry(calls) });
  assert.equal(result.text, "Done.");
  assert.equal(calls.length, 2);
  assert.equal(device.seen.length, 3);
  assert.deepEqual(device.seen[2].tools, []);
});

test("a tool outside the small-model set is refused, not run", async (t) => {
  const { hub, url } = await startRelay(t);
  const device = await connectDevice(url, [{ toolCall: { name: "run_shell", arguments: {} } }, { text: "Can't." }]);
  t.after(() => device.socket.close());
  await untilConnected(hub);
  const calls = [];
  const result = await new OnDeviceModelProvider({ hub }).generate({ input: "x", toolRegistry: fakeRegistry(calls) });
  assert.equal(result.text, "Can't.");
  assert.equal(calls.length, 0);
});

test("no device connected fails with device-model-unavailable after the wait", async (t) => {
  const { hub } = await startRelay(t);
  const provider = new OnDeviceModelProvider({ hub, waitMs: 30 });
  await assert.rejects(provider.generate({ input: "x" }), (error) => error.code === DEVICE_MODEL_UNAVAILABLE);
});

test("device timeout and device error both reject the turn", async (t) => {
  const { hub, url } = await startRelay(t);
  const device = await connectDevice(url, [{ silent: true }, { error: "quota" }]);
  t.after(() => device.socket.close());
  await untilConnected(hub);
  const provider = new OnDeviceModelProvider({ hub, timeoutMs: 50 });
  await assert.rejects(provider.generate({ input: "x" }), (error) => error.code === "device-model-timeout");
  await assert.rejects(provider.generate({ input: "y" }), (error) => error.code === "quota");
});

test("disconnect mid-generation rejects pending work", async (t) => {
  const { hub, url } = await startRelay(t);
  const device = await connectDevice(url, [{ silent: true }]);
  await untilConnected(hub);
  const pending = new OnDeviceModelProvider({ hub }).generate({ input: "x" });
  while (device.seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  device.socket.close();
  await assert.rejects(pending, (error) => error.code === DEVICE_MODEL_UNAVAILABLE);
});

test("relay refuses a wrong token", async (t) => {
  const { url } = await startRelay(t);
  await assert.rejects(connectDevice(url, [], { token: "wrong" }), /401/);
});

test("history is trimmed newest-first to the context budget", () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `${i} ${"x".repeat(400)}` }));
  const kept = fitHistory(messages, { contextSize: 2048, fixedChars: 1000 });
  assert.ok(kept.length > 0 && kept.length < 40);
  assert.match(kept.at(-1).content, /^39 /);
  assert.ok(kept.reduce((n, m) => n + m.content.length, 0) <= (2048 - 512) * 3.5 - 1000);
});

test("compact system prompt keeps the persona and drops the desktop catalog", () => {
  const prompt = compactSystemPrompt({ name: "Pip", systemPrompt: "# Pip\nHelps with groceries." });
  assert.match(prompt, /Helps with groceries/);
  assert.match(prompt, /onboarding.*one small step/);
  assert.match(prompt, /Keep keys in Settings, never chat/);
  assert.match(prompt, /normal approval gates/);
  assert.doesNotMatch(prompt, /run_mcp_tool|ABI loop/);
});

test("OPENAGI_PROVIDER=on-device selects the on-device provider", () => {
  assert.ok(createModelProvider({ preferred: "on-device" }) instanceof OnDeviceModelProvider);
});
