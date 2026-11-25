import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { DEFAULTS, SUPERVISOR_PREFIX, resolveFleetConfig, shortHash } from "../src/fleet/contracts.js";
import { FleetSupervisor } from "../src/fleet/supervisor.js";
import { HANDOFF_TTL_MS } from "../src/fleet/handoff-queue.js";
import { createFleetCapability, RemoteFleetSupervisor } from "../src/fleet/remote.js";
import { registerFleetTools } from "../src/fleet/tools.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { PendingActionStore } from "../src/pending-actions.js";
import { executeApprovedAction } from "../src/approval-executor.js";
import { deliverPaseo } from "../src/fleet/paseo-delivery.js";
import { paseoThread } from "../src/fleet/sources/paseo.js";

// Incident tw_d9544149a037e8c1, 2026-11-23: the owner approved the BB
// Recorder App Review handoff twice (codes 95, then 77) to Paseo
// srv_6csfaHcKvC-A, chat 375e1a66. Both sends came back "Paseo host
// unavailable" (receipts fa_e02f7ffa 15:45:35Z, fa_a821cb09 15:48:00Z) and
// were dropped: nothing held them, nothing resent them when the host came
// back, and the only way forward was asking the owner to approve again.
const MIN = 60_000;
const T0 = Date.parse("2026-11-23T15:45:00.000Z");
const KEY = "paseo:srv_mac.375e1a66";
const OTHER = "paseo:srv_mac.otherchat";
const HOST_DOWN = "Paseo delivery unavailable or uncertain: Paseo host unavailable; no provider fallback or automatic resend";

function makeThread(key, overrides = {}) {
  const id = key.split(".").at(-1);
  return {
    key, kind: "paseo", id, title: "Recorder release", cwd: null, repo: null, branch: null, workspace: "bb-recorder",
    agentStatus: "idle", lastActivityAt: new Date(T0 - 60 * MIN).toISOString(), lastAgentText: "Ready.", lastAgentAt: new Date(T0 - 60 * MIN).toISOString(),
    lastUserText: "[OpenAGI supervisor] continue", lastUserAt: new Date(T0 - 90 * MIN).toISOString(), error: null, openTasks: [], prRefs: [],
    live: null, writerLocked: false, archived: false, excluded: null, meta: { serverId: "srv_mac", historyKnown: true }, ...overrides
  };
}

function fixture(t, { dataDir = null, threads = null } = {}) {
  const dir = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "fleet-handoff-"));
  if (!dataDir) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = { value: T0 };
  const host = { up: false, unconfirmed: false, permission: false, onDeliver: null };
  const delivered = [];
  const list = threads ?? [makeThread(KEY), makeThread(OTHER)];
  const executor = {
    deliver: async (args) => {
      if (host.onDeliver) await host.onDeliver(args);
      if (host.up && host.permission && args.noPermissionReply) return { status: "blocked", route: args.route, detail: "Paseo chat has a pending permission prompt; a held handoff is never sent into it" };
      delivered.push({ key: args.thread.key, message: args.message, noPermissionReply: args.noPermissionReply === true });
      if (!host.up) return { status: "blocked", route: args.route, detail: HOST_DOWN, actionId: `fa_${delivered.length}` };
      if (host.unconfirmed) return { status: "blocked", unconfirmed: true, route: args.route, detail: "Message accepted by Paseo; turn start unconfirmed. No automatic resend.", actionId: `fa_${delivered.length}` };
      return { status: "sent", route: args.route, detail: "Paseo message and turn confirmed", actionId: `fa_${delivered.length}` };
    },
    inFlight: () => [], whenIdle: async () => {}
  };
  const config = resolveFleetConfig({ OPENAGI_FLEET_STORAGE: "0", OPENAGI_FLEET_PASEO: "1", OPENAGI_FLEET_PASEO_ONLY: "1" }, { home: dir, mode: "observe", limits: { ...DEFAULTS }, managerRef: "none" });
  const supervisor = new FleetSupervisor({ dataDir: dir, config, deps: {
    now: () => now.value, executor,
    notifier: { notifyQuestion: async () => ({ outreachId: null, pushed: false, skipped: "push-off" }) },
    listPaseoThreads: async () => list,
    findPrForBranch: async () => null, fetchPrStates: async () => new Map(), fetchPrStateLite: async () => new Map()
  } });
  supervisor._uiDriver = { readiness: async () => ({ ready: false }) };
  return { supervisor, delivered, host, now, dir, list };
}

const sends = (delivered, key = KEY) => delivered.filter((d) => d.key === key);

test("host offline: an approved handoff is held durably, shown as waiting, and never reported as sent", async (t) => {
  const { supervisor, delivered, dir } = fixture(t);
  await supervisor.tick({ reason: "test" });
  const result = await supervisor.sendOwnerMessage(KEY, "Submit Recorder 0.4.1 for App Review.", { idempotencyKey: "act_95" });
  assert.equal(result.delivery.status, "queued");
  assert.match(result.delivery.detail, /sent to this same chat when its host is back; no new approval is needed\. Not delivered yet/);
  assert.equal(sends(delivered).length, 1, "one real attempt");
  const waiting = supervisor.getState().handoffs.find((h) => h.key === "act_95");
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.threadKey, KEY);
  assert.equal(waiting.message, undefined, "state shows a snippet, not the full text");
  assert.ok(supervisor.getState().actions.some((a) => a.status === "queued" && a.threadKey === KEY));
  // Durable before anything else happens: a restarted supervisor still holds it.
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "fleet", "handoffs.json"), "utf8"));
  assert.equal(saved.entries[0].status, "waiting");
  // The same approval again (a retried tool call) is not attempted again.
  const again = await supervisor.sendOwnerMessage(KEY, "Submit Recorder 0.4.1 for App Review.", { idempotencyKey: "act_95" });
  assert.equal(again.delivery.status, "queued");
  assert.equal(sends(delivered).length, 1);
});

test("host reconnects: the held handoff goes out once, to that exact chat, without a new approval", async (t) => {
  const f = fixture(t);
  await f.supervisor.tick({ reason: "test" });
  await f.supervisor.sendOwnerMessage(KEY, "Submit Recorder 0.4.1 for App Review.", { idempotencyKey: "act_95" });
  // Still down at the next scan: kept, retried later, not marked sent.
  f.now.value += 2 * MIN;
  await f.supervisor.tick({ reason: "test" });
  assert.equal(f.supervisor.handoffs.get("act_95").status, "waiting");
  f.host.up = true;
  f.now.value += 2 * MIN;
  await f.supervisor.tick({ reason: "test" });
  const done = f.supervisor.handoffs.get("act_95");
  assert.equal(done.status, "delivered");
  assert.ok(done.deliveredActionId);
  assert.deepEqual(sends(f.delivered).map((d) => d.message), ["Submit Recorder 0.4.1 for App Review.", "Submit Recorder 0.4.1 for App Review.", "Submit Recorder 0.4.1 for App Review."]);
  assert.equal(sends(f.delivered, OTHER).length, 0, "never a different chat");
  // Later scans and a replay of the same approval send nothing more.
  f.now.value += 5 * MIN;
  await f.supervisor.tick({ reason: "test" });
  const replay = await f.supervisor.sendOwnerMessage(KEY, "Submit Recorder 0.4.1 for App Review.", { idempotencyKey: "act_95" });
  assert.equal(replay.delivery.status, "sent");
  assert.equal(replay.delivery.reconciled, true);
  assert.equal(sends(f.delivered).length, 3);
});

test("a restart keeps the held handoff and still delivers it once the host is back", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-handoff-restart-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = fixture(t, { dataDir: dir });
  await first.supervisor.tick({ reason: "test" });
  await first.supervisor.sendOwnerMessage(KEY, "Submit for review.", { idempotencyKey: "act_95" });
  const second = fixture(t, { dataDir: dir });
  second.host.up = true;
  second.now.value += 3 * MIN;
  await second.supervisor.tick({ reason: "test" });
  assert.equal(second.supervisor.handoffs.get("act_95").status, "delivered");
  assert.equal(sends(second.delivered).length, 1);
});

test("approving again (95 then 77) while held sends only the latest, once", async (t) => {
  const f = fixture(t);
  await f.supervisor.tick({ reason: "test" });
  await f.supervisor.sendOwnerMessage(KEY, "Submit 0.4.1 for review (first wording).", { idempotencyKey: "act_95" });
  await f.supervisor.sendOwnerMessage(KEY, "Submit 0.4.1 for review, keep manual release.", { idempotencyKey: "act_77" });
  assert.equal(f.supervisor.handoffs.get("act_95").status, "superseded");
  f.host.up = true;
  f.now.value += 2 * MIN;
  await f.supervisor.tick({ reason: "test" });
  const resent = sends(f.delivered).slice(2);
  assert.deepEqual(resent.map((d) => d.message), ["Submit 0.4.1 for review, keep manual release."]);
  assert.equal(f.supervisor.handoffs.get("act_77").status, "delivered");
});

test("an accepted but unconfirmed resume is never sent again and is not called delivered", async (t) => {
  const f = fixture(t);
  await f.supervisor.tick({ reason: "test" });
  await f.supervisor.sendOwnerMessage(KEY, "Submit for review.", { idempotencyKey: "act_95" });
  f.host.up = true; f.host.unconfirmed = true;
  f.now.value += 2 * MIN;
  await f.supervisor.tick({ reason: "test" });
  assert.equal(f.supervisor.handoffs.get("act_95").status, "unconfirmed");
  f.host.unconfirmed = false;
  f.now.value += 5 * MIN;
  await f.supervisor.tick({ reason: "test" });
  assert.equal(sends(f.delivered).length, 2, "no third attempt");
  assert.equal(f.supervisor.handoffs.get("act_95").status, "unconfirmed");
});

test("stale target: owner wrote to the chat after approving, the chat was archived, or it waited too long", async (t) => {
  for (const [name, change] of [
    ["owner wrote", (f) => { f.list[0].lastUserText = "Actually, wait for the new build."; f.list[0].lastUserAt = new Date(f.now.value).toISOString(); }],
    ["archived", (f) => { f.list[0].archived = true; }],
    ["ttl", (f) => { f.now.value += HANDOFF_TTL_MS; }]
  ]) {
    const f = fixture(t);
    await f.supervisor.tick({ reason: "test" });
    await f.supervisor.sendOwnerMessage(KEY, "Submit for review.", { idempotencyKey: `act_${name}` });
    f.host.up = true;
    f.now.value += 2 * MIN;
    change(f);
    await f.supervisor.tick({ reason: "test" });
    const entry = f.supervisor.handoffs.get(`act_${name}`);
    assert.equal(entry.status, "stale", name);
    assert.match(entry.detail, /not sent/, name);
    assert.equal(sends(f.delivered).length, 1, `${name}: no send after the first attempt`);
  }
});

test("phone approval: the card's yes is consumed once; the held handoff needs no second approval", async (t) => {
  const f = fixture(t);
  await f.supervisor.tick({ reason: "test" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-approval-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pendingActions = new PendingActionStore({ dir, now: () => f.now.value });
  const tools = new ToolRegistry();
  tools.bindPendingActions(pendingActions);
  registerFleetTools(tools, f.supervisor);
  const runtime = { pendingActions, tools };
  const card = await tools.invoke("fleet_send_message", { key: KEY, message: "Submit Recorder 0.4.1 for App Review." }, { sessionId: "phone" });
  assert.equal(card.result.status, "awaiting_confirmation");
  const ran = await executeApprovedAction(runtime, card.result.actionId, { decidedBy: "owner:phone" });
  assert.equal(ran.status, 200);
  assert.equal(ran.body.result.status, "queued");
  assert.equal(ran.body.result.delivered, false);
  assert.equal(pendingActions.get(card.result.actionId).status, "approved");
  assert.equal(pendingActions.list({ status: "pending" }).length, 0, "no new card for the owner");
  assert.equal(f.supervisor.handoffs.get(card.result.actionId).status, "waiting", "keyed by the approval");
  f.host.up = true;
  f.now.value += 2 * MIN;
  await f.supervisor.tick({ reason: "test" });
  assert.equal(f.supervisor.handoffs.get(card.result.actionId).status, "delivered");
});

test("the main forwards the approval key to the fleet computer, so its replay is not a second send", async (t) => {
  const f = fixture(t);
  await f.supervisor.tick({ reason: "test" });
  const capability = createFleetCapability(f.supervisor);
  const runtime = { nodeCapabilities: { dispatch: async (_n, _c, op, payload) => capability.invoke(op, payload) } };
  const remote = new RemoteFleetSupervisor({ runtime, nodeId: "buildbot3", sendRetryDelaysMs: [0, 0] });
  const first = await remote.sendOwnerMessage(KEY, "Submit for review.", { idempotencyKey: "act_77" });
  assert.equal(first.delivery.status, "queued");
  const replay = await remote.sendOwnerMessage(KEY, "Submit for review.", { idempotencyKey: "act_77" });
  assert.equal(replay.delivery.status, "queued");
  assert.equal(sends(f.delivered).length, 1);
});

test("lost acknowledgement: the same owner text with an unconfirmed earlier send is reconciled, never sent twice", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-lost-ack-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const initial = { id: "chat", status: "idle", updatedAt: "2026-01-01T00:00:00Z", cwd: "/workspace/repo", workspaceId: "workspace" };
  const sent = [];
  let confirmed = false;
  const ref = { refresh: async () => {}, current: () => initial, send: async (text, options) => { sent.push({ text, options }); },
    timeline: { refetch: async () => ({ agent: initial, entries: confirmed && sent.length
      ? [{ item: { type: "user_message", messageId: sent[0].options.messageId }, turnId: "turn-1", timestamp: initial.updatedAt, seqEnd: 1 }, { item: { type: "assistant_message", text: "working" }, turnId: "turn-1", seqStart: 2 }]
      : [] }) } };
  const factory = () => ({ connect: async () => {}, close: async () => {}, hosts: { list: async () => ({ self: { serverId: "host" }, hosts: [] }) }, agents: { ref: () => ref } });
  const args = { config: { paseo: { enabled: true, timeoutMs: 2000 } }, thread: paseoThread(initial, "host"), text: "Submit for review.", store: { dir }, actionId: "a1",
    base: { messageHash: "same-hash", playbook: "owner-message" }, factory };
  const first = await deliverPaseo(args);
  assert.equal(first.unconfirmed, true);
  assert.equal(sent.length, 1);
  const retry = await deliverPaseo({ ...args, actionId: "a2" });
  assert.equal(retry.status, "blocked");
  assert.match(retry.detail, /not sent again so it cannot arrive twice/);
  assert.equal(sent.length, 1);
  confirmed = true;
  const reconciled = await deliverPaseo({ ...args, actionId: "a3" });
  assert.equal(reconciled.status, "sent");
  assert.equal(reconciled.reconciled, true);
  assert.equal(sent.length, 1, "the earlier send was the delivery");
});

// Review fix (#361, Codex P1): A waits for its host; after recovery the owner
// approves B, whose send is accepted but unconfirmed. A must never go out
// after B.
test("a newer approval that ends unconfirmed still retires the older waiting handoff", async (t) => {
  const f = fixture(t);
  await f.supervisor.tick({ reason: "test" });
  await f.supervisor.sendOwnerMessage(KEY, "A: first wording.", { idempotencyKey: "act_A" });
  f.host.up = true; f.host.unconfirmed = true;
  const b = await f.supervisor.sendOwnerMessage(KEY, "B: replacement wording.", { idempotencyKey: "act_B" });
  assert.equal(b.delivery.unconfirmed, true);
  assert.equal(f.supervisor.handoffs.get("act_A").status, "superseded");
  f.host.unconfirmed = false;
  f.now.value += 2 * MIN;
  await f.supervisor.tick({ reason: "test" });
  assert.deepEqual(sends(f.delivered).map((d) => d.message), ["A: first wording.", "B: replacement wording."]);
});

// Review fix (#361): the process stopped after a resumed send went out but
// before "delivered" was saved. The restart reconciles, never resends.
test("a restart mid-dispatch reconciles the journal receipt instead of sending again", async (t) => {
  const f = fixture(t);
  await f.supervisor.tick({ reason: "test" });
  await f.supervisor.sendOwnerMessage(KEY, "Submit for review.", { idempotencyKey: "act_95" });
  const started = new Date(f.now.value + MIN).toISOString();
  f.supervisor.handoffs.update("act_95", { dispatchingAt: started });
  f.supervisor.store.recordAction({ threadKey: KEY, playbook: "owner-message", route: "paseo-send", status: "sent",
    messageHash: shortHash(`${SUPERVISOR_PREFIX} Submit for review.`), detail: "Paseo message and turn confirmed", at: new Date(f.now.value + MIN + 2000).toISOString() });
  f.host.up = true;
  f.now.value += 3 * MIN;
  await f.supervisor.tick({ reason: "test" });
  assert.equal(f.supervisor.handoffs.get("act_95").status, "delivered");
  assert.match(f.supervisor.handoffs.get("act_95").detail, /not sent again/);
  assert.equal(sends(f.delivered).length, 1, "only the original offline attempt");
});

test("a restart mid-dispatch with no trace of the send sends it once", async (t) => {
  const f = fixture(t);
  await f.supervisor.tick({ reason: "test" });
  await f.supervisor.sendOwnerMessage(KEY, "Submit for review.", { idempotencyKey: "act_95" });
  f.supervisor.handoffs.update("act_95", { dispatchingAt: new Date(f.now.value + MIN).toISOString() });
  f.host.up = true;
  f.now.value += 3 * MIN;
  await f.supervisor.tick({ reason: "test" });
  assert.equal(f.supervisor.handoffs.get("act_95").status, "delivered");
  assert.equal(sends(f.delivered).length, 2);
});

// Review fix (#361): the same words with a different screenshot are a
// different message, never "already delivered".
test("same text with different images is not reconciled as the earlier send", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-images-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const initial = { id: "chat", status: "idle", updatedAt: "2026-01-01T00:00:00Z", cwd: "/workspace/repo", workspaceId: "workspace" };
  const sent = [];
  let confirmed = false;
  const ref = { refresh: async () => {}, current: () => initial, send: async (text, options) => { sent.push({ text, options }); },
    timeline: { refetch: async () => ({ agent: initial, entries: confirmed && sent.length
      ? [{ item: { type: "user_message", messageId: sent.at(-1).options.messageId }, turnId: "turn-1", timestamp: initial.updatedAt, seqEnd: 1 }, { item: { type: "assistant_message", text: "working" }, turnId: "turn-1", seqStart: 2 }]
      : [] }) } };
  const factory = () => ({ connect: async () => {}, close: async () => {}, hosts: { list: async () => ({ self: { serverId: "host" }, hosts: [] }) }, agents: { ref: () => ref } });
  const args = { config: { paseo: { enabled: true, timeoutMs: 2000 } }, thread: paseoThread(initial, "host"), text: "Please fix this screenshot.", store: { dir }, actionId: "a1",
    base: { messageHash: "same-text", playbook: "owner-message" }, factory };
  const png = (n) => [{ mimeType: "image/png", data: Buffer.from(`image-${n}`).toString("base64") }];
  await deliverPaseo({ ...args, images: png(1) });
  assert.equal(sent.length, 1);
  confirmed = true;
  const second = await deliverPaseo({ ...args, actionId: "a2", images: png(2) });
  assert.notEqual(second.reconciled, true, "a new screenshot is not the old one");
  assert.equal(sent.length, 2, "the new image is actually sent");
});

// Review fix (#361, Codex P1): a prompt that appeared while the handoff
// waited is never answered by it.
test("a held handoff never answers a permission prompt that appeared while it waited", async (t) => {
  const f = fixture(t);
  await f.supervisor.tick({ reason: "test" });
  await f.supervisor.sendOwnerMessage(KEY, "Approve the release handoff.", { idempotencyKey: "act_77" });
  f.host.up = true; f.host.permission = true;
  f.now.value += 2 * MIN;
  await f.supervisor.tick({ reason: "test" });
  const held = f.supervisor.handoffs.get("act_77");
  assert.equal(held.status, "waiting");
  assert.match(held.detail, /pending permission prompt/);
  assert.equal(sends(f.delivered).length, 1, "nothing reached the chat on resume");
  f.host.permission = false;
  f.now.value += 2 * MIN;
  await f.supervisor.tick({ reason: "test" });
  assert.equal(f.supervisor.handoffs.get("act_77").status, "delivered");
  assert.equal(sends(f.delivered).at(-1).noPermissionReply, true);
});

test("deliverPaseo refuses a no-reply send into an open prompt before dispatching", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-perm-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const agent = { id: "chat", status: "idle", updatedAt: "2026-01-01T00:00:00Z", cwd: "/w", workspaceId: "w", pendingPermissions: [{ id: "perm-1", kind: "tool", actions: [{ id: "allow", label: "Allow", behavior: "allow" }] }] };
  let sent = 0, answered = 0;
  const ref = { refresh: async () => {}, current: () => agent, send: async () => { sent += 1; }, timeline: { refetch: async () => ({ agent, entries: [] }) } };
  const factory = () => ({ connect: async () => {}, close: async () => {}, hosts: { list: async () => ({ self: { serverId: "host" }, hosts: [] }) },
    agents: { ref: () => ref }, permissions: { respond: async () => { answered += 1; } } });
  const thread = paseoThread(agent, "host");
  const result = await deliverPaseo({ config: { paseo: { enabled: true, timeoutMs: 2000 } }, thread, text: "Approve the release handoff.", store: { dir }, actionId: "a1",
    base: { messageHash: "h", playbook: "owner-message" }, factory, noPermissionReply: true });
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /never sent into it/);
  assert.equal(sent, 0);
  assert.equal(answered, 0);
});

// Review fix (#361, Codex P1): a handoff superseded while an earlier one in
// the same resume pass was sending is not sent.
test("a handoff superseded mid-pass is not sent by that pass", async (t) => {
  const f = fixture(t);
  await f.supervisor.tick({ reason: "test" });
  await f.supervisor.sendOwnerMessage(KEY, "First chat: old.", { idempotencyKey: "act_1" });
  await f.supervisor.sendOwnerMessage(OTHER, "Second chat: old.", { idempotencyKey: "act_2" });
  f.host.up = true;
  let fired = false;
  f.host.onDeliver = async (args) => {
    if (fired || args.thread.key !== KEY) return;
    fired = true;
    await f.supervisor.sendOwnerMessage(OTHER, "Second chat: replacement.", { idempotencyKey: "act_3" });
  };
  f.now.value += 2 * MIN;
  await f.supervisor.tick({ reason: "test" });
  assert.equal(f.supervisor.handoffs.get("act_2").status, "superseded");
  assert.deepEqual(sends(f.delivered, OTHER).map((d) => d.message), ["Second chat: old.", "Second chat: replacement."]);
});

// Review fix (#361): an unconfirmed first send is recorded under its
// approval, so replaying that approval never sends it again.
test("an unconfirmed first send is never resent when its approval is replayed", async (t) => {
  const f = fixture(t);
  await f.supervisor.tick({ reason: "test" });
  f.host.up = true; f.host.unconfirmed = true;
  const first = await f.supervisor.sendOwnerMessage(KEY, "Submit for review.", { idempotencyKey: "act_9" });
  assert.equal(first.delivery.unconfirmed, true);
  f.host.unconfirmed = false;
  await f.supervisor.sendOwnerMessage(KEY, "Unrelated later message.", { idempotencyKey: "act_10" });
  const replay = await f.supervisor.sendOwnerMessage(KEY, "Submit for review.", { idempotencyKey: "act_9" });
  assert.equal(replay.delivery.unconfirmed, true);
  assert.deepEqual(sends(f.delivered).map((d) => d.message), ["Submit for review.", "Unrelated later message."]);
});

// Review fix (#361): an older Paseo receipt for the same text is a different
// send and never settles a newly approved handoff.
test("restart recovery ignores an older Paseo receipt with the same text", async (t) => {
  const f = fixture(t);
  await f.supervisor.tick({ reason: "test" });
  await f.supervisor.sendOwnerMessage(KEY, "Submit for review.", { idempotencyKey: "act_95" });
  const receiptDir = path.join(f.dir, "fleet", "paseo-deliveries");
  fs.mkdirSync(receiptDir, { recursive: true });
  const file = path.join(receiptDir, `${createHash("sha256").update(KEY).digest("hex")}.json`);
  fs.writeFileSync(file, JSON.stringify({ messageId: "old", messageHash: shortHash(`${SUPERVISOR_PREFIX} Submit for review.`), pending: false }));
  const old = new Date("2020-01-01T00:00:00Z");
  fs.utimesSync(file, old, old);
  f.supervisor.handoffs.update("act_95", { dispatchingAt: new Date(f.now.value + MIN).toISOString() });
  f.host.up = true;
  f.now.value += 3 * MIN;
  await f.supervisor.tick({ reason: "test" });
  assert.equal(f.supervisor.handoffs.get("act_95").status, "delivered");
  assert.equal(sends(f.delivered).length, 2, "it was actually sent, not settled by the old receipt");
});

// Review fix (#361, Codex P1): an explicit owner send without an approval key
// (such as fleet page replyTarget) supersedes waiting handoffs on that chat.
test("unkeyed owner send supersedes earlier waiting handoffs", async (t) => {
  const f = fixture(t);
  await f.supervisor.tick({ reason: "test" });
  await f.supervisor.sendOwnerMessage(KEY, "A: old instruction.", { idempotencyKey: "act_A" });
  assert.equal(f.supervisor.handoffs.get("act_A").status, "waiting");
  f.host.up = true;
  await f.supervisor.sendOwnerMessage(KEY, "B: cancel and stop.");
  assert.equal(f.supervisor.handoffs.get("act_A").status, "superseded");
  f.now.value += 2 * MIN;
  await f.supervisor.tick({ reason: "test" });
  assert.deepEqual(sends(f.delivered).map((d) => d.message), ["A: old instruction.", "B: cancel and stop."]);
});

// Review fix (#361, Codex P2): resumed handoffs disable replacement-session
// recovery so a disconnected runtime blocks rather than cloning a new chat.
test("resumed handoff passes recoverDisconnected: false and never creates a replacement session", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-no-recover-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const agent = { id: "chat", status: "idle", updatedAt: "2026-01-01T00:00:00Z", cwd: "/w", workspaceId: "w", pendingPermissions: [] };
  let created = 0;
  const ref = {
    refresh: async () => {},
    current: () => agent,
    send: async () => { throw new Error("ACP agent disconnected (exit code 1)"); },
    timeline: { refetch: async () => ({ agent, entries: [] }) }
  };
  const factory = () => ({
    connect: async () => {},
    close: async () => {},
    hosts: { list: async () => ({ self: { serverId: "host" }, hosts: [] }) },
    agents: { ref: () => ref, create: async () => { created += 1; return { id: "clone" }; } }
  });
  const result = await deliverPaseo({
    config: { paseo: { enabled: true, timeoutMs: 2000 } },
    thread: paseoThread(agent, "host"),
    text: "Submit release.",
    store: { dir },
    actionId: "a1",
    base: { messageHash: "h", playbook: "owner-message" },
    factory,
    recoverDisconnected: true,
    noPermissionReply: true
  });
  assert.equal(result.status, "blocked");
  assert.equal(created, 0, "no replacement session created for resumed handoff");
  const receiptFile = path.join(dir, "paseo-deliveries", `${createHash("sha256").update(paseoThread(agent, "host").key).digest("hex")}.json`);
  const savedReceipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  assert.equal(savedReceipt.pending, false);
  assert.equal(savedReceipt.delivered, false);
  assert.equal(savedReceipt.sendError, true);
});

// Review fix (#361, Codex P2): require a fresh Paseo scan before resuming
// waiting handoffs so cached threads cannot hide a newer owner cancellation.
test("failed Paseo scan defers resuming waiting handoffs", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-scan-fail-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = { value: T0 };
  const host = { up: false, scanFail: false };
  const delivered = [];
  const list = [makeThread(KEY)];
  const executor = {
    deliver: async (args) => {
      delivered.push(args.message);
      if (!host.up) return { status: "blocked", route: args.route, detail: HOST_DOWN, actionId: `fa_${delivered.length}` };
      return { status: "sent", route: args.route, detail: "sent", actionId: `fa_${delivered.length}` };
    },
    inFlight: () => [], whenIdle: async () => {}
  };
  const config = resolveFleetConfig({ OPENAGI_FLEET_STORAGE: "0", OPENAGI_FLEET_PASEO: "1", OPENAGI_FLEET_PASEO_ONLY: "1" }, { home: dir, mode: "observe", limits: { ...DEFAULTS }, managerRef: "none" });
  const supervisor = new FleetSupervisor({
    dataDir: dir, config, deps: {
      now: () => now.value, executor,
      notifier: { notifyQuestion: async () => ({ outreachId: null, pushed: false, skipped: "push-off" }) },
      listPaseoThreads: async () => { if (host.scanFail) throw new Error("paseo scan offline"); return list; },
      findPrForBranch: async () => null, fetchPrStates: async () => new Map(), fetchPrStateLite: async () => new Map()
    }
  });
  supervisor._uiDriver = { readiness: async () => ({ ready: false }) };
  await supervisor.tick({ reason: "test" });
  await supervisor.sendOwnerMessage(KEY, "Ship it.", { idempotencyKey: "act_scan" });
  host.up = true;
  host.scanFail = true;
  now.value += 2 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.equal(supervisor.handoffs.get("act_scan").status, "waiting");
  assert.equal(delivered.length, 1, "did not resume against cached threads after failed Paseo scan");
});

// Review fix (#361, Codex P2): anchor createdAt before awaiting initial
// delivery so an owner cancellation written during that await marks it stale.
test("owner cancellation during initial offline delivery attempt marks handoff stale", async (t) => {
  const f = fixture(t);
  await f.supervisor.tick({ reason: "test" });
  f.host.onDeliver = async () => {
    f.now.value += 30_000;
    // Owner writes cancellation while the initial offline attempt is in flight.
    f.list[0].lastUserText = "Actually stop, do not submit.";
    f.list[0].lastUserAt = new Date(f.now.value - 5_000).toISOString();
    f.now.value += 10_000;
  };
  const queued = await f.supervisor.sendOwnerMessage(KEY, "Submit now.", { idempotencyKey: "act_anchor" });
  assert.equal(queued.delivery.status, "queued");
  f.host.onDeliver = null;
  f.host.up = true;
  f.now.value += 2 * MIN;
  await f.supervisor.tick({ reason: "test" });
  assert.equal(f.supervisor.handoffs.get("act_anchor").status, "stale");
  assert.equal(sends(f.delivered).length, 1, "stale handoff was not sent after cancellation");
});

// Review fix (#361, Codex P2): restart recovery requires explicit success
// evidence and never settles a failed ref.send() receipt as delivered.
test("restart recovery does not mark a failed Paseo receipt as delivered", async (t) => {
  const f = fixture(t);
  await f.supervisor.tick({ reason: "test" });
  await f.supervisor.sendOwnerMessage(KEY, "Submit for review.", { idempotencyKey: "act_fail_rec" });
  const receiptDir = path.join(f.dir, "fleet", "paseo-deliveries");
  fs.mkdirSync(receiptDir, { recursive: true });
  const file = path.join(receiptDir, `${createHash("sha256").update(KEY).digest("hex")}.json`);
  fs.writeFileSync(file, JSON.stringify({
    messageId: "m1",
    messageHash: shortHash(`${SUPERVISOR_PREFIX} Submit for review.`),
    pending: false,
    delivered: false,
    sendError: true
  }));
  f.supervisor.handoffs.update("act_fail_rec", { dispatchingAt: new Date(f.now.value - 1_000).toISOString() });
  const reconciled = f.supervisor.reconcileHandoffDispatch(f.supervisor.handoffs.get("act_fail_rec"));
  assert.equal(reconciled, null, "failed sendError receipt is never treated as delivered");
});

// Review fix (#361, Codex P2): preserve approval ordering across in-flight
// delivery attempts so an older offline result cannot queue after a newer send.
test("older offline attempt finishing after a newer concurrent approval does not queue", async (t) => {
  const f = fixture(t);
  await f.supervisor.tick({ reason: "test" });
  let releaseA;
  const aWaiting = new Promise((resolve) => { releaseA = resolve; });
  let aEntered;
  const aStarted = new Promise((resolve) => { aEntered = resolve; });
  f.host.onDeliver = async (args) => {
    if (args.message === "A: first.") {
      aEntered();
      await aWaiting;
    }
  };
  const promiseA = f.supervisor.sendOwnerMessage(KEY, "A: first.", { idempotencyKey: "act_order_A" });
  await aStarted;
  // Newer approval B arrives while A is still awaiting its offline result.
  const resB = await f.supervisor.sendOwnerMessage(KEY, "B: cancel.", { idempotencyKey: "act_order_B" });
  assert.equal(resB.delivery.status, "queued");
  releaseA();
  const resA = await promiseA;
  assert.equal(f.supervisor.handoffs.get("act_order_A").status, "superseded");
  assert.equal(resA.delivery.status, "blocked");
  assert.equal(f.supervisor.handoffs.get("act_order_B").status, "waiting");
  f.host.onDeliver = null;
  f.host.up = true;
  f.now.value += 2 * MIN;
  await f.supervisor.tick({ reason: "test" });
  assert.equal(f.supervisor.handoffs.get("act_order_B").status, "delivered");
  assert.equal(f.supervisor.handoffs.get("act_order_A").status, "superseded");
});

// Review fix (#361, Codex P2): lost remote reply reconciles against the
// persisted handoff entry by idempotencyKey rather than preliminary blocked row.
test("RemoteFleetSupervisor reconciles a lost reply against a queued handoff by idempotencyKey", async (t) => {
  const f = fixture(t);
  await f.supervisor.tick({ reason: "test" });
  const capability = createFleetCapability(f.supervisor);
  let dropSendReply = true;
  const remote = new RemoteFleetSupervisor({
    nodeId: "node_fleet",
    runtime: {
      nodeCapabilities: {
        dispatch: async (_nodeId, _cap, op, payload) => {
          const out = await capability.invoke(op, payload);
          if (payload.path === "/fleet/api/send" && dropSendReply) {
            dropSendReply = false;
            throw Object.assign(new Error("Request timed out"), { nodeAcknowledged: true, timedOut: true });
          }
          return out;
        }
      }
    }
  });
  const result = await remote.sendOwnerMessage(KEY, "Submit Recorder 0.4.1.", { idempotencyKey: "act_remote_q" });
  assert.equal(result.delivery.status, "queued");
  assert.equal(result.delivery.handoffKey, "act_remote_q");
  assert.equal(f.supervisor.handoffs.get("act_remote_q").status, "waiting");
});

// Review fix (#361, Codex P2 round 2): scanned permission blockers keep the
// handoff waiting so clearing the permission still delivers automatically.
test("scanned pendingPermission keeps held handoff waiting and delivers once cleared", async (t) => {
  const f = fixture(t);
  await f.supervisor.tick({ reason: "test" });
  await f.supervisor.sendOwnerMessage(KEY, "Ship release.", { idempotencyKey: "act_perm_scan" });
  f.host.up = true;
  f.list[0].meta.pendingPermission = { id: "perm-9" };
  f.now.value += 2 * MIN;
  await f.supervisor.tick({ reason: "test" });
  assert.equal(f.supervisor.handoffs.get("act_perm_scan").status, "waiting");
  assert.match(f.supervisor.handoffs.get("act_perm_scan").detail, /pending permission prompt/);
  delete f.list[0].meta.pendingPermission;
  f.now.value += 2 * MIN;
  await f.supervisor.tick({ reason: "test" });
  assert.equal(f.supervisor.handoffs.get("act_perm_scan").status, "delivered");
});

// Review fix (#361, Codex P2 round 2): when the recovered chat is mid-turn,
// keep tracking in the handoff queue (waiting) instead of marking blocked or
// losing approval/stale/TTL checks in the ordinary busy queue.
test("recovered chat that is busy mid-turn keeps held handoff waiting until idle", async (t) => {
  const f = fixture(t);
  await f.supervisor.tick({ reason: "test" });
  await f.supervisor.sendOwnerMessage(KEY, "Continue after restart.", { idempotencyKey: "act_busy_res" });
  f.host.up = true;
  f.list[0].agentStatus = "running";
  f.now.value += 2 * MIN;
  await f.supervisor.tick({ reason: "test" });
  assert.equal(f.supervisor.handoffs.get("act_busy_res").status, "waiting");
  assert.equal(f.supervisor.store.queuedOwnerMessages(KEY).length, 0, "does not duplicate into ordinary busy queue");
  f.list[0].agentStatus = "idle";
  f.now.value += 2 * MIN;
  await f.supervisor.tick({ reason: "test" });
  assert.equal(f.supervisor.handoffs.get("act_busy_res").status, "delivered");
});
