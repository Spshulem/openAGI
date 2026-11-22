import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FleetSupervisor } from "../src/fleet/supervisor.js";

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-followthrough-"));
  let now = Date.parse("2026-11-22T12:00:00.000Z");
  const outreach = [];
  const supervisor = new FleetSupervisor({
    dataDir,
    runtime: {
      outreach: {
        append(entry) { const item = { id: `out_${outreach.length + 1}`, status: "unseen", ...entry }; outreach.push(item); return item; },
        list() { return outreach.slice(); }
      },
      events: { emit() {} }
    },
    // Paseo off: the inventory is only the seeded threads, never the live daemon.
    config: { enabled: false, mode: "propose", paseo: { enabled: false } },
    deps: { now: () => now, executor: { deliver: async () => ({ status: "sent", route: "paseo-send" }) } }
  });
  return { supervisor, outreach, advance(seconds) { now += seconds * 1000; } };
}

test("Active Work accepts a valid one-shot recheck, rejects conflicting timing, and dedupes after restart", () => {
  const { supervisor } = fixture();
  const tracked = supervisor.trackWork({ project: "bb-recorder", theme: "Release", goal: "Verify the release follow-through", doneCriteria: "Release feed and update are verified" });
  const first = supervisor.scheduleActiveWorkRecheck(tracked.item.id, { delaySeconds: 60 });
  assert.equal(first.status, "scheduled");
  assert.throws(() => supervisor.scheduleActiveWorkRecheck(tracked.item.id, { delaySeconds: 60, intervalSeconds: 300 }), /exactly one one-shot/);
  const duplicate = supervisor.scheduleActiveWorkRecheck(tracked.item.id, { delaySeconds: 60 });
  assert.equal(duplicate.status, "reused");

  const restarted = new FleetSupervisor({ dataDir: supervisor.dataDir, runtime: { events: { emit() {} } }, config: { enabled: false, mode: "propose", paseo: { enabled: true, only: false } } });
  assert.equal(restarted.listActiveWorkRechecks({ status: "pending" }).length, 1);
  assert.equal(restarted.listActiveWorkRechecks({ status: "pending" })[0].id, first.recheck.id);
});

test("a late agent reply does not silently complete a pending recheck", async () => {
  const { supervisor, outreach, advance } = fixture();
  const threadKey = "paseo:bb:recorder";
  supervisor.knownThreads.set(threadKey, {
    key: threadKey, kind: "paseo", id: "recorder", title: "BB Recorder", workspace: "bb-recorder",
    agentStatus: "idle", lastActivityAt: "2026-11-22T11:59:00.000Z", lastAgentAt: "2026-11-22T11:59:00.000Z",
    lastAgentText: "I am still checking the release feed.", lastAgentFull: "I am still checking the release feed.",
    meta: { serverId: "bb", paseoCwd: "/work/bb-recorder" }, prRefs: []
  });
  const tracked = supervisor.trackWork({ project: "bb-recorder", theme: "Release", threadKey, goal: "Verify the release follow-through", doneCriteria: "Release feed and update are verified" });
  supervisor.scheduleActiveWorkRecheck(tracked.item.id, { delaySeconds: 30 });
  advance(31);
  supervisor.knownThreads.get(threadKey).lastAgentAt = "2026-11-22T12:00:31.000Z";
  supervisor.knownThreads.get(threadKey).lastActivityAt = "2026-11-22T12:00:31.000Z";
  supervisor.knownThreads.get(threadKey).lastAgentFull = "Late reply: release feed is still being checked.";
  await supervisor.scanActiveWork({ pageSize: 10, maxRepoChecks: 0, maxPromptsPerPass: 0, resetCursor: true });
  const item = supervisor.getActiveWork({ includeDone: true }).items.find((candidate) => candidate.id === tracked.item.id);
  assert.notEqual(item.followThroughState, "done");
  assert.equal(outreach.some((entry) => entry.type === "fleet-active-work-recheck"), false);
  assert.equal(supervisor.listActiveWorkRechecks({ status: "checked" }).length, 1);
});

test("a due recheck proactively emits one verified outcome or one actionable blocker", async () => {
  const { supervisor, outreach, advance } = fixture();
  const verified = supervisor.trackWork({ project: "bb-recorder", theme: "Release", goal: "Verify release", doneCriteria: "Release feed verified" });
  const blocked = supervisor.trackWork({ project: "QA", theme: "Validation", goal: "Finish QA", doneCriteria: "All QA items resolved", state: "blocked", remainingCount: 1 });
  supervisor.scheduleActiveWorkRecheck(verified.item.id, { delaySeconds: 30 });
  supervisor.scheduleActiveWorkRecheck(blocked.item.id, { delaySeconds: 30 });
  await supervisor.actActiveWork(verified.item.id, { op: "confirm_done" });
  advance(31);
  const pass = await supervisor.scanActiveWork({ pageSize: 10, maxRepoChecks: 0, maxPromptsPerPass: 0, resetCursor: true });
  assert.equal(pass.recheckNotification.type, "verified_outcome");
  assert.equal(outreach.filter((entry) => entry.type === "fleet-active-work-recheck").length, 1, "one bounded proactive notification per pass");
  assert.equal(supervisor.listActiveWorkRechecks({ status: "notified" }).length, 1);
  assert.equal(supervisor.listActiveWorkRechecks({ status: "checked" }).length, 1);
});

test("prose handoff is blocked while a permission prompt is pending", async () => {
  const { supervisor } = fixture();
  const threadKey = "paseo:bb:permission";
  supervisor.knownThreads.set(threadKey, {
    key: threadKey, kind: "paseo", id: "permission", title: "Permission chat", agentStatus: "idle",
    meta: { serverId: "bb", blockedOnOwner: true, pendingPermission: { id: "perm-1" } }, prRefs: []
  });
  supervisor.store.upsertQuestion({ kind: "prompt", dedupeKey: "permission:perm-1", title: "Permission required", options: ["Allow", "Deny"], threadKey, meta: { app: "paseo", paseoPermissionId: "perm-1" } });
  const result = await supervisor.sendOwnerMessage(threadKey, "Continue the release handoff and verify the feed.");
  assert.equal(result.delivery.status, "blocked");
  assert.equal(result.delivery.permissionRequired, true);
  assert.match(result.delivery.detail, /permission prompt pending/);
});

test("pruning keeps accepted pending rechecks and rejects scheduling when pending capacity is full", () => {
  const { supervisor } = fixture();
  const longRunning = supervisor.trackWork({ project: "bb-recorder", theme: "Release", goal: "Long follow-through", doneCriteria: "Verified next year" });
  const churn = supervisor.trackWork({ project: "QA", theme: "Validation", goal: "Short follow-through", doneCriteria: "Verified soon" });
  const kept = supervisor.scheduleActiveWorkRecheck(longRunning.item.id, { delaySeconds: 365 * 86400 });
  for (let i = 0; i < 400; i += 1) {
    const scheduled = supervisor.scheduleActiveWorkRecheck(churn.item.id, { delaySeconds: 30, evidenceMark: `mark-${i}` });
    supervisor.activeWork.state.rechecks.find((recheck) => recheck.id === scheduled.recheck.id).status = "checked";
  }
  const all = supervisor.listActiveWorkRechecks();
  assert.ok(all.length <= 400, "history stays bounded");
  assert.ok(all.some((recheck) => recheck.id === kept.recheck.id && recheck.status === "pending"), "the long-running pending recheck survives");

  for (const recheck of supervisor.activeWork.state.rechecks) recheck.status = "pending";
  supervisor.activeWork.state.rechecks = supervisor.activeWork.state.rechecks.slice(0, 400);
  while (supervisor.activeWork.state.rechecks.length < 400) {
    supervisor.activeWork.state.rechecks.push({ ...supervisor.activeWork.state.rechecks[0], id: `filler_${supervisor.activeWork.state.rechecks.length}`, evidenceMark: `filler-${supervisor.activeWork.state.rechecks.length}` });
  }
  assert.throws(() => supervisor.scheduleActiveWorkRecheck(churn.item.id, { delaySeconds: 30, evidenceMark: "one-too-many" }), /capacity is full/);
  assert.equal(supervisor.listActiveWorkRechecks({ status: "pending" }).length, 400);
});

test("the background tick runs a due recheck without a manual inventory scan", async () => {
  const { supervisor, advance } = fixture();
  const tracked = supervisor.trackWork({ project: "bb-recorder", theme: "Release", goal: "Verify release", doneCriteria: "Release feed verified" });
  supervisor.scheduleActiveWorkRecheck(tracked.item.id, { delaySeconds: 30 });
  await supervisor.tick({ reason: "interval" });
  assert.equal(supervisor.listActiveWorkRechecks({ status: "pending" }).length, 1, "not due yet");
  advance(31);
  await supervisor.tick({ reason: "interval" });
  assert.equal(supervisor.listActiveWorkRechecks({ status: "pending" }).length, 0, "the due recheck ran from the loop");
});

test("a remote supervisor forwards recheck scheduling through the node action endpoint", async () => {
  const { RemoteFleetSupervisor } = await import("../src/fleet/remote.js");
  const calls = [];
  const remote = new RemoteFleetSupervisor({ runtime: {}, nodeId: "node-1" });
  remote.request = async (method, url, body) => { calls.push({ method, url, body }); return { result: { ok: true, status: "scheduled" } }; };
  const result = await remote.scheduleActiveWorkRecheck("item_1", { delaySeconds: 60 });
  assert.deepEqual(result, { ok: true, status: "scheduled" });
  assert.deepEqual(calls, [{ method: "POST", url: "/fleet/api/active-work/item_1/act", body: { delaySeconds: 60, op: "schedule_recheck" } }]);
});

test("a due recheck re-evaluates its item even when the owner is outside the current page", async () => {
  const { supervisor, outreach, advance } = fixture();
  const ownerKey = "paseo:bb.owner";
  const otherKey = "paseo:bb.other";
  const thread = (key, id, text, status, workspace) => ({
    key, kind: "paseo", id, title: id, workspace, agentStatus: status,
    lastActivityAt: "2026-11-22T11:59:00.000Z", lastAgentAt: "2026-11-22T11:59:00.000Z",
    lastAgentText: text, lastAgentFull: text, meta: { serverId: "bb", paseoCwd: `/work/${workspace}` }, prRefs: []
  });
  supervisor.knownThreads.set(ownerKey, thread(ownerKey, "owner", "Blocked on credentials. 1 remaining.", "idle", "bb-recorder"));
  supervisor.knownThreads.set(otherKey, thread(otherKey, "other", "Working on docs.", "running", "docs-site"));
  const tracked = supervisor.trackWork({ project: "bb-recorder", theme: "Release", goal: "Verify release", doneCriteria: "Release feed verified" });
  assert.equal((await supervisor.actActiveWork(tracked.item.id, { op: "assign_orphan", targetKey: ownerKey })).ok, true);
  // Baseline pass with prompt budget, so no deferred prompt forces a later re-evaluation.
  await supervisor.scanActiveWork({ pageSize: 10, maxRepoChecks: 0, maxPromptsPerPass: 1, resetCursor: true });
  assert.equal(supervisor.activeWork.state.items[0].promptDeferred, false);
  assert.equal(supervisor.activeWork.state.items[0].remainingCount, 1, "baseline: the blocker count was recorded");

  const owner = supervisor.knownThreads.get(ownerKey);
  owner.agentStatus = "running";
  owner.lastAgentAt = owner.lastActivityAt = "2026-11-22T12:00:10.000Z";
  owner.lastAgentText = owner.lastAgentFull = "Credentials fixed; continuing the release check.";
  supervisor.scheduleActiveWorkRecheck(tracked.item.id, { delaySeconds: 30 });
  advance(31);

  // A one-session page that holds only the other thread.
  const { sessions } = await supervisor.activeWork._collectInventoryUniverse();
  supervisor.activeWork.state.inventoryCursor.offset = sessions.findIndex((session) => session.key === otherKey);
  const pass = await supervisor.scanActiveWork({ pageSize: 1, maxRepoChecks: 0, maxPromptsPerPass: 0 });
  assert.equal(pass.page.scannedSessions, 1);
  assert.ok(pass.evaluatedCount >= 1, "the due item was re-evaluated with fresh evidence");
  assert.notEqual(pass.recheckNotification?.type, "actionable_blocker");
  assert.equal(outreach.some((entry) => entry.type === "fleet-active-work-recheck"), false);
  const item = supervisor.getActiveWork({ includeDone: true }).items.find((candidate) => candidate.id === tracked.item.id);
  assert.notEqual(item.remainingCount, 1, "the obsolete transcript count was replaced");
});
