// A Supervisor client (the Mac, a phone) keeps a durable outbox of sends.
// When it reconnects it must be able to ask main how each named send stands,
// and replaying its outbox must never turn one send into two turns, across a
// lost acknowledgement, a turn still running, or a main restart. Two sends
// with the same words are still two sends: main dedupes by id, never by text.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { NodeRegistry } from "../src/node-registry.js";
import { TurnReceipts, turnFingerprint } from "../src/message-turns.js";

const SESSION = "devices:supervisor:main";
const PHONE = { id: "mobile:outbox-phone", token: "o".repeat(43) };

async function mainApp(t, generate, { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-outbox-")), keep = false } = {}) {
  const nodeRegistry = new NodeRegistry({ dir: path.join(dataDir, "nodes") });
  if (!nodeRegistry.enrollment(PHONE.id)) nodeRegistry.enroll(PHONE.id, PHONE.token, { platform: "mobile", name: "iPhone" });
  const runtime = createDurableRuntime({ dataDir });
  const calls = [];
  runtime.agentHost.modelProvider = {
    name: "outbox-provider", model: "test-model", isConfigured: () => true,
    async generate(request) { calls.push(request); return generate(calls.length, request); }
  };
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, authToken: "owner", dataDir, nodeRegistry, tickerMs: 60_000 });
  const { url: base } = await app.listen();
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(async () => { await close(); if (!keep) fs.rmSync(dataDir, { recursive: true, force: true }); });
  const owner = { authorization: "Bearer owner" };
  const phone = { authorization: `Bearer ${PHONE.token}`, "x-openagi-node-id": PHONE.id };
  // The Mac Supervisor speaks with the owner's credential.
  const send = (body, { stream = false, signal, as = owner } = {}) => fetch(`${base}/message`, {
    method: "POST", signal,
    headers: { ...as, "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json" },
    body: JSON.stringify({ thread: "supervisor", from: "mac-supervisor", ...(as === phone ? { from: undefined } : {}), ...body })
  });
  const turns = async (ids, { as = owner, query = "" } = {}) => {
    const response = await fetch(`${base}/conversations/supervisor/turns?ids=${encodeURIComponent(ids.join(","))}${query}`, { headers: as });
    return { status: response.status, body: await response.json() };
  };
  const stateOf = async (ids, options) => Object.fromEntries((await turns(ids, options)).body.turns.map((turn) => [turn.requestId, turn.state]));
  const history = async () => (await fetch(`${base}/conversations/supervisor/messages`, { headers: owner })).json();
  return { runtime, calls, send, turns, stateOf, history, close, dataDir, owner, phone };
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

test("the Mac names its Supervisor turns: queued sends each run once, in order, and report their state", async (t) => {
  const first = gate();
  const { runtime, calls, send, stateOf } = await mainApp(t, async (n) => { if (n === 1) await first.opened; return reply(`Reply ${n}`); });
  const a = new AbortController();
  await readUntil(await send({ text: "one", requestId: "mac-aaaaaaaa1" }, { stream: true, signal: a.signal }), "session");
  // Two more sends while the first runs: main queues them behind it.
  const b = send({ text: "two", requestId: "mac-bbbbbbbb2" });
  const c = send({ text: "three", requestId: "mac-cccccccc3" });
  await until(async () => (await stateOf(["mac-bbbbbbbb2"]))["mac-bbbbbbbb2"] === "queued");
  assert.deepEqual(await stateOf(["mac-aaaaaaaa1", "mac-bbbbbbbb2", "mac-cccccccc3", "mac-dddddddd4"]),
    { "mac-aaaaaaaa1": "running", "mac-bbbbbbbb2": "queued", "mac-cccccccc3": "queued", "mac-dddddddd4": "unknown" });
  a.abort();
  first.open();
  assert.equal((await (await b).json()).reply, "Reply 2");
  assert.equal((await (await c).json()).reply, "Reply 3");
  await until(async () => (await stateOf(["mac-aaaaaaaa1"]))["mac-aaaaaaaa1"] === "done");
  assert.equal(calls.length, 3, "one model call per send");
  assert.deepEqual(userLines(runtime).map((m) => [m.content, m.metadata.requestId]),
    [["one", "mac-aaaaaaaa1"], ["two", "mac-bbbbbbbb2"], ["three", "mac-cccccccc3"]]);
});

test("reconnecting during an active turn: resending its id follows it, and a queued send behind it runs once", async (t) => {
  const model = gate();
  const { runtime, calls, send, stateOf } = await mainApp(t, async (n) => { if (n === 1) await model.opened; return reply(`Reply ${n}`); });
  const dropped = new AbortController();
  await readUntil(await send({ text: "long job", requestId: "mac-active01" }, { stream: true, signal: dropped.signal }), "session");
  dropped.abort();
  const queuedDrop = new AbortController();
  await readUntil(await send({ text: "after it", requestId: "mac-queued01" }, { stream: true, signal: queuedDrop.signal }), "status");
  queuedDrop.abort();
  assert.equal((await stateOf(["mac-queued01"]))["mac-queued01"], "queued");
  // The client comes back and replays both from its outbox.
  const again = [send({ text: "long job", requestId: "mac-active01" }), send({ text: "after it", requestId: "mac-queued01" })];
  await new Promise((resolve) => setTimeout(resolve, 30));
  model.open();
  const [first, second] = await Promise.all(again.map(async (r) => (await r).json()));
  assert.equal(first.reply, "Reply 1");
  assert.equal(second.reply, "Reply 2");
  assert.equal(calls.length, 2);
  assert.equal(userLines(runtime).length, 2);
});

test("a lost acknowledgement after main accepted the send never runs it twice", async (t) => {
  const model = gate();
  const { runtime, calls, send, stateOf, phone } = await mainApp(t, async () => { await model.opened; return reply("Handled."); });
  // The phone's request reached main but the client heard nothing back.
  const lost = new AbortController();
  const pending = send({ text: "book the room", requestId: "ios-lostack01" }, { as: phone, signal: lost.signal });
  await until(async () => (await stateOf(["ios-lostack01"], { as: phone }))["ios-lostack01"] === "running");
  lost.abort();
  await pending.catch(() => {});
  model.open();
  await until(async () => (await stateOf(["ios-lostack01"], { as: phone }))["ios-lostack01"] === "done");
  const replay = await (await send({ text: "book the room", requestId: "ios-lostack01" }, { as: phone })).json();
  assert.equal(replay.reply, "Handled.");
  assert.equal(replay.replayed, true);
  assert.equal(calls.length, 1);
  assert.equal(userLines(runtime).length, 1);
});

test("two intentional sends with the same words are two turns; one id with other words is refused", async (t) => {
  const { runtime, calls, send } = await mainApp(t, async (n) => reply(`Reply ${n}`));
  assert.equal((await (await send({ text: "yes", requestId: "mac-same0001" })).json()).reply, "Reply 1");
  assert.equal((await (await send({ text: "yes", requestId: "mac-same0002" })).json()).reply, "Reply 2");
  assert.equal((await (await send({ text: "yes", requestId: "mac-same0002" })).json()).replayed, true, "the same id again is a replay");
  const conflict = await send({ text: "no", requestId: "mac-same0002" });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, "request_id_conflict");
  assert.equal(calls.length, 2);
  assert.deepEqual(userLines(runtime).map((m) => m.content), ["yes", "yes"]);
});

test("receipts survive a main restart: done replays, running reads interrupted, queued is free to send once", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-outbox-restart-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const before = await mainApp(t, async () => reply("Before restart."), { dataDir, keep: true });
  assert.equal((await (await before.send({ text: "first", requestId: "mac-restart1" })).json()).reply, "Before restart.");
  await before.close();

  // What a main that stopped mid-turn leaves behind: one turn running (its
  // user line not yet stored), one still waiting behind it.
  const receipts = new TurnReceipts(path.join(dataDir, "message-turns.json"));
  receipts.accept(SESSION, "mac-restart2", turnFingerprint("second"));
  receipts.mark(SESSION, "mac-restart2", "running");
  receipts.accept(SESSION, "mac-restart3", turnFingerprint("third"));

  const after = await mainApp(t, async () => reply("After restart."), { dataDir, keep: true });
  assert.deepEqual(await after.stateOf(["mac-restart1", "mac-restart2", "mac-restart3"]),
    { "mac-restart1": "done", "mac-restart2": "interrupted", "mac-restart3": "unknown" });
  const replay = await (await after.send({ text: "first", requestId: "mac-restart1" })).json();
  assert.equal(replay.reply, "Before restart.");
  assert.equal(replay.replayed, true);
  const interrupted = await after.send({ text: "second", requestId: "mac-restart2" });
  assert.equal(interrupted.status, 500);
  assert.equal((await interrupted.json()).code, "interrupted");
  assert.equal(after.calls.length, 0, "neither ran again");
  assert.equal((await (await after.send({ text: "third", requestId: "mac-restart3" })).json()).reply, "After restart.");
  assert.equal((await (await after.send({ text: "third", requestId: "mac-restart3" })).json()).replayed, true);
  assert.equal(after.calls.length, 1, "the never-started send ran exactly once");
});

test("a send whose records rotated out is recognised by its receipt and never rerun", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-outbox-rotated-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const receipts = new TurnReceipts(path.join(dataDir, "message-turns.json"));
  receipts.accept(SESSION, "mac-rotated1", turnFingerprint("old"));
  receipts.mark(SESSION, "mac-rotated1", "done");
  const { calls, send, stateOf } = await mainApp(t, async () => reply("Should not run."), { dataDir, keep: true });
  assert.equal((await stateOf(["mac-rotated1"]))["mac-rotated1"], "done");
  const again = await send({ text: "old", requestId: "mac-rotated1" });
  assert.equal(again.status, 500);
  assert.equal((await again.json()).code, "already_handled");
  assert.equal(calls.length, 0);
});

test("the turns route is for the owner and paired phones, and validates its ids", async (t) => {
  const { turns, phone } = await mainApp(t, async () => reply("ok"));
  assert.equal((await turns(["ios-phone001"], { as: phone })).status, 200);
  const shape = (await turns(["ios-phone001"], { as: phone })).body;
  assert.deepEqual(shape, { thread: "supervisor", conversationId: "main", active: [], turns: [{ requestId: "ios-phone001", state: "unknown" }] });
  for (const ids of [["short"], ["has space1"], Array.from({ length: 51 }, (_, i) => `mac-many${String(i).padStart(4, "0")}`)]) {
    assert.equal((await turns(ids)).status, 400, `rejects ${ids.length} ids`);
  }
  assert.equal((await turns(["mac-anyone01"], { as: {} })).status, 401);
  assert.equal((await turns(["mac-anyone01"], { query: "&conversationId=nope" })).status, 400);
});
