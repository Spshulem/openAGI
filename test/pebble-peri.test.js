// Pebble Index 01 → Peri: opt-in signed v1 multipart per ring, Double click &
// hold only, untrusted device input into a private phone chat, explicit saves
// only. Spec: https://developer.repebble.com/index-01/webhooks/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { PassThrough } from "node:stream";
import { PebblePeriReceiver, classifyPebbleIntent, PEBBLE_PERI_MAX_TRANSCRIPT_CHARS } from "../src/integrations/pebble-peri.js";
import { createCompanionRoutes, pebbleTransportSecure } from "../src/companion-routes.js";
import { isPublicRoute } from "../src/auth.js";
import { InMemoryAgentStore } from "../src/agent-store.js";
import { AgentHost } from "../src/agent-host.js";
import { createDefaultRuntime } from "../src/abi-runtime.js";
import { sharedConversations, sharedThreadHistory } from "../src/shared-conversations.js";
import { SessionMiner } from "../src/session-miner.js";
import { isSavedMemory } from "../src/memory-system.js";

const ORIGIN = "https://agent.example.test";

function harness(t, { memory = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pebble-peri-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new InMemoryAgentStore();
  const turns = [], memories = [];
  const agentHost = {
    store,
    async handleMessage(input, options) {
      turns.push({ input, options });
      store.appendMessage(input.sessionId, { role: "user", content: input.text, metadata: input.metadata });
      store.appendMessage(input.sessionId, { role: "assistant", content: "fixture reply", metadata: { thread: "agent" } });
      return { reply: "fixture reply" };
    }
  };
  const runtime = memory ? { memory: { remember(item, context) { memories.push({ item, context }); return { id: "memory-fixture" }; } } } : {};
  let clock = Date.parse("2026-11-23T12:00:00Z");
  const receiver = new PebblePeriReceiver({ dir, runtime, getAgentHost: () => agentHost, now: () => clock });
  const { device, secret } = receiver.provision({ label: "Fixture ring" }, ORIGIN);
  const notes = () => receiver.notes();
  const chat = () => store.getSession(`devices:agent:${device.conversationId}`).messages;
  return { dir, store, runtime, agentHost, receiver, device, secret, turns, memories, notes, chat,
    advance(ms) { clock += ms; }, now: () => clock };
}

let deliveries = 0;
async function signed(h, { text = "What is on my calendar tomorrow?", trigger = "double-click-hold", test: isTest = false,
  delivery = `0f8fad5b-d9cb-469f-a165-${String(70867 + deliveries++).padStart(12, "0")}`, secret = h.secret, extra = null, omit = [], timestamp = null } = {}) {
  const form = new FormData();
  if (!omit.includes("transcription")) form.set("transcription", isTest ? "This is a test event from Index 01." : text);
  form.set("recordedAt", String(h.now())); form.set("client", "ring");
  if (isTest) form.set("test", "true");
  if (extra) extra(form);
  const response = new Response(form);
  const raw = Buffer.from(await response.arrayBuffer());
  const ts = timestamp ?? String(Math.floor(h.now() / 1000));
  const headers = { "content-type": response.headers.get("content-type"), "x-index-webhook-version": "1", "x-index-timestamp": ts,
    "x-index-delivery": delivery, "x-index-trigger": isTest ? "test-event" : trigger, ...(isTest ? { "x-index-test": "true" } : {}) };
  const prefix = `v1\n${ts}\n${delivery}\n${headers["x-index-trigger"]}\n${isTest ? "1" : "0"}\n`;
  headers["x-index-signature"] = createHmac("sha256", secret).update(prefix).update(raw).digest("hex");
  return { headers, raw, delivery };
}

async function deliver(h, request, deviceId = h.device.id) {
  const result = await h.receiver.handle(deviceId, request.headers, request.raw);
  await h.receiver.idle();
  return result;
}

test("only the two documented gestures plus the test event are accepted; no triple-click", async t => {
  const h = harness(t);
  for (const trigger of ["triple-click-hold", "triple-click", "single-click", ""]) {
    const result = await deliver(h, await signed(h, { trigger }));
    assert.equal(result.status, 400, trigger);
  }
  assert.equal(h.turns.length, 0);
});

test("Double click & hold reaches the private phone chat as untrusted input with no tools and no implicit save", async t => {
  const h = harness(t);
  const result = await deliver(h, await signed(h, { text: "Remind me to buy fixture batteries" }));
  assert.equal(result.status, 202);
  assert.deepEqual(result.body, { accepted: true }, "the transcript is never echoed back");
  assert.equal(h.turns.length, 1);
  const { input, options } = h.turns[0];
  assert.equal(input.sessionId, `devices:agent:${h.device.conversationId}`);
  assert.equal(input.metadata.thread, "agent");
  assert.equal(input.metadata.untrustedInput, true);
  assert.equal(input.metadata.sourceName, "Fixture ring");
  assert.equal(input.routeTo, false);
  assert.equal(options.principal, null, "a signature is not owner presence");
  assert.deepEqual(options.toolAllowlist, []);
  assert.equal(options.implicitCapture, false);
  assert.match(options.extraTurnContext, /untrusted device input/);
  assert.equal(h.memories.length, 0); assert.equal(h.notes().length, 0);
});

test("Hold & talk is verified and dropped so it stays in Pebble notes", async t => {
  const h = harness(t);
  const result = await deliver(h, await signed(h, { trigger: "single-click-hold", text: "keep this note: fixture" }));
  assert.equal(result.status, 200); assert.equal(result.body.ignored, true);
  assert.equal(h.turns.length, 0); assert.equal(h.notes().length, 0); assert.equal(h.chat().length, 0);
  assert.equal(h.receiver.status(ORIGIN).devices[0].ignoredHoldAndTalk, 1);
});

test("a signed test event verifies and touches no chat, memory, notes or tasks", async t => {
  const h = harness(t);
  const result = await deliver(h, await signed(h, { test: true }));
  assert.deepEqual(result, { status: 200, body: { ok: true, test: true } });
  assert.equal(h.turns.length, 0); assert.equal(h.memories.length, 0); assert.equal(h.notes().length, 0); assert.equal(h.chat().length, 0);
  assert.ok(h.receiver.status(ORIGIN).devices[0].lastTestAt);
  // A test flag that disagrees with the trigger is rejected.
  const mixed = await signed(h, { test: true });
  mixed.headers["x-index-trigger"] = "double-click-hold";
  assert.equal((await deliver(h, mixed)).status, 400);
});

test("duplicates and concurrent retries run one turn, including after a restart", async t => {
  const h = harness(t);
  const request = await signed(h);
  const both = await Promise.all([h.receiver.handle(h.device.id, request.headers, request.raw), h.receiver.handle(h.device.id, request.headers, request.raw)]);
  await h.receiver.idle();
  assert.equal(both.filter(r => r.status === 202).length, 2, "concurrent duplicates share one result");
  assert.equal(h.turns.length, 1);
  const restarted = new PebblePeriReceiver({ dir: h.dir, runtime: h.runtime, getAgentHost: () => h.agentHost, now: h.now });
  assert.deepEqual(await restarted.handle(h.device.id, request.headers, request.raw), { status: 200, body: { duplicate: true } });
  await restarted.idle();
  assert.equal(h.turns.length, 1);
});

test("tampered, stale, unsigned, wrong-version, wrong-device and other-device secrets fail before any side effect", async t => {
  const h = harness(t);
  const other = h.receiver.provision({ label: "Second ring" }, ORIGIN);
  const good = await signed(h);
  const cases = [
    [{ ...good, headers: { ...good.headers, "x-index-signature": "0".repeat(64) } }, 401],
    [{ ...good, headers: { ...good.headers, "x-index-signature": undefined } }, 401],
    [{ ...good, headers: { ...good.headers, "x-index-signature": good.headers["x-index-signature"].toUpperCase() } }, 401],
    [{ ...good, raw: Buffer.concat([good.raw, Buffer.from("x")]) }, 401],
    [{ ...good, headers: { ...good.headers, "x-index-webhook-version": "2" } }, 400],
    [{ ...good, headers: { ...good.headers, "x-index-timestamp": "soon" } }, 400],
    [{ ...good, headers: { ...good.headers, "x-index-delivery": "../../escape" } }, 400],
    [await signed(h, { timestamp: String(Math.floor(h.now() / 1000) - 301) }), 401],
    [await signed(h, { timestamp: String(Math.floor(h.now() / 1000) + 301) }), 401],
    [await signed(h, { secret: other.secret }), 401]
  ];
  for (const [request, status] of cases) assert.equal((await deliver(h, request)).status, status);
  assert.equal((await deliver(h, good, "0".repeat(32))).status, 401, "unknown device");
  assert.equal((await deliver(h, await signed(h, { secret: h.secret }), other.device.id)).status, 401, "each ring has its own secret");
  h.receiver.revoke(h.device.id);
  assert.equal((await deliver(h, good)).status, 401, "a revoked ring is refused");
  assert.equal(h.turns.length, 0); assert.equal(h.memories.length, 0); assert.equal(h.notes().length, 0);
});

test("payload limits: transcription only, bounded size, no unknown or repeated fields", async t => {
  const h = harness(t);
  const audio = await signed(h, { extra: form => form.set("audio", new Blob(["fixture"], { type: "audio/mp4" }), "fixture.m4a") });
  assert.equal((await deliver(h, audio)).status, 422);
  assert.equal((await deliver(h, await signed(h, { text: "x".repeat(PEBBLE_PERI_MAX_TRANSCRIPT_CHARS + 1) }))).status, 413);
  assert.equal((await deliver(h, await signed(h, { omit: ["transcription"] }))).status, 422);
  assert.equal((await deliver(h, await signed(h, { extra: form => form.set("note", "smuggled") }))).status, 400);
  assert.equal((await deliver(h, await signed(h, { extra: form => form.append("transcription", "second") }))).status, 400);
  const json = await signed(h); json.headers["content-type"] = "application/json";
  assert.equal((await deliver(h, json)).status, 415, "multipart only");
  assert.equal((await h.receiver.handle(h.device.id, (await signed(h)).headers, Buffer.alloc(65 * 1024))).status, 413);
  assert.equal(h.turns.length, 0);
});

test("the x-audio-size header alone is refused on a correctly signed request", async t => {
  const h = harness(t);
  const request = await signed(h);
  request.headers["x-audio-size"] = "1024";
  // Headers are not part of the HMAC, so the signature still verifies.
  const result = await deliver(h, request);
  assert.equal(result.status, 422);
  assert.equal(h.turns.length, 0);
});

test("'keep this note' saves a private note only; 'remember this' saves to private memory only", async t => {
  const h = harness(t);
  assert.equal((await deliver(h, await signed(h, { text: "Keep this note. Parking is on level 3." }))).status, 202);
  assert.deepEqual(h.notes().map(n => n.text), ["Parking is on level 3."]);
  assert.equal(h.memories.length, 0); assert.equal(h.turns.length, 0, "a save is deterministic, not a model turn");
  assert.match(h.chat().at(-1).content, /private Pebble note/);
  assert.equal((await deliver(h, await signed(h, { text: "Peri, remember this: the fixture gate code is 4412" }))).status, 202);
  assert.equal(h.memories.length, 1);
  assert.equal(h.memories[0].item.content, "the fixture gate code is 4412");
  assert.equal(h.memories[0].item.metadata.untrustedInput, true);
  assert.equal(isSavedMemory(h.memories[0].item), true, "shown as a saved fact, exempt from automated cleanup");
  assert.equal(h.notes().length, 1); assert.equal(h.turns.length, 0);
  assert.match(h.chat().at(-1).content, /private memory/);
});

test("'remember this' without a memory system says nothing was saved", async t => {
  const h = harness(t, { memory: false });
  await deliver(h, await signed(h, { text: "remember this: fixture" }));
  assert.match(h.chat().at(-1).content, /nothing was saved/);
});

test("ambiguous save requests save nothing and say how to save", async t => {
  const h = harness(t);
  for (const text of ["Can you remember this for me?", "remember this", "Don't keep this note", "keep this note remember this fixture"]) {
    await deliver(h, await signed(h, { text }));
  }
  assert.equal(h.memories.length, 0); assert.equal(h.notes().length, 0); assert.equal(h.turns.length, 0);
  assert.match(h.chat().at(-1).content, /Nothing was saved/);
});

test("intent classification is strict and leading-only", () => {
  assert.deepEqual(classifyPebbleIntent("Keep this note: buy milk"), { kind: "note", body: "buy milk" });
  assert.deepEqual(classifyPebbleIntent("hey peri, keep this as a note - call mom"), { kind: "note", body: "call mom" });
  assert.deepEqual(classifyPebbleIntent("Remember this. Fixture"), { kind: "memory", body: "Fixture" });
  assert.equal(classifyPebbleIntent("Do you remember that place?").kind, "chat");
  assert.equal(classifyPebbleIntent("Remind me to call mom").kind, "chat");
  assert.equal(classifyPebbleIntent("I said keep this note earlier").kind, "ambiguous");
  assert.equal(classifyPebbleIntent("save this").kind, "ambiguous");
});

test("nothing logs the transcript, secret or signature", async t => {
  const h = harness(t);
  const logged = [];
  const originals = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originals[level] = console[level];
    console[level] = (...args) => logged.push(args.map(String).join(" "));
  }
  t.after(() => Object.assign(console, originals));
  const text = "keep this note: fixture-private-phrase";
  const request = await signed(h, { text });
  await deliver(h, request);
  await deliver(h, { ...request, raw: Buffer.concat([request.raw, Buffer.from("x")]) });
  await deliver(h, await signed(h, { text: "fixture-private-question" }));
  const all = logged.join("\n");
  for (const secretish of ["fixture-private", h.secret, request.headers["x-index-signature"]]) assert.ok(!all.includes(secretish));
});

test("the dedicated chat is a named Agent conversation (not main, so G2 cannot read it) with the ring's title", async t => {
  const h = harness(t);
  await deliver(h, await signed(h, { text: "keep this note: fixture" }));
  assert.notEqual(h.device.conversationId, "main");
  const listed = sharedConversations(h.store).conversations.find(c => c.id === h.device.conversationId);
  assert.equal(listed.thread, "agent"); assert.equal(listed.title, "Fixture ring");
  const history = sharedThreadHistory(h.store, "agent", { conversationId: h.device.conversationId });
  assert.equal(history.messages[0].sourceName, "Fixture ring");
});

test("provisioned secrets are 32 random bytes, shown once, never in status, and stored owner-only", async t => {
  const h = harness(t);
  assert.match(h.secret, /^[0-9a-f]{64}$/);
  const status = JSON.stringify(h.receiver.status(ORIGIN));
  assert.ok(!status.includes(h.secret));
  assert.equal(h.receiver.status(ORIGIN).devices[0].url, `${ORIGIN}/webhooks/pebble/peri/${h.device.id}`);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(h.dir, "peri-devices.json")).mode & 0o777, 0o600);
  const rotated = h.receiver.rotate(h.device.id, ORIGIN);
  assert.notEqual(rotated.secret, h.secret);
  assert.equal((await deliver(h, await signed(h))).status, 401, "the old secret stops working after rotation");
});

// ---- Routes -----------------------------------------------------------------

function fakeReq({ method = "POST", url, headers = {}, body = Buffer.alloc(0), encrypted = false, remoteAddress = "127.0.0.1" }) {
  const req = new PassThrough();
  Object.assign(req, { method, url, headers, socket: { encrypted, remoteAddress } });
  req.end(body);
  return req;
}
function fakeRes() {
  const res = { status: null, headers: {}, body: null, setHeader(k, v) { this.headers[k] = v; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(data) { this.body = data ? JSON.parse(String(data)) : null; } };
  return res;
}

test("HTTPS is required for the webhook and for provisioning", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pebble-peri-routes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let origin = "http://127.0.0.1:4100";
  const store = new InMemoryAgentStore();
  const routes = createCompanionRoutes({ runtime: { agentHost: { store } }, dataDir: dir, getChannels: () => null, getOrigin: () => origin, env: {} });
  const call = async (opts) => { const res = fakeRes(); const handled = await routes(fakeReq(opts), res, new URL(opts.url, "http://x")); return { handled, ...res }; };
  const created = await call({ url: "/pebble/peri/devices", headers: { "content-type": "application/json" }, body: Buffer.from("{}") });
  assert.equal(created.status, 409);
  origin = ORIGIN;
  const ok = await call({ url: "/pebble/peri/devices", headers: { "content-type": "application/json" }, body: Buffer.from('{"label":"Route ring"}') });
  assert.equal(ok.status, 201); assert.match(ok.body.secret, /^[0-9a-f]{64}$/);
  const listed = await call({ method: "GET", url: "/pebble/peri/devices" });
  assert.ok(!JSON.stringify(listed.body).includes(ok.body.secret));
  const hook = `/webhooks/pebble/peri/${ok.body.device.id}`;
  assert.equal((await call({ url: hook, remoteAddress: "203.0.113.9" })).status, 403, "plain http from the network");
  assert.equal((await call({ url: hook, headers: { "x-forwarded-proto": "http" } })).status, 403, "a proxy reporting plain http");
  assert.equal((await call({ url: hook, headers: { "content-length": String(1024 * 1024) } })).status, 413);
  assert.equal((await call({ method: "GET", url: hook })).status, 405);
  const unsigned = await call({ url: hook, headers: { "x-forwarded-proto": "https", "x-index-webhook-version": "1", "x-index-timestamp": "1", "x-index-delivery": "fixture-delivery", "x-index-trigger": "double-click-hold" } });
  assert.equal(unsigned.status, 401);
  assert.equal(isPublicRoute(hook), true);
  assert.equal(isPublicRoute("/pebble/peri/devices"), false, "provisioning is owner-only");
  assert.equal(isPublicRoute("/pebble/peri/notes"), false, "notes are owner-only");
  assert.equal(pebbleTransportSecure({ headers: {}, socket: { encrypted: true, remoteAddress: "203.0.113.9" } }, ORIGIN), true);
  assert.equal(pebbleTransportSecure({ headers: {}, socket: { encrypted: true } }, "http://x.test"), false);
});

// ---- Agent host: implicitCapture: false ----------------------------------------

test("a no-capture turn makes no auto-task, signal memory, turn memory, outcome or specialist", async () => {
  const tasks = [], memories = [], outcomes = [], signalOptions = [];
  const runtime = {
    tools: { toOpenAITools: () => [{ name: "remember" }, { name: "fleet_click" }] },
    tasks: { add: (task) => { tasks.push(task); return { id: "t" }; } },
    memory: { remember: (item) => { memories.push(item); return { id: "m" }; } },
    outcomes: { record: (o) => { outcomes.push(o); return { id: "o", kind: "agent-reply" }; } },
    processSignal: (signal, options) => { signalOptions.push(options); return { id: "out", scrutiny: { action: "act", score: 0.6, reasons: [], dimensions: { novelty: 0.3, risk: 0.3, repetition: 0.3 } }, customContext: [], propagation: {} }; }
  };
  const requests = [];
  const store = new InMemoryAgentStore();
  const host = new AgentHost({ store, runtime, modelProvider: { isConfigured: () => true, model: "stub",
    generate: async (request) => { requests.push(request); return { text: "ok", provider: "stub", model: "stub", toolCalls: [] }; } } });
  host.messageToSignal = async ({ text }) => ({ id: "sig", summary: text, content: text, tags: [] });
  await host.handleMessage({ text: "Remind me to buy fixture batteries", sessionId: "devices:agent:fixture", channel: "pebble", from: "pebble:fixture", routeTo: false },
    { principal: null, toolAllowlist: [], implicitCapture: false, extraTurnContext: "Pebble fixture context" });
  assert.equal(tasks.length, 0); assert.equal(memories.length, 0); assert.equal(outcomes.length, 0);
  assert.equal(signalOptions[0].memoryWrite, false); assert.equal(signalOptions[0].allowPropagation, false);
  assert.deepEqual(requests[0].tools ?? [], []);
  assert.equal(requests[0].context?.__owner, undefined);
  // The same turn without the option still captures as before.
  await host.handleMessage({ text: "Remind me to buy fixture batteries", sessionId: "owner-chat", routeTo: false }, {});
  assert.equal(tasks.length, 1); assert.equal(memories.length, 1);
});

test("processSignal honors memoryWrite: false", () => {
  const runtime = createDefaultRuntime({ scrutiny: { evaluate: () => ({ action: "act", score: 0.8, propagationPressure: 0, dimensions: { risk: 0.2, novelty: 0.3, repetition: 0.2 }, reasons: ["stub"] }) } });
  const shape = { source: "test", type: "message", domain: "general", taskType: "chat", summary: "fixture", content: "fixture body", tags: [], risk: 0.2, novelty: 0.3, repetition: 0.2 };
  assert.equal(runtime.processSignal({ id: "sig_nc", ...shape }, { memoryWrite: false, allowPropagation: false }).memory, null);
  assert.ok(runtime.processSignal({ id: "sig_c", ...shape }).memory);
});

test("a recording that arrives while the chat host is down is refused retryably, then accepted on retry", async t => {
  const h = harness(t);
  const request = await signed(h, { text: "keep this note: fixture while down" });
  let up = false;
  h.receiver.getAgentHost = () => (up ? h.agentHost : null);
  assert.deepEqual(await deliver(h, request), { status: 503, body: { error: "chat_unavailable" } });
  assert.equal(h.notes().length, 0);
  up = true;
  assert.equal((await deliver(h, request)).status, 202, "the same delivery is not treated as a duplicate");
  assert.deepEqual(h.notes().map(n => n.text), ["fixture while down"]);
});

test("ring messages are stored as noCapture and the skill miner skips them", async t => {
  const h = harness(t);
  for (const text of ["keep this note: weekly fixture report", "keep this note: weekly fixture report again"]) await deliver(h, await signed(h, { text }));
  assert.ok(h.chat().filter(m => m.role === "user").every(m => m.metadata.noCapture === true));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pebble-peri-miner-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new InMemoryAgentStore();
  const say = (id, text, metadata) => store.appendMessage(id, { role: "user", content: text, metadata });
  for (const id of ["a", "b", "c"]) say(`devices:agent:${id}`, "send me the weekly fixture revenue report", { noCapture: true });
  const miner = new SessionMiner({ runtime: { agentHost: { store } }, dataDir, minOccurrences: 3 });
  assert.deepEqual(await miner.mine(), { skipped: true, reason: "insufficient user messages" });
  for (const id of ["d", "e", "f"]) say(id, "send me the weekly fixture revenue report", {});
  assert.equal((await miner.mine()).mined, 3, "ordinary owner turns are still mined");
});

test("AgentHost stamps noCapture on the stored user message of a no-capture turn only", async () => {
  const runtime = { memory: { remember: () => ({ id: "m" }) },
    processSignal: () => ({ id: "out", scrutiny: { action: "act", score: 0.6, reasons: [], dimensions: { novelty: 0.3, risk: 0.3, repetition: 0.3 } }, customContext: [], propagation: {} }) };
  const store = new InMemoryAgentStore();
  const host = new AgentHost({ store, runtime, modelProvider: { isConfigured: () => true, model: "stub",
    generate: async () => ({ text: "ok", provider: "stub", model: "stub", toolCalls: [] }) } });
  host.messageToSignal = async ({ text }) => ({ id: "sig", summary: text, content: text, tags: [] });
  await host.handleMessage({ text: "fixture ring", sessionId: "ring", routeTo: false }, { implicitCapture: false, toolAllowlist: [] });
  await host.handleMessage({ text: "fixture owner", sessionId: "owner", routeTo: false }, {});
  assert.equal(store.getSession("ring").messages[0].metadata.noCapture, true);
  assert.equal(store.getSession("owner").messages[0].metadata.noCapture, undefined);
});

test("a save recording waits for a turn already running in the ring's chat", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pebble-peri-order-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const runtime = { memory: { remember: () => ({ id: "m" }) },
    processSignal: () => ({ id: "out", scrutiny: { action: "act", score: 0.6, reasons: [], dimensions: { novelty: 0.3, risk: 0.3, repetition: 0.3 } }, customContext: [], propagation: {} }) };
  const store = new InMemoryAgentStore();
  const host = new AgentHost({ store, runtime, modelProvider: { isConfigured: () => true, model: "stub",
    generate: async () => { await gate; return { text: "fixture answer", provider: "stub", model: "stub", toolCalls: [] }; } } });
  host.messageToSignal = async ({ text }) => ({ id: "sig", summary: text, content: text, tags: [] });
  let clock = Date.parse("2026-11-23T12:00:00Z");
  const receiver = new PebblePeriReceiver({ dir, runtime, getAgentHost: () => host, now: () => clock });
  const { device, secret } = receiver.provision({ label: "Order ring" }, ORIGIN);
  const h = { receiver, device, secret, now: () => clock };
  assert.equal((await h.receiver.handle(device.id, ...Object.values(await signed(h, { text: "What is the fixture question?" })).slice(0, 2))).status, 202);
  assert.equal((await h.receiver.handle(device.id, ...Object.values(await signed(h, { text: "keep this note: fixture order" })).slice(0, 2))).status, 202);
  await new Promise(resolve => setTimeout(resolve, 20));
  release();
  await receiver.idle();
  const lines = store.getSession(`devices:agent:${device.conversationId}`).messages.map(m => `${m.role}:${m.content}`);
  assert.deepEqual(lines, ["user:What is the fixture question?", "assistant:fixture answer",
    "user:keep this note: fixture order", "assistant:Kept as a private Pebble note."]);
});
