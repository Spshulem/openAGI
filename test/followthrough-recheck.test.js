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
    config: { enabled: false, mode: "propose", paseo: { enabled: true, only: false } },
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
