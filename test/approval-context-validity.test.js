import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerFleetTools } from "../src/fleet/tools.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { PendingActionStore } from "../src/pending-actions.js";
import { executeApprovedAction } from "../src/approval-executor.js";

function setup(t, { now }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "approval-validity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rows = [{ key: "paseo:s.a", workspace: "amman", title: "Fix billing", lastOwnerAt: null }];
  const sent = [];
  const actions = [];
  const lastThreads = new Map();
  const supervisor = {
    lastThreads,
    getState: () => ({ mode: "auto", enabled: true, questions: [], actions, snapshot: { threads: rows } }),
    sendOwnerMessage: async (key, message) => { sent.push({ key, message }); return { delivery: { status: "sent", route: "paseo", detail: "ok" } }; }
  };
  const pendingActions = new PendingActionStore({ dir: path.join(dir, "pending"), now: () => now.value });
  const tools = new ToolRegistry();
  tools.bindPendingActions(pendingActions);
  registerFleetTools(tools, supervisor);
  return { rows, sent, actions, lastThreads, pendingActions, runtime: { pendingActions, tools } };
}

test("an unanswered send approval lasts while its chat does, not a fixed ten minutes", async (t) => {
  const now = { value: Date.parse("2026-11-21T10:00:00.000Z") };
  const h = setup(t, { now });
  const queued = await h.runtime.tools.invoke("fleet_send_message", { key: "paseo:s.a", message: "Ship it" }, { sessionId: "s1" });
  assert.equal(queued.result.status, "awaiting_confirmation");
  now.value += 3 * 60 * 60_000;
  const ran = await executeApprovedAction(h.runtime, queued.result.actionId);
  assert.equal(ran.status, 200);
  assert.deepEqual(h.sent, [{ key: "paseo:s.a", message: "Ship it" }]);
});

test("an approval whose chat is gone or that the owner moved past is retired, not run", async (t) => {
  const now = { value: Date.parse("2026-11-21T10:00:00.000Z") };
  const h = setup(t, { now });
  const first = await h.runtime.tools.invoke("fleet_send_message", { key: "paseo:s.a", message: "Ship it" }, { sessionId: "s1" });
  h.rows[0].lastOwnerAt = new Date(now.value + 60_000).toISOString();
  now.value += 5 * 60_000;
  const moved = await executeApprovedAction(h.runtime, first.result.actionId);
  assert.equal(moved.status, 410);
  assert.match(moved.body.error, /amman has new messages from you since this was asked/);
  assert.equal(h.pendingActions.get(first.result.actionId).status, "expired");

  const second = await h.runtime.tools.invoke("fleet_send_message", { key: "paseo:s.a", message: "Merge it" }, { sessionId: "s1" });
  h.rows.length = 0;
  const gone = await executeApprovedAction(h.runtime, second.result.actionId);
  assert.equal(gone.status, 410);
  assert.match(gone.body.error, /No fleet thread/);
  assert.equal(h.sent.length, 0);
});

// Incident tw_d9544149a037e8c1: the Supervisor's own goal nudge landed in a
// coding agent's chat after the owner's handoff card was raised. Paseo reports that
// nudge as the chat's latest user message (the owner's own turn had scrolled
// out of the read window, so its text is empty), and the approved handoff was
// retired as "the thread changed" and silently dropped.
test("the supervisor's own nudge in the chat does not retire an approved handoff", async (t) => {
  const now = { value: Date.parse("2026-11-22T18:00:00.000Z") };
  const h = setup(t, { now });
  const queued = await h.runtime.tools.invoke("fleet_send_message", { key: "paseo:s.a", message: "Investigate the missing integration in #outbound" }, { sessionId: "s1" });
  const nudgeAt = new Date(now.value + 11 * 60_000).toISOString();
  h.rows[0].lastOwnerAt = nudgeAt;
  h.rows[0].lastOwnerText = "";
  h.rows[0].meta = { lastSupervisorAt: new Date(Date.parse(nudgeAt) + 800).toISOString() };
  now.value += 60 * 60_000;
  const ran = await executeApprovedAction(h.runtime, queued.result.actionId);
  assert.equal(ran.status, 200);
  assert.deepEqual(h.sent, [{ key: "paseo:s.a", message: "Investigate the missing integration in #outbound" }]);
});

test("a supervisor delivery receipt in the journal also counts as the supervisor's write", async (t) => {
  const now = { value: Date.parse("2026-11-22T18:00:00.000Z") };
  const h = setup(t, { now });
  const queued = await h.runtime.tools.invoke("fleet_send_message", { key: "paseo:s.a", message: "Investigate the missing integration" }, { sessionId: "s1" });
  const landedAt = now.value + 11 * 60_000;
  // The reader's own view of the chat (local): its window held no owner turn.
  h.lastThreads.set("paseo:s.a", { key: "paseo:s.a", lastUserAt: new Date(landedAt).toISOString(), lastUserText: "", meta: {} });
  h.actions.push({ threadKey: "paseo:s.a", playbook: "goal-continuation", status: "sent", route: "paseo-send", finishedAt: new Date(landedAt + 3_000).toISOString() });
  now.value += 30 * 60_000;
  const ran = await executeApprovedAction(h.runtime, queued.result.actionId);
  assert.equal(ran.status, 200);
  assert.equal(h.sent.length, 1);
});

test("owner words in the chat since the card retire it, raise one fresh card, and say nothing was sent", async (t) => {
  const now = { value: Date.parse("2026-11-22T18:00:00.000Z") };
  const h = setup(t, { now });
  const first = await h.runtime.tools.invoke("fleet_send_message", { key: "paseo:s.a", message: "Investigate the missing integration" }, { sessionId: "s1" });
  h.rows[0].lastOwnerAt = new Date(now.value + 60_000).toISOString();
  h.rows[0].lastOwnerText = "actually start with the other vendor";
  // A supervisor stamp at the same moment does not hide the owner's own text.
  h.rows[0].meta = { lastSupervisorAt: h.rows[0].lastOwnerAt };
  now.value += 5 * 60_000;
  const moved = await executeApprovedAction(h.runtime, first.result.actionId);
  assert.equal(moved.status, 410);
  assert.equal(moved.body.notRun, true);
  assert.match(moved.body.error, /Nothing was sent or started/);
  assert.equal(h.sent.length, 0);
  assert.equal(h.pendingActions.get(first.result.actionId).status, "expired");
  const fresh = h.pendingActions.get(moved.body.reraised.actionId);
  assert.equal(fresh.status, "pending");
  assert.notEqual(fresh.id, first.result.actionId);
  assert.deepEqual(fresh.args, h.pendingActions.get(first.result.actionId).args);
  assert.match(moved.body.error, new RegExp(`code ${fresh.confirmCode}`));
  // Durable: a restarted store still holds the fresh card.
  const reloaded = new PendingActionStore({ dir: h.pendingActions.dir, now: () => now.value });
  assert.equal(reloaded.get(fresh.id)?.status, "pending");
  // The fresh yes runs it exactly once; the retired card can never run.
  const ran = await executeApprovedAction(h.runtime, fresh.id);
  assert.equal(ran.status, 200);
  assert.equal(h.sent.length, 1);
  const again = await executeApprovedAction(h.runtime, first.result.actionId);
  assert.equal(again.status, 410);
  assert.equal(h.sent.length, 1);
  assert.equal(h.pendingActions.list({ status: "pending" }).length, 0, "no duplicate card left behind");
});

test("a card whose chat is gone is retired without raising another", async (t) => {
  const now = { value: Date.parse("2026-11-22T18:00:00.000Z") };
  const h = setup(t, { now });
  const queued = await h.runtime.tools.invoke("fleet_send_message", { key: "paseo:s.a", message: "Investigate the missing integration" }, { sessionId: "s1" });
  h.rows.length = 0;
  const gone = await executeApprovedAction(h.runtime, queued.result.actionId);
  assert.equal(gone.status, 410);
  assert.equal(gone.body.reraised, undefined);
  assert.equal(h.pendingActions.list({ status: "pending" }).length, 0);
});

// Review fix (#350): a remote snapshot row carries no owner text, so a
// supervisor delivery receipt near an owner turn must not hide that turn.
test("on a remote row, a nearby delivery receipt does not hide the owner's turn", async (t) => {
  const now = { value: Date.parse("2026-11-22T18:00:00.000Z") };
  const h = setup(t, { now });
  const queued = await h.runtime.tools.invoke("fleet_send_message", { key: "paseo:s.a", message: "Investigate the missing integration" }, { sessionId: "s1" });
  const ownerAt = now.value + 10 * 60_000;
  h.rows[0].lastOwnerAt = new Date(ownerAt).toISOString();
  h.actions.push({ threadKey: "paseo:s.a", playbook: "goal-continuation", status: "sent", route: "paseo-send", finishedAt: new Date(ownerAt + 30_000).toISOString() });
  now.value += 30 * 60_000;
  const ran = await executeApprovedAction(h.runtime, queued.result.actionId);
  assert.equal(ran.status, 410, "fails closed: a fresh yes is needed");
  assert.equal(h.sent.length, 0);
});

test("on a remote row, the reader's own supervisor stamp still identifies the supervisor's write", async (t) => {
  const now = { value: Date.parse("2026-11-22T18:00:00.000Z") };
  const h = setup(t, { now });
  const queued = await h.runtime.tools.invoke("fleet_send_message", { key: "paseo:s.a", message: "Investigate the missing integration" }, { sessionId: "s1" });
  const nudgeAt = now.value + 10 * 60_000;
  h.rows[0].lastOwnerAt = new Date(nudgeAt).toISOString();
  // Its reader had no owner text for that turn.
  h.rows[0].lastOwnerBy = "unattributed";
  h.rows[0].lastSupervisorAt = new Date(nudgeAt + 600).toISOString();
  now.value += 30 * 60_000;
  const ran = await executeApprovedAction(h.runtime, queued.result.actionId);
  assert.equal(ran.status, 200);
  assert.equal(h.sent.length, 1);
});

// Review fix (#350): approval raised at 18:00, a supervisor nudge at
// 18:01:00, the owner's correction at 18:01:02. The stamp is two seconds
// from the owner's turn, but the reader saw the owner write it.
test("on a remote row, an owner turn just after a supervisor nudge still needs a fresh yes", async (t) => {
  const now = { value: Date.parse("2026-11-22T18:00:00.000Z") };
  const h = setup(t, { now });
  const queued = await h.runtime.tools.invoke("fleet_send_message", { key: "paseo:s.a", message: "Investigate the missing integration" }, { sessionId: "s1" });
  h.rows[0].lastSupervisorAt = new Date(now.value + 60_000).toISOString();
  h.rows[0].lastOwnerAt = new Date(now.value + 62_000).toISOString();
  h.rows[0].lastOwnerBy = "owner";
  now.value += 5 * 60_000;
  const ran = await executeApprovedAction(h.runtime, queued.result.actionId);
  assert.equal(ran.status, 410);
  assert.equal(ran.body.notRun, true);
  assert.equal(h.sent.length, 0);
  assert.equal(h.pendingActions.get(ran.body.reraised.actionId)?.status, "pending");
});

test("a remote row with no attribution (an older computer) is presumed the owner's, even beside a stamp", async (t) => {
  const now = { value: Date.parse("2026-11-22T18:00:00.000Z") };
  const h = setup(t, { now });
  const queued = await h.runtime.tools.invoke("fleet_send_message", { key: "paseo:s.a", message: "Investigate the missing integration" }, { sessionId: "s1" });
  const at = now.value + 10 * 60_000;
  h.rows[0].lastOwnerAt = new Date(at).toISOString();
  h.rows[0].lastSupervisorAt = new Date(at + 600).toISOString();
  now.value += 30 * 60_000;
  const ran = await executeApprovedAction(h.runtime, queued.result.actionId);
  assert.equal(ran.status, 410, "fails closed: asked again, never sent past it");
  assert.equal(h.sent.length, 0);
});

// Review fix (#350): the local reader saw an empty-text turn that a journal
// receipt shows is the supervisor's; the snapshot row repeats that turn's
// time without text. The row is the same turn, so it does not re-raise.
test("the snapshot row for the reader's own turn does not overrule the reader's receipt attribution", async (t) => {
  const now = { value: Date.parse("2026-11-22T18:00:00.000Z") };
  const h = setup(t, { now });
  const queued = await h.runtime.tools.invoke("fleet_send_message", { key: "paseo:s.a", message: "Investigate the missing integration" }, { sessionId: "s1" });
  const landedAt = new Date(now.value + 11 * 60_000).toISOString();
  h.lastThreads.set("paseo:s.a", { key: "paseo:s.a", lastUserAt: landedAt, lastUserText: "", meta: {} });
  h.rows[0].lastOwnerAt = landedAt;
  h.actions.push({ threadKey: "paseo:s.a", playbook: "goal-continuation", status: "sent", route: "paseo-send", finishedAt: new Date(Date.parse(landedAt) + 3_000).toISOString() });
  now.value += 30 * 60_000;
  const ran = await executeApprovedAction(h.runtime, queued.result.actionId);
  assert.equal(ran.status, 200);
  assert.equal(h.sent.length, 1);
});

// Review fix (#350): a card denied on another surface while its check runs
// is not raised again.
test("a card denied elsewhere during the validity check is not raised again", async (t) => {
  const now = { value: Date.parse("2026-11-22T18:00:00.000Z") };
  const h = setup(t, { now });
  const queued = await h.runtime.tools.invoke("fleet_send_message", { key: "paseo:s.a", message: "Investigate" }, { sessionId: "s1" });
  h.rows[0].lastOwnerAt = new Date(now.value + 60_000).toISOString();
  h.rows[0].lastOwnerText = "never mind";
  const check = h.runtime.tools.approvalVerdict.bind(h.runtime.tools);
  h.runtime.tools.approvalVerdict = async (action) => {
    h.pendingActions.decide(action.id, { decision: "deny", decidedBy: "owner:dashboard" });
    return check(action);
  };
  now.value += 5 * 60_000;
  const ran = await executeApprovedAction(h.runtime, queued.result.actionId);
  assert.equal(ran.status, 410);
  assert.equal(ran.body.reraised, undefined);
  assert.equal(h.pendingActions.get(queued.result.actionId).status, "denied");
  assert.equal(h.pendingActions.list({ status: "pending" }).length, 0);
  assert.equal(h.sent.length, 0);
});

// Review fix (#350): a chat card raised again keeps the owner's instruction,
// so approving the fresh code still carries the rest of the request.
test("a re-raised chat card keeps the owner's instruction", async (t) => {
  const now = { value: Date.parse("2026-11-22T18:00:00.000Z") };
  const h = setup(t, { now });
  const card = h.pendingActions.enqueue({ toolName: "fleet_send_message", args: { key: "paseo:s.a", name: "amman", message: "Send plan A" }, context: { sessionId: "s1" },
    summary: "Send plan A", mode: "chat", ownerIntent: "Send the plan to amman, then to the iOS chat" });
  h.rows[0].lastOwnerAt = new Date(now.value + 60_000).toISOString();
  h.rows[0].lastOwnerText = "also mention the deadline";
  now.value += 5 * 60_000;
  const moved = await executeApprovedAction(h.runtime, card.id);
  assert.equal(moved.status, 410);
  assert.equal(h.pendingActions.ownerIntentFor(moved.body.reraised.actionId), "Send the plan to amman, then to the iOS chat");
});
