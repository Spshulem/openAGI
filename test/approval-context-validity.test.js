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
  const supervisor = {
    getState: () => ({ mode: "auto", enabled: true, questions: [], actions: [], snapshot: { threads: rows } }),
    sendOwnerMessage: async (key, message) => { sent.push({ key, message }); return { delivery: { status: "sent", route: "paseo", detail: "ok" } }; }
  };
  const pendingActions = new PendingActionStore({ dir: path.join(dir, "pending"), now: () => now.value });
  const tools = new ToolRegistry();
  tools.bindPendingActions(pendingActions);
  registerFleetTools(tools, supervisor);
  return { rows, sent, pendingActions, runtime: { pendingActions, tools } };
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
  assert.match(moved.body.error, /amman has new messages since this was asked/);
  assert.equal(h.pendingActions.get(first.result.actionId).status, "expired");

  const second = await h.runtime.tools.invoke("fleet_send_message", { key: "paseo:s.a", message: "Merge it" }, { sessionId: "s1" });
  h.rows.length = 0;
  const gone = await executeApprovedAction(h.runtime, second.result.actionId);
  assert.equal(gone.status, 410);
  assert.match(gone.body.error, /No fleet thread/);
  assert.equal(h.sent.length, 0);
});
