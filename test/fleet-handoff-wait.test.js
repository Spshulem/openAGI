import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, resolveFleetConfig } from "../src/fleet/contracts.js";
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
  const host = { up: false, unconfirmed: false };
  const delivered = [];
  const list = threads ?? [makeThread(KEY), makeThread(OTHER)];
  const executor = {
    deliver: async (args) => {
      delivered.push({ key: args.thread.key, message: args.message });
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
