import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FleetSupervisor } from "../src/fleet/supervisor.js";
import { createFleetCapability, RemoteFleetSupervisor } from "../src/fleet/remote.js";
import { OutreachStore } from "../src/outreach-store.js";

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

test("a free-text Paseo question accepts the owner's prose answer", async () => {
  const { supervisor } = fixture();
  const threadKey = "paseo:bb:question";
  supervisor.knownThreads.set(threadKey, {
    key: threadKey, kind: "paseo", id: "question", title: "Question chat", agentStatus: "idle",
    meta: {
      serverId: "bb",
      pendingCard: { requestId: "question-1", items: [{ freeText: true, question: "Which directory?" }] }
    },
    prRefs: []
  });
  const delivered = [];
  supervisor.executor.deliver = async (input) => {
    delivered.push(input);
    return { status: "sent", route: "paseo-send" };
  };
  const result = await supervisor.sendOwnerMessage(threadKey, "Use /work/project for the release handoff.");
  assert.equal(result.delivery.status, "sent");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].message, "Use /work/project for the release handoff.");
});

// A surfaced Paseo card keeps its requestId as meta.paseoPermissionId (cardIntent).
function freeTextQuestionThread(supervisor, threadKey, { cardId }) {
  supervisor.knownThreads.set(threadKey, {
    key: threadKey, kind: "paseo", id: threadKey.split(":").at(-1), title: "Question chat", agentStatus: "idle",
    meta: { serverId: "bb", pendingCard: { app: "paseo", cardId, requestId: cardId, items: [{ itemId: `${cardId}:0`, freeText: true, question: "Which directory?", options: [] }] } },
    prRefs: []
  });
  supervisor.store.upsertQuestion({
    kind: "agent-card", dedupeKey: `card:${threadKey}:${cardId}:0`, title: "Question chat: Which directory?", options: ["open thread"], threadKey,
    meta: { app: "paseo", cardId, itemId: `${cardId}:0`, itemIds: [`${cardId}:0`], freeText: "1", multiSelect: "0", labels: [], paseoPermissionId: cardId }
  });
}

test("a surfaced free-text Paseo question card still accepts the owner's prose answer", async () => {
  const { supervisor } = fixture();
  const threadKey = "paseo:bb:surfaced";
  freeTextQuestionThread(supervisor, threadKey, { cardId: "question-2" });
  const delivered = [];
  supervisor.executor.deliver = async (input) => { delivered.push(input); return { status: "sent", route: "paseo-send" }; };
  const result = await supervisor.sendOwnerMessage(threadKey, "Use /work/project.");
  assert.equal(result.delivery.status, "sent");
  assert.equal(result.delivery.permissionRequired, undefined);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].message, "Use /work/project.");
});

test("a surfaced Paseo permission card still blocks prose", async () => {
  const { supervisor } = fixture();
  const threadKey = "paseo:bb:permcard";
  freeTextQuestionThread(supervisor, threadKey, { cardId: "permission-9" });
  const delivered = [];
  supervisor.executor.deliver = async (input) => { delivered.push(input); return { status: "sent", route: "paseo-send" }; };
  const result = await supervisor.sendOwnerMessage(threadKey, "Go ahead.");
  assert.equal(result.delivery.status, "blocked");
  assert.equal(result.delivery.permissionRequired, true);
  assert.equal(delivered.length, 0);
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

test("a pending recheck's verified item survives tracked-work churn past the cap", async () => {
  const { supervisor, outreach, advance } = fixture();
  const verified = supervisor.trackWork({ project: "bb-recorder", theme: "Release", goal: "Verify release", doneCriteria: "Release feed verified" });
  supervisor.scheduleActiveWorkRecheck(verified.item.id, { delaySeconds: 30 });
  await supervisor.actActiveWork(verified.item.id, { op: "confirm_done" });
  for (let i = 0; i < 405; i += 1) supervisor.trackWork({ project: "Churn", theme: "Load", goal: `Churn goal ${i}`, doneCriteria: `Churn ${i} done` });
  assert.ok(supervisor.activeWork.state.items.length <= 400, "the tracked-work cap still holds");
  assert.ok(supervisor.activeWork.state.items.some((item) => item.id === verified.item.id), "the recheck's item was not evicted");
  advance(31);
  const pass = await supervisor.scanActiveWork({ pageSize: 10, maxRepoChecks: 0, maxPromptsPerPass: 0, resetCursor: true });
  assert.equal(pass.recheckNotification?.type, "verified_outcome");
  assert.equal(pass.recheckNotification?.itemId, verified.item.id);
  assert.equal(outreach.filter((entry) => entry.type === "fleet-active-work-recheck").length, 1);
  assert.equal(supervisor.listActiveWorkRechecks({ status: "notified" }).length, 1);
});

test("a recheck notice on a coding node reaches the hosted hub's outreach exactly once", async () => {
  const { supervisor, outreach, advance } = fixture();
  const verified = supervisor.trackWork({ project: "bb-recorder", theme: "Release", goal: "Verify release", doneCriteria: "Release feed verified" });
  const scheduled = supervisor.scheduleActiveWorkRecheck(verified.item.id, { delaySeconds: 30 });
  await supervisor.actActiveWork(verified.item.id, { op: "confirm_done" });
  advance(31);
  const pass = await supervisor.scanActiveWork({ pageSize: 10, maxRepoChecks: 0, maxPromptsPerPass: 0, resetCursor: true });
  assert.equal(pass.recheckNotification?.type, "verified_outcome");
  assert.equal(outreach.filter((entry) => entry.type === "fleet-active-work-recheck").length, 1, "the node's own feed has it");

  const capability = createFleetCapability(supervisor);
  const hubOutreach = new OutreachStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "bb-hub-outreach-")) });
  const hub = new RemoteFleetSupervisor({
    nodeId: "coding-node",
    runtime: {
      outreach: hubOutreach,
      events: { emit() {} },
      nodeCapabilities: { dispatch: async (_nodeId, _cap, op, payload) => capability.invoke(op, payload) }
    }
  });
  const onHub = () => hubOutreach.list().filter((item) => item.type === "fleet-active-work-recheck");
  await hub.refresh();
  assert.equal(onHub().length, 1);
  assert.equal(onHub()[0].sourceRef.id, scheduled.recheck.id);
  assert.match(onHub()[0].title, /Follow-through verified/);
  await hub.refresh();
  assert.equal(onHub().length, 1, "a second refresh does not post it again");
  hubOutreach.resolve(onHub()[0].id, "dismissed", { status: "dismissed" });
  await hub.refresh();
  assert.equal(onHub().length, 1, "a dismissed notice stays dismissed");
  assert.equal(onHub()[0].status, "dismissed");
});

// Review fix (#369): a due recheck that finds the blocker its item was
// already prompted about reuses that open prompt on the node; the hub, which
// mirrors the same prompt, must not add a second entry for it.
test("a blocker recheck folded into an open prompt is one hub entry, not two", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-followthrough-"));
  let now = Date.parse("2026-11-22T12:00:00.000Z");
  const nodeOutreach = new OutreachStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "bb-node-outreach-")) });
  const supervisor = new FleetSupervisor({
    dataDir,
    runtime: { outreach: nodeOutreach, events: { emit() {} } },
    config: { enabled: false, mode: "propose", paseo: { enabled: false } },
    deps: { now: () => now, executor: { deliver: async () => ({ status: "sent", route: "paseo-send" }) } }
  });
  const ownerKey = "paseo:bb.owner";
  const text = "Blocked on credentials. 1 remaining.";
  supervisor.knownThreads.set(ownerKey, {
    key: ownerKey, kind: "paseo", id: "owner", title: "owner", workspace: "bb-recorder", agentStatus: "idle",
    lastActivityAt: "2026-11-22T11:59:00.000Z", lastAgentAt: "2026-11-22T11:59:00.000Z",
    lastAgentText: text, lastAgentFull: text, meta: { serverId: "bb", paseoCwd: "/work/bb-recorder" }, prRefs: []
  });
  const tracked = supervisor.trackWork({ project: "bb-recorder", theme: "Release", goal: "Verify release", doneCriteria: "Release feed verified" });
  assert.equal((await supervisor.actActiveWork(tracked.item.id, { op: "assign_orphan", targetKey: ownerKey })).ok, true);
  await supervisor.scanActiveWork({ pageSize: 10, maxRepoChecks: 0, maxPromptsPerPass: 1, resetCursor: true });
  const prompted = supervisor.activeWork.state.items.find((item) => item.id === tracked.item.id);
  assert.ok(prompted.outreachId, "the blocker was prompted on the node");
  supervisor.scheduleActiveWorkRecheck(tracked.item.id, { delaySeconds: 30 });
  now += 31_000;
  const pass = await supervisor.scanActiveWork({ pageSize: 10, maxRepoChecks: 0, maxPromptsPerPass: 0, resetCursor: true });
  assert.equal(pass.recheckNotification?.type, "actionable_blocker");
  assert.equal(pass.recheckNotification?.reusedPrompt, true);
  assert.equal(pass.recheckNotification?.outreachId, prompted.outreachId, "the node reused its open prompt");

  const capability = createFleetCapability(supervisor);
  const hubOutreach = new OutreachStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "bb-hub-outreach-")) });
  const hub = new RemoteFleetSupervisor({
    nodeId: "coding-node",
    runtime: {
      outreach: hubOutreach,
      events: { emit() {} },
      nodeCapabilities: { dispatch: async (_nodeId, _cap, op, payload) => capability.invoke(op, payload) }
    }
  });
  await hub.refresh();
  await hub.refresh();
  const forItem = hubOutreach.list().filter((item) => ["unseen", "seen"].includes(item.status)
    && (item.sourceRef?.itemId === tracked.item.id || item.sourceRef?.id === tracked.item.id));
  assert.equal(forItem.length, 1, "one hub entry for the blocker");
  assert.equal(forItem[0].sourceRef.kind, "active-work");
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

test("a due recheck waits for its repo's PR evidence instead of reporting cached CI", async () => {
  const { supervisor, outreach, advance } = fixture();
  const repos = ["acme/one", "acme/two", "acme/three"];
  const inspected = [];
  supervisor.inspectRepoStatus = async ({ repo }) => {
    inspected.push(repo);
    return { openPrs: [{ ref: `${repo}#1`, state: "OPEN", ciState: "SUCCESS", mergeState: "CLEAN", updatedAt: "2026-11-22T12:00:20.000Z" }] };
  };
  for (const repo of repos) {
    // Cached evidence says CI is failing; the live inspection says green.
    supervisor.lastPrs.set(`${repo}#1`, { ref: `${repo}#1`, state: "OPEN", ciState: "FAILURE", ci: { state: "FAILURE" }, mergeState: "CLEAN" });
    const tracked = supervisor.trackWork({ project: repo.split("/")[1], theme: "Release", repo, prRef: `${repo}#1`, goal: `Ship ${repo}`, doneCriteria: "PR merged" });
    supervisor.scheduleActiveWorkRecheck(tracked.item.id, { delaySeconds: 30 });
  }
  advance(31);

  const first = await supervisor.scanActiveWork({ pageSize: 10, maxRepoChecks: 2, maxPromptsPerPass: 0, resetCursor: true });
  assert.equal(first.repoChecksRun, 2);
  assert.equal(supervisor.listActiveWorkRechecks({ status: "pending" }).length, 1, "the uninspected repo's recheck stays pending");
  const second = await supervisor.scanActiveWork({ pageSize: 10, maxRepoChecks: 2, maxPromptsPerPass: 0 });
  assert.deepEqual([...new Set(inspected)].sort(), [...repos].sort(), "every due repo is inspected");
  assert.equal(supervisor.listActiveWorkRechecks({ status: "pending" }).length, 0);
  for (const pass of [first, second]) assert.notEqual(pass.recheckNotification?.type, "actionable_blocker");
  assert.equal(outreach.some((entry) => entry.type === "fleet-active-work-recheck"), false);
});
