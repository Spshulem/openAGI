import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FleetSupervisor } from "../src/fleet/supervisor.js";
import { createExecutor } from "../src/fleet/executor.js";
import { checkPaseoReceipt, confirmedPaseoTurn, deliverPaseo } from "../src/fleet/paseo-delivery.js";
import { paseoThread } from "../src/fleet/sources/paseo.js";
import { createFleetRoute } from "../src/fleet/routes.js";

// 2026-11-27, 14:20-14:27 UTC: the fleet computer's own GET /fleet/api/state
// and /fleet/api/workspaces answered only "Fleet supervisor error. Check the
// daemon log.", and the log had nothing: the route's catch-all swallowed the
// error. Every answer and dispatch that reads the state first failed the
// same way, before recording anything.

function captureErrors(t) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(" ")); };
  t.after(() => { console.error = original; });
  return lines;
}

const get = (route, p) => route("GET", p, new URL(`http://localhost${p}`), async () => ({}), {});
const post = (route, p, body) => route("POST", p, new URL(`http://localhost${p}`), async () => body, {});

test("a fleet route that throws is logged with its stack and answered with a ref and whether anything ran", async (t) => {
  const lines = captureErrors(t);
  const supervisor = {
    getState() { throw new TypeError("Cannot read properties of undefined (reading 'turnId') at /home/dev/secret/path"); },
    async answerQuestion() { throw new Error("must not be reached"); }
  };
  const route = createFleetRoute({ supervisor });
  const read = await get(route, "/fleet/api/state");
  assert.equal(read.status, 500);
  assert.notEqual(read.body.error, "Fleet supervisor error. Check the daemon log.");
  assert.match(read.body.error, /failed on GET \/fleet\/api\/state \(TypeError, ref fre_[0-9a-f]{8}\)\. Nothing was changed\./);
  assert.equal(read.body.ran, "no");
  assert.equal(read.body.errorClass, "TypeError");
  assert.doesNotMatch(read.body.error, /\/home\/dev/, "internals stay out of the reply");
  const logged = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((e) => e?.event === "fleet.route_error");
  assert.equal(logged.length, 1, "logged once, under the stable event name");
  assert.equal(logged[0].ref, read.body.errorRef, "the reply's ref finds the log line");
  assert.match(logged[0].message, /reading 'turnId'/);
  assert.match(logged[0].stack, /TypeError/);

  // An answer reads the state first: the card click of 2026-11-27.
  const write = await post(route, "/fleet/api/questions/fq_330571b7c42f4efb", { answer: "yes, write spec" });
  assert.equal(write.status, 500);
  assert.equal(write.body.ran, "unknown");
  assert.match(write.body.error, /may have partly run: check .* not retried automatically/);
});

function supervisorWith(t, { threads = [], runtime = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-state-degraded-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sup = new FleetSupervisor({
    dataDir: dir, runtime,
    config: { enabled: true, mode: "auto", paseo: { enabled: true, only: true } },
    deps: { now: () => Date.parse("2026-11-27T14:20:00Z"), executor: { async deliver() { throw new Error("must not send"); } } }
  });
  for (const thread of threads) sup.lastThreads.set(thread.key, thread);
  return sup;
}

// An Antigravity chat through Paseo, shaped like "Zero Shot App Redesign"
// (9dc6e44b): a plugin session id carrying JSON, plugin persistence, and a
// queued message whose turn has not started.
const antigravityAgent = {
  id: "9dc6e44b-5b92-463c-a9bf-caae3e3533ef", title: "Zero Shot App Redesign", provider: "antigravity", status: "idle",
  updatedAt: "2026-11-27T14:19:30Z", lastUserMessageAt: "2026-11-26T06:04:21.628Z", cwd: "/work/zeroshot", workspaceId: "ws_zs",
  runtimeInfo: { sessionId: 'plugin:{"version":1,"data":{"conversationId":"c-1","cascadeId":"x"}}' },
  persistence: { sessionId: 'plugin:{"version":1,"data":{"conversationId":"c-1"}}', metadata: { pluginProviderPersistence: { version: 1, data: { conversationId: "c-1" } } } }
};

test("one part of the state that cannot be built is left out and logged; the state still answers", async (t) => {
  const lines = captureErrors(t);
  const zs = paseoThread(antigravityAgent, "srv_bb");
  const sup = supervisorWith(t, {
    threads: [zs],
    runtime: { tasks: { blockingImpactFor() { throw new TypeError("tasks index is rebuilding"); } } }
  });
  sup.store.upsertQuestion({ dedupeKey: "ask:zs", kind: "agent-ask", threadKey: zs.key, title: "Zero Shot: ship 0.14?", body: "Ship it?", options: ["yes", "no"] });
  sup.store.recordSnapshot({ at: "2026-11-27T14:19:00Z", threads: [{ key: zs.key, kind: "paseo", title: zs.title, state: "idle-no-pr", agentStatus: "idle" }] });
  // The goal lookup a card makes throws too.
  sup.activeWork.findActiveGoalForThread = () => { throw new RangeError("Invalid time value"); };
  const state = sup.getState();
  assert.equal(state.questions.length, 1, "the question is still listed");
  assert.equal(state.questions[0].title, "Zero Shot: ship 0.14?");
  assert.ok(state.degraded.some((d) => d.part === "blocking-impact" && d.error === "TypeError"), JSON.stringify(state.degraded));
  assert.ok(state.degraded.every((d) => !/rebuilding/.test(JSON.stringify(d))), "no internals in the state");
  const logged = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((e) => e?.event === "fleet.state_degraded");
  assert.ok(logged.some((e) => e.part === "blocking-impact" && /rebuilding/.test(e.message) && /TypeError/.test(e.stack)));
  // Through the route too: 200, not the catch-all.
  const res = await get(createFleetRoute({ supervisor: sup }), "/fleet/api/state");
  assert.equal(res.status, 200);
});

test("an Antigravity plugin session id is read without throwing anywhere in the state", (t) => {
  const zs = paseoThread(antigravityAgent, "srv_bb");
  assert.ok(zs.meta.aliases.some((alias) => alias.startsWith("antigravity:plugin:")), "the alias carries the plugin JSON");
  const sup = supervisorWith(t, { threads: [zs] });
  sup.store.upsertQuestion({ dedupeKey: "ask:zs2", kind: "agent-ask", threadKey: zs.key, title: "Zero Shot?", body: "?", options: ["yes"] });
  sup.store.recordSnapshot({ at: "2026-11-27T14:19:00Z", threads: [{ key: zs.key, kind: "paseo", title: zs.title, state: "running", agentStatus: "running" }] });
  const state = sup.getState();
  assert.equal(state.degraded, undefined);
  assert.equal(state.cards.length, 1);
});

// The ACP host (Antigravity through Paseo) takes the message, shows it in the
// timeline at once, and starts its turn about 40 s later as
// "acp:<our message id>". The chat's lastUserMessageAt never moves.
test("a turn named after our own message id (acp:<id>) is that message's turn; another's is not", () => {
  const receipt = { messageId: "m-1", clientMessageId: "m-1" };
  const own = { item: { type: "user_message", messageId: "m-1" }, seqEnd: 1630 };
  assert.equal(confirmedPaseoTurn({ agent: { status: "running", activeTurn: { turnId: "acp:m-1" } }, entries: [own] }, receipt), true);
  assert.equal(confirmedPaseoTurn({ agent: { status: "idle" }, entries: [own, { item: { type: "assistant_message", text: "on it" }, turnId: "acp:m-1" }] }, receipt), true);
  assert.equal(confirmedPaseoTurn({ agent: { status: "running", activeTurn: { turnId: "acp:m-2" } }, entries: [own] }, receipt), false);
  assert.equal(confirmedPaseoTurn({ agent: { status: "idle" }, entries: [own] }, receipt), false, "queued, not started: not confirmed");
});

function acpChat(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-receipt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let agent = { ...antigravityAgent };
  const sent = [];
  // ~1,630 entries before ours; ours shows at once, with no turn.
  const history = Array.from({ length: 1630 }, (_, i) => ({ item: { type: i % 2 ? "assistant_message" : "user_message", text: `old ${i}` }, turnId: `t-${i >> 1}`, seqStart: i, seqEnd: i }));
  const ref = {
    refresh: async () => {},
    current: () => agent,
    send: async (text, options) => { sent.push({ text, options }); history.push({ item: { type: "user_message", messageId: options.messageId, text }, seqStart: 1630, seqEnd: 1630 }); },
    timeline: { refetch: async (options) => ({ agent, entries: options?.direction === "tail" ? history.slice(-(options.limit ?? 40)) : history.slice(-80) }) }
  };
  const client = { connect: async () => {}, close: async () => {}, hosts: { list: async () => ({ self: { serverId: "srv_bb" }, hosts: [] }) }, agents: { ref: () => ref } };
  const factory = () => client;
  const startTurn = () => { agent = { ...agent, status: "running", activeTurn: { turnId: `acp:${sent.at(-1).options.messageId}`, startedAt: "2026-11-27T14:26:45Z" } }; };
  return { dir, sent, factory, startTurn };
}

test("an Antigravity send whose turn starts late ends delivered once the turn starts, and is never sent again", async (t) => {
  const chat = acpChat(t);
  const sup = new FleetSupervisor({
    dataDir: chat.dir, runtime: { events: { emit() {} } },
    // A short Paseo request: the turn does not start inside it.
    config: { enabled: true, mode: "auto", paseo: { enabled: true, only: true, timeoutMs: 1500 } },
    deps: { now: () => Date.now() }
  });
  sup.deps.executor = createExecutor({ config: sup.config, store: sup.store, paseoDelivery: (args) => deliverPaseo({ ...args, factory: chat.factory }) });
  sup.deps.checkPaseoReceipt = (args) => checkPaseoReceipt({ ...args, factory: chat.factory });
  const thread = paseoThread(antigravityAgent, "srv_bb");
  sup.lastThreads.set(thread.key, thread);
  const text = "Run the idle-energy check on ZeroShot 0.14 and report.";
  const first = await sup.sendOwnerMessage(thread.key, text, { idempotencyKey: "approval-zs-1" });
  assert.equal(first.delivery.unconfirmed, true, "accepted, its turn not started yet");
  assert.equal(chat.sent.length, 1);
  assert.equal(sup.handoffs.get("approval-zs-1").status, "unconfirmed");
  // Nothing settles while the turn has not started.
  assert.deepEqual(await sup.settleUnconfirmedHandoffs(), []);
  // ~40 s later the host starts the turn, named after our message.
  chat.startTurn();
  assert.deepEqual(await sup.settleUnconfirmedHandoffs(), ["approval-zs-1"]);
  assert.equal(sup.handoffs.get("approval-zs-1").status, "delivered");
  assert.match(sup.handoffs.get("approval-zs-1").detail, /not sent again/);
  // The same approval again: already delivered, nothing sent.
  const again = await sup.sendOwnerMessage(thread.key, text, { idempotencyKey: "approval-zs-1" });
  assert.equal(again.delivery.status, "sent");
  assert.match(again.delivery.detail, /already delivered/);
  assert.equal(chat.sent.length, 1, "sent exactly once");
});

// Review fix (#393): a check of an older receipt that races a new send to
// the same chat never writes the old receipt over the new one.
test("checking a receipt never overwrites a newer send's receipt", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-receipt-race-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const thread = paseoThread(antigravityAgent, "srv_bb");
  const journal = path.join(dir, "paseo-deliveries");
  fs.mkdirSync(journal, { recursive: true });
  const file = path.join(journal, `${createHash("sha256").update(thread.key).digest("hex")}.json`);
  const old = { messageId: "m-old", clientMessageId: "m-old", messageHash: "h-old", pending: true, sentAt: "2026-11-27T14:20:00Z" };
  const newer = { messageId: "m-new", clientMessageId: "m-new", messageHash: "h-new", pending: true, sentAt: "2026-11-27T14:21:00Z" };
  fs.writeFileSync(file, JSON.stringify(old));
  const agent = { ...antigravityAgent, status: "running", activeTurn: { turnId: "acp:m-old" } };
  const ref = {
    current: () => agent,
    timeline: {
      refetch: async () => {
        // A new send replaces the journal while the old receipt is being read.
        fs.writeFileSync(file, JSON.stringify(newer));
        return { agent, entries: [{ item: { type: "user_message", messageId: "m-old" }, seqEnd: 1 }] };
      }
    }
  };
  const client = { connect: async () => {}, close: async () => {}, hosts: { list: async () => ({ self: { serverId: "srv_bb" }, hosts: [] }) }, agents: { ref: () => ref } };
  const result = await checkPaseoReceipt({ config: { paseo: { enabled: true } }, thread, store: { dir }, messageHash: "h-old", factory: () => client });
  assert.equal(result.confirmed, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), newer, "the newer receipt stands");
});

// Review fix (#393): with more unconfirmed handoffs than one scan checks,
// each scan checks the least recently checked, so none is starved.
test("unconfirmed handoffs are checked in turn, not always the newest few", async (t) => {
  const sup = supervisorWith(t);
  const checked = [];
  sup.deps.checkPaseoReceipt = async ({ thread }) => { checked.push(thread.key); return { confirmed: false }; };
  for (let i = 0; i < 7; i += 1) {
    const key = `paseo:srv_bb.chat_${i}`;
    sup.lastThreads.set(key, { key, kind: "paseo", id: `chat_${i}`, meta: { serverId: "srv_bb" } });
    sup.handoffs.enqueue({ key: `approval-${i}`, threadKey: key, message: `step ${i}`, reason: "unconfirmed", status: "unconfirmed" });
  }
  await sup.settleUnconfirmedHandoffs(null, { limit: 5 });
  await sup.settleUnconfirmedHandoffs(null, { limit: 5 });
  assert.equal(new Set(checked).size, 7, "every handoff was checked within two scans");
});
