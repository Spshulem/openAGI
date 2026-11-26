// A client that lost the answer to a send (a dropped stream, a relaunch) asks
// main how each of its named turns stands before it resends anything:
// GET /conversations/:thread/turns?ids=… So reconnecting never releases a
// burst, and a send main already took is waited for, never sent twice. Built
// on the hub's queue (conversation-queue.js), LiveTurns and the session's
// own records; two sends with the same words are still two turns.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { NodeRegistry } from "../src/node-registry.js";
import { turnStates } from "../src/message-turns.js";

const SESSION = "devices:supervisor:main";
const PHONE = { id: "mobile:turns-phone", token: "t".repeat(43) };
const OTHER = { id: "node:turns-bridge", token: "u".repeat(43) };

async function mainApp(t, generate, { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-turns-")), keep = false } = {}) {
  const nodeRegistry = new NodeRegistry({ dir: path.join(dataDir, "nodes") });
  if (!nodeRegistry.enrollment(PHONE.id)) nodeRegistry.enroll(PHONE.id, PHONE.token, { platform: "mobile", name: "iPhone" });
  if (!nodeRegistry.enrollment(OTHER.id)) nodeRegistry.enroll(OTHER.id, OTHER.token, { platform: "linux", name: "Bridge" });
  const runtime = createDurableRuntime({ dataDir });
  const calls = [];
  runtime.agentHost.modelProvider = {
    name: "turns-provider", model: "test-model", isConfigured: () => true,
    async generate(request) { calls.push(request); return generate(calls.length, request); }
  };
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, authToken: "owner", dataDir, nodeRegistry, tickerMs: 60_000 });
  const { url: base } = await app.listen();
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(async () => { await close(); if (!keep) fs.rmSync(dataDir, { recursive: true, force: true }); });
  const owner = { authorization: "Bearer owner" };
  const phone = { authorization: `Bearer ${PHONE.token}`, "x-openagi-node-id": PHONE.id };
  const other = { authorization: `Bearer ${OTHER.token}`, "x-openagi-node-id": OTHER.id };
  // The Mac Supervisor speaks with the owner's credential.
  const send = (body, { stream = false, signal, as = owner } = {}) => fetch(`${base}/message`, {
    method: "POST", signal,
    headers: { ...as, "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json" },
    body: JSON.stringify({ thread: "supervisor", ...(as === owner ? { from: "mac-supervisor" } : {}), ...body })
  });
  const turns = async (ids, { as = owner, query = "" } = {}) => {
    const response = await fetch(`${base}/conversations/supervisor/turns?ids=${encodeURIComponent(ids.join(","))}${query}`, { headers: as });
    return { status: response.status, body: await response.json() };
  };
  const stateOf = async (ids, options) => Object.fromEntries((await turns(ids, options)).body.turns.map((turn) => [turn.requestId, turn.state]));
  const removeQueued = (id) => fetch(`${base}/conversations/supervisor/queue/${id}`, { method: "DELETE", headers: owner });
  return { runtime, calls, send, turns, stateOf, removeQueued, close, dataDir, owner, phone, other };
}

function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { opened, open };
}

async function readUntil(response, event) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(`event: ${event}\n`)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

async function until(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met in time");
}

const reply = (text) => ({ id: `r_${text.replace(/\W/g, "_")}`, text, provider: "test", model: "test-model", toolCalls: [] });
const userLines = (runtime) => runtime.agentHost.store.getSession(SESSION).messages.filter((m) => m.role === "user");

test("queued sends each run once, in order, and the turns route says how each stands", async (t) => {
  const first = gate();
  const { runtime, calls, send, stateOf } = await mainApp(t, async (n) => { if (n === 1) await first.opened; return reply(`Reply ${n}`); });
  const a = new AbortController();
  await readUntil(await send({ text: "one", requestId: "mac-aaaaaaaa1" }, { stream: true, signal: a.signal }), "session");
  // Two more sends while the first runs: the hub queues them behind it.
  const b = send({ text: "two", requestId: "mac-bbbbbbbb2" });
  const c = send({ text: "three", requestId: "mac-cccccccc3" });
  await until(async () => (await stateOf(["mac-cccccccc3"]))["mac-cccccccc3"] === "queued");
  assert.deepEqual(await stateOf(["mac-aaaaaaaa1", "mac-bbbbbbbb2", "mac-cccccccc3", "mac-dddddddd4"]),
    { "mac-aaaaaaaa1": "running", "mac-bbbbbbbb2": "queued", "mac-cccccccc3": "queued", "mac-dddddddd4": "unknown" });
  // The first stream dropped: main keeps running it.
  a.abort();
  first.open();
  assert.equal((await (await b).json()).reply, "Reply 2");
  assert.equal((await (await c).json()).reply, "Reply 3");
  await until(async () => (await stateOf(["mac-aaaaaaaa1"]))["mac-aaaaaaaa1"] === "done");
  assert.equal(calls.length, 3, "one model call per send");
  assert.deepEqual(userLines(runtime).map((m) => [m.content, m.metadata.requestId]),
    [["one", "mac-aaaaaaaa1"], ["two", "mac-bbbbbbbb2"], ["three", "mac-cccccccc3"]]);
});

test("a lost acknowledgement after main took the send reads running, then done, and a resend replays it", async (t) => {
  const model = gate();
  const { runtime, calls, send, turns, stateOf, phone } = await mainApp(t, async () => { await model.opened; return reply("Handled."); });
  const lost = new AbortController();
  const pending = send({ text: "book the room", requestId: "ios-lostack01" }, { as: phone, signal: lost.signal });
  await until(async () => (await stateOf(["ios-lostack01"], { as: phone }))["ios-lostack01"] === "running");
  assert.deepEqual((await turns(["ios-lostack01"], { as: phone })).body.active.map((turn) => turn.requestId), ["ios-lostack01"]);
  lost.abort();
  await pending.catch(() => {});
  model.open();
  await until(async () => (await stateOf(["ios-lostack01"], { as: phone }))["ios-lostack01"] === "done");
  assert.equal((await turns(["ios-lostack01"], { as: phone })).body.active.length, 0);
  const replay = await (await send({ text: "book the room", requestId: "ios-lostack01" }, { as: phone })).json();
  assert.equal(replay.reply, "Handled.");
  assert.equal(replay.replayed, true);
  assert.equal(calls.length, 1);
  assert.equal(userLines(runtime).length, 1);
});

test("the same words under two ids are two turns; one id with other words is refused while it waits", async (t) => {
  const first = gate();
  const { runtime, calls, send, stateOf } = await mainApp(t, async (n) => { if (n === 1) await first.opened; return reply(`Reply ${n}`); });
  const running = send({ text: "yes", requestId: "mac-same0001" });
  await until(async () => (await stateOf(["mac-same0001"]))["mac-same0001"] === "running");
  const second = send({ text: "yes", requestId: "mac-same0002" });
  await until(async () => (await stateOf(["mac-same0002"]))["mac-same0002"] === "queued");
  const conflict = await send({ text: "no", requestId: "mac-same0002" });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, "request_conflict");
  first.open();
  assert.equal((await (await running).json()).reply, "Reply 1");
  assert.equal((await (await second).json()).reply, "Reply 2");
  assert.equal(calls.length, 2);
  assert.deepEqual(userLines(runtime).map((m) => m.content), ["yes", "yes"]);
});

test("a send removed from the hub's queue reads failed (removed), and a resend never runs it", async (t) => {
  const first = gate();
  const { calls, send, stateOf, turns, removeQueued } = await mainApp(t, async () => { await first.opened; return reply("Ran."); });
  const running = send({ text: "first", requestId: "mac-remove01" });
  await until(async () => (await stateOf(["mac-remove01"]))["mac-remove01"] === "running");
  const waiting = send({ text: "second", requestId: "mac-remove02" });
  await until(async () => (await stateOf(["mac-remove02"]))["mac-remove02"] === "queued");
  assert.equal((await removeQueued("mac-remove02")).status, 200);
  await waiting.catch(() => {});
  assert.deepEqual((await turns(["mac-remove02"])).body.turns, [{ requestId: "mac-remove02", state: "failed", code: "removed" }]);
  first.open();
  await running;
  const again = await send({ text: "second", requestId: "mac-remove02" });
  await again.text();
  assert.equal(calls.length, 1, "the removed send never ran");
});

test("after a main restart: a finished turn reads done, a question with no reply reads interrupted, neither reruns", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-turns-restart-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const before = await mainApp(t, async () => reply("Before restart."), { dataDir, keep: true });
  assert.equal((await (await before.send({ text: "first", requestId: "mac-restart1" })).json()).reply, "Before restart.");
  // What a main that stopped mid-turn leaves behind: the question stored,
  // no reply.
  before.runtime.agentHost.store.appendMessage(SESSION, { role: "user", content: "second", metadata: { requestId: "mac-restart2", thread: "supervisor" } });
  await before.close();

  const after = await mainApp(t, async () => reply("After restart."), { dataDir, keep: true });
  assert.deepEqual(await after.stateOf(["mac-restart1", "mac-restart2", "mac-restart3"]),
    { "mac-restart1": "done", "mac-restart2": "interrupted", "mac-restart3": "unknown" });
  const replay = await (await after.send({ text: "first", requestId: "mac-restart1" })).json();
  assert.equal(replay.replayed, true);
  const interrupted = await after.send({ text: "second", requestId: "mac-restart2" });
  assert.equal(interrupted.status, 500);
  assert.equal((await interrupted.json()).code, "interrupted");
  assert.equal(after.calls.length, 0, "neither ran again");
  assert.equal((await (await after.send({ text: "third", requestId: "mac-restart3" })).json()).reply, "After restart.");
  assert.equal(after.calls.length, 1, "the send main never took ran once");
});

test("the turns route is for the owner and paired phones, and validates its ids", async (t) => {
  const { turns, phone, other } = await mainApp(t, async () => reply("ok"));
  const shape = await turns(["ios-phone001"], { as: phone });
  assert.equal(shape.status, 200);
  assert.deepEqual(shape.body, { thread: "supervisor", conversationId: "main", active: [], turns: [{ requestId: "ios-phone001", state: "unknown" }] });
  for (const ids of [["short"], ["has space1"], Array.from({ length: 51 }, (_, i) => `mac-many${String(i).padStart(4, "0")}`)]) {
    assert.equal((await turns(ids)).status, 400, `rejects ${ids.length} ids`);
  }
  assert.equal((await turns(["mac-anyone01"], { as: {} })).status, 401);
  assert.equal((await turns(["mac-anyone01"], { as: other })).status, 403);
  assert.equal((await turns(["mac-anyone01"], { query: "&conversationId=nope" })).status, 400);
});

test("turnStates reads the hub's queue and its tombstones when no live turn or record is left", () => {
  const queue = {
    find: (_session, id) => (id === "mac-waiting1" ? { requestId: id } : null),
    tombstoneFor: (_session, id) => (id === "mac-stopped1" ? { requestId: id, outcome: "stopped" } : null)
  };
  const store = { getSession: () => ({ messages: [] }) };
  assert.deepEqual(turnStates({ store, liveTurns: null, queue, sessionId: SESSION, requestIds: ["mac-waiting1", "mac-stopped1", "mac-nothing1"] }), [
    { requestId: "mac-waiting1", state: "queued", stage: "queued" },
    { requestId: "mac-stopped1", state: "failed", code: "stopped" },
    { requestId: "mac-nothing1", state: "unknown" }
  ]);
});
