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

// 14:20-14:27 both fleet computers (buildbot3 and the MacBook) failed /state
// and /workspaces at once; what they share is the Paseo daemon. Whatever
// Paseo does (throws, times out, returns a partial or malformed agent), the
// state and workspace routes answer 200 from what was last read, say which
// source failed, and log it.
function paseoFactory({ hostsThrow = null, agents = null } = {}) {
  const ok = { id: "agent_ok", title: "Recorder", status: "idle", provider: "claude", updatedAt: "2026-11-27T14:10:00Z", cwd: "/work/recorder", workspaceId: "ws_rec" };
  const list = agents ?? [ok];
  const api = {
    agents: {
      list: async () => ({ entries: list.map((agent) => ({ agent })), pageInfo: { hasMore: false } }),
      ref: (id) => {
        const agent = list.find((a) => a?.id === id) ?? { id, status: "idle" };
        return { current: () => agent, refresh: async () => ({ agent }), timeline: { refetch: async () => ({ agent, entries: [] }) } };
      }
    }
  };
  return () => ({
    ...api,
    connect: async () => {},
    close: async () => {},
    hosts: {
      list: async () => { if (hostsThrow) throw hostsThrow; return { self: { serverId: "srv_bb", label: "buildbot3" }, hosts: [] }; },
      client: async () => api
    }
  });
}

function scanningSupervisor(t, factory) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-paseo-down-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sup = new FleetSupervisor({
    dataDir: dir, runtime: { events: { emit() {} } }, forceMode: "observe",
    config: { enabled: true, mode: "observe", paseo: { enabled: true, only: true, timeoutMs: 2000 }, review: { enabled: false } },
    deps: {
      paseoFactory: factory, judge: null, decisionsGate: null,
      run: async () => ({ code: 1, stdout: "", stderr: "no commands in tests" }),
      executor: { async deliver() { throw new Error("must not send"); } },
      notifier: { notifyQuestion: async () => null, notify: async () => null }
    }
  });
  return sup;
}

const malformedAgents = [
  { ...antigravityAgent, status: "running", activeTurn: { turnId: "acp:45915736-0d13-4cf4-8d4f-b69110314095" } },
  { id: "agent_weird", title: { text: "not a string" }, status: 42, provider: null, updatedAt: "not a date", labels: "x",
    pendingPermissions: { not: "an array" }, activeTurn: "acp:string", persistence: { metadata: { asyncQuestions: [{ question: 5, options: "x" }, null] } },
    runtimeInfo: { sessionId: "plugin:{not json" } },
  null,
  { status: "idle" }
];

for (const [name, factory] of Object.entries({
  "Paseo throws": paseoFactory({ hostsThrow: new Error("Paseo request timed out") }),
  "Paseo returns malformed agents": paseoFactory({ agents: malformedAgents })
})) {
  test(`${name} during a scan, /state and /workspaces: 200 from the last read, the failed source named`, async (t) => {
    const lines = captureErrors(t);
    // A good scan first: what the routes fall back to.
    const sup = scanningSupervisor(t, paseoFactory());
    await sup.tick("first");
    assert.ok(sup.lastThreads.has("paseo:srv_bb.agent_ok"));
    sup.deps.paseoFactory = factory;
    sup.paseoSource = null;
    await sup.tick("second");
    const route = createFleetRoute({ supervisor: sup });
    const state = await get(route, "/fleet/api/state");
    assert.equal(state.status, 200, JSON.stringify(state.body.error ?? ""));
    assert.ok(sup.lastThreads.has("paseo:srv_bb.agent_ok") || name.includes("malformed"), "the last read stands when Paseo fails");
    const workspaces = await route("GET", "/fleet/api/workspaces", new URL("http://localhost/fleet/api/workspaces?limit=30"), async () => ({}), {});
    assert.equal(workspaces.status, 200, JSON.stringify(workspaces.body.error ?? ""));
    assert.ok(Array.isArray(workspaces.body.workspaces));
    if (name === "Paseo throws") {
      assert.match(state.body.snapshot.sourceErrors?.paseo ?? "", /timed out/, "the state names the failed source");
      assert.match(workspaces.body.sourceErrors?.paseo ?? "", /timed out/);
      const logged = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((e) => e?.event === "fleet.source_error");
      assert.ok(logged.some((e) => e.source === "paseo" && /timed out/.test(e.message)), "logged");
    }
  });
}

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
  const result = await checkPaseoReceipt({ config: { paseo: { enabled: true } }, thread, store: { dir }, messageHash: "h-old", messageId: "m-old", factory: () => client });
  assert.equal(result.confirmed, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), newer, "the newer receipt stands");
});

// Review fix (#393): the same words sent again under another approval are
// another send; their confirmed turn never settles the older approval.
test("a later send of the same text never settles an older unconfirmed approval", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-receipt-identity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const thread = paseoThread(antigravityAgent, "srv_bb");
  const journal = path.join(dir, "paseo-deliveries");
  fs.mkdirSync(journal, { recursive: true });
  const file = path.join(journal, `${createHash("sha256").update(thread.key).digest("hex")}.json`);
  // The third send, "continue" again, pending and about to be confirmed.
  fs.writeFileSync(file, JSON.stringify({ messageId: "m-3", clientMessageId: "m-3", messageHash: "h-continue", pending: true }));
  const agent = { ...antigravityAgent, status: "running", activeTurn: { turnId: "acp:m-3" } };
  const ref = { current: () => agent, timeline: { refetch: async () => ({ agent, entries: [{ item: { type: "user_message", messageId: "m-3" }, seqEnd: 1 }] }) } };
  const client = { connect: async () => {}, close: async () => {}, hosts: { list: async () => ({ self: { serverId: "srv_bb" }, hosts: [] }) }, agents: { ref: () => ref } };
  const sup = supervisorWith(t, { threads: [thread] });
  sup.deps.checkPaseoReceipt = (args) => checkPaseoReceipt({ ...args, factory: () => client });
  const { entry } = sup.handoffs.enqueue({ key: "approval-1", threadKey: thread.key, message: "continue", reason: "unconfirmed", status: "unconfirmed" });
  sup.handoffs.update(entry.key, { status: "unconfirmed", receiptMessageId: "m-1" });
  // Same text, same hash, different send.
  const direct = await checkPaseoReceipt({ config: { paseo: { enabled: true } }, thread, store: { dir }, messageHash: "h-continue", messageId: "m-1", factory: () => client });
  assert.equal(direct.confirmed, false);
  assert.deepEqual(await sup.settleUnconfirmedHandoffs(), []);
  assert.equal(sup.handoffs.get("approval-1").status, "unconfirmed");
});

// Review fix (#393): a stalled timeline read held the chat's send guard for
// Paseo's whole request timeout; the check is bounded end to end.
test("a receipt check whose timeline read stalls gives up within its bound and frees the chat", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-receipt-stall-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const thread = paseoThread(antigravityAgent, "srv_bb");
  const journal = path.join(dir, "paseo-deliveries");
  fs.mkdirSync(journal, { recursive: true });
  const file = path.join(journal, `${createHash("sha256").update(thread.key).digest("hex")}.json`);
  fs.writeFileSync(file, JSON.stringify({ messageId: "m-1", clientMessageId: "m-1", messageHash: "h-1", pending: true }));
  let stalled = true;
  const ref = { current: () => antigravityAgent, timeline: { refetch: () => (stalled ? new Promise(() => {}) : Promise.resolve({ agent: antigravityAgent, entries: [] })) } };
  const client = { connect: async () => {}, close: async () => {}, hosts: { list: async () => ({ self: { serverId: "srv_bb" }, hosts: [] }) }, agents: { ref: () => ref } };
  const args = { config: { paseo: { enabled: true } }, thread, store: { dir }, messageHash: "h-1", messageId: "m-1", factory: () => client, timeoutMs: 300 };
  const started = Date.now();
  const result = await checkPaseoReceipt(args);
  assert.equal(result.confirmed, false);
  assert.ok(Date.now() - started < 3000, `bounded (${Date.now() - started} ms)`);
  stalled = false;
  const next = await checkPaseoReceipt(args);
  assert.notEqual(next.detail, "a send to this chat is in progress", "the chat's guard was released");
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
    sup.handoffs.update(`approval-${i}`, { receiptMessageId: `m-${i}` });
  }
  await sup.settleUnconfirmedHandoffs(null, { limit: 5 });
  await sup.settleUnconfirmedHandoffs(null, { limit: 5 });
  assert.equal(new Set(checked).size, 7, "every handoff was checked within two scans");
});

// Review fix (#393): an approved handoff that queued behind a running turn
// and was then sent unconfirmed by the drain kept no receipt identity, so it
// could never settle.
test("a queued approval sent unconfirmed by the drain settles once its exact turn starts", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drain-receipt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let busy = true;
  const sent = [];
  const sup = new FleetSupervisor({
    dataDir: dir, runtime: { events: { emit() {} } },
    config: { enabled: true, mode: "auto", paseo: { enabled: true, only: true } },
    deps: {
      now: () => Date.now(),
      executor: {
        async deliver(opts) {
          if (busy && opts.queue) return { status: "busy", busy: true, route: "paseo-send", detail: "mid-turn" };
          sent.push(opts);
          return { status: "blocked", unconfirmed: true, route: "paseo-send", messageId: "exact-send-id", detail: "turn start unconfirmed" };
        }
      }
    }
  });
  const thread = { key: "paseo:srv_bb.chat_q", kind: "paseo", id: "chat_q", title: "Queued", agentStatus: "running", archived: false, meta: { serverId: "srv_bb" } };
  sup.lastThreads.set(thread.key, thread);
  const queued = await sup.sendOwnerMessage(thread.key, "Ship the fix after the tests pass.", { idempotencyKey: "approval-q" });
  assert.equal(queued.delivery.status, "queued");
  busy = false;
  const idle = { ...thread, agentStatus: "idle" };
  sup.lastThreads.set(idle.key, idle);
  const drained = await sup.drainQueuedOwnerMessages({ byKey: new Map([[idle.key, idle]]) });
  assert.equal(drained[0].status, "unconfirmed");
  assert.equal(sup.handoffs.get("approval-q").status, "unconfirmed");
  assert.equal(sup.handoffs.get("approval-q").receiptMessageId, "exact-send-id");
  const checks = [];
  sup.deps.checkPaseoReceipt = async ({ messageId }) => { checks.push(messageId); return { confirmed: messageId === "exact-send-id" }; };
  assert.deepEqual(await sup.settleUnconfirmedHandoffs(), ["approval-q"]);
  assert.deepEqual(checks, ["exact-send-id"]);
  assert.equal(sup.handoffs.get("approval-q").status, "delivered");
  assert.equal(sent.length, 1, "sent once");
});
