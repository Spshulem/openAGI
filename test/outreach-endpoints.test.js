// test/outreach-endpoints.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

async function bootApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "out-ep-"));
  process.env.OPENAGI_AUTH_TOKEN = ""; // local, no auth for the test
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0 });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  return { runtime, app, base, dataDir };
}

test("GET /outreach/feed?since=N returns items after the cursor", async () => {
  const { runtime, app, base } = await bootApp();
  runtime.outreach.append({ type: "draft", title: "A" });
  const b = runtime.outreach.append({ type: "draft", title: "B" });
  runtime.outreach.append({ type: "draft", title: "C" });
  const res = await fetch(`${base}/outreach/feed?since=${b.seq}`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(json.items.map((i) => i.title), ["C"]);
  assert.equal(json.cursor, runtime.outreach.nextSeq - 1);
  await app.close?.();
});

test("GET /outreach/digest returns the current rollup or null", async () => {
  const { runtime, app, base } = await bootApp();
  runtime.outreach.append({ type: "draft", title: "A" });
  const res = await fetch(`${base}/outreach/digest`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.ok("digest" in json);
  await app.close?.();
});

test("POST /outreach/:id/act approves a draft via delegation and is idempotent", async () => {
  const { runtime, app, base } = await bootApp();
  const draft = runtime.drafts.add({ kind: "reply", title: "Reply", body: "hello" });
  const item = runtime.outreach.append({
    type: "draft", sourceRef: { kind: "draft", id: draft.id },
    title: "Reply", needsDecision: false, actions: ["approve", "dismiss"]
  });
  const res = await fetch(`${base}/outreach/${item.id}/act`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "approve" })
  });
  assert.equal(res.status, 200);
  assert.equal(runtime.drafts.get(draft.id).status, "approved");
  assert.equal(runtime.outreach.get(item.id).status, "acted");

  const res2 = await fetch(`${base}/outreach/${item.id}/act`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "dismiss" })
  });
  assert.equal(res2.status, 200);
  assert.equal(runtime.outreach.get(item.id).decision.action, "approve");
  await app.close?.();
});

// Code-review finding: an unhandled sourceRef.kind (or a typo'd action)
// silently fell through applyOutreachAction's switch default and was
// recorded as a successful "acted" item instead of erroring — indistinguishable
// from a real successful action in the outreach history.
test("POST /outreach/:id/act errors on an unhandled item kind instead of silently succeeding", async () => {
  const { runtime, app, base } = await bootApp();
  // cron-interrupted items declare only "dismiss" and have no case in the
  // switch — posting anything else must error, not silently "succeed".
  const item = runtime.outreach.append({
    type: "suggestion", sourceRef: { kind: "cron-job", id: "weekly-harsh-review" },
    title: "Scheduled job interrupted mid-run: Weekly harsh review",
    needsDecision: false, actions: ["dismiss"]
  });
  const res = await fetch(`${base}/outreach/${item.id}/act`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "approve" })
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.match(json.error, /cron-job/);
  assert.equal(runtime.outreach.get(item.id).status, "error");
  await app.close?.();
});

test("pending-action outreach returns conflict when another approval surface already claimed it", async () => {
  const { runtime, app, base } = await bootApp();
  runtime.tools.register({
    name: "outreach_claim_race",
    needsConfirmation: true,
    handler: async () => ({ ok: true })
  });
  const queued = await runtime.tools.invoke("outreach_claim_race", {}, { sessionId: "race-chat" });
  const actionId = queued.result.actionId;
  const item = runtime.outreach.list().find((candidate) => candidate.sourceRef?.id === actionId);
  assert.ok(item, "the approval is mirrored into durable outreach");

  assert.ok(runtime.pendingActions.claimForExecution(actionId), "another surface claims execution first");
  const res = await fetch(`${base}/outreach/${item.id}/act`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "do" })
  });
  const json = await res.json();
  assert.equal(res.status, 409);
  assert.match(json.error, /already executing/);
  assert.notEqual(runtime.outreach.get(item.id).status, "acted", "an in-flight execution is not reported as completed");
  await app.close?.();
});

test("stale pending-action outreach returns conflict for an already terminal approval", async () => {
  const { runtime, app, base } = await bootApp();
  const action = runtime.pendingActions.enqueue({ toolName: "already_done", summary: "Already done" });
  runtime.pendingActions.decide(action.id, { decision: "approve", decidedBy: "user", result: { ok: true } });
  // Model a durable mirror that was written after the resolution event (for
  // example, a restored older outreach snapshot). It must not replay work or
  // turn a no-op into a successful action.
  const stale = runtime.outreach.append({
    type: "pending-action",
    sourceRef: { kind: "pending-action", id: action.id },
    title: "Already done",
    needsDecision: true,
    actions: ["do", "dismiss"]
  });
  const res = await fetch(`${base}/outreach/${stale.id}/act`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "do" })
  });
  assert.equal(res.status, 409);
  assert.notEqual(runtime.outreach.get(stale.id).status, "acted");
  await app.close?.();
});

test("pending-action outreach becomes acted only after confirmed execution succeeds", async () => {
  const { runtime, app, base } = await bootApp();
  let release;
  let markStarted;
  const executing = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  runtime.tools.register({
    name: "outreach_slow_success",
    needsConfirmation: true,
    handler: async () => { markStarted(); await executing; return { completed: true }; }
  });
  const queued = await runtime.tools.invoke("outreach_slow_success", {}, { sessionId: "success-chat" });
  const item = runtime.outreach.list().find((candidate) => candidate.sourceRef?.id === queued.result.actionId);
  const request = fetch(`${base}/outreach/${item.id}/act`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "do" })
  });

  // Let the route claim the approval and enter the handler. While the side
  // effect is still running, the user-facing item must remain unresolved.
  await started;
  assert.equal(runtime.pendingActions.get(queued.result.actionId).status, "executing");
  assert.notEqual(runtime.outreach.get(item.id).status, "acted");
  release();
  const res = await request;
  assert.equal(res.status, 200);
  assert.equal(runtime.outreach.get(item.id).status, "acted");
  await app.close?.();
});

test("failed confirmed outreach execution remains an honest error", async () => {
  const { runtime, app, base } = await bootApp();
  runtime.tools.register({
    name: "outreach_confirmed_failure",
    needsConfirmation: true,
    handler: async () => { throw new Error("synthetic execution failure"); }
  });
  const queued = await runtime.tools.invoke("outreach_confirmed_failure", {}, { sessionId: "failure-chat" });
  const item = runtime.outreach.list().find((candidate) => candidate.sourceRef?.id === queued.result.actionId);
  const res = await fetch(`${base}/outreach/${item.id}/act`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "do" })
  });
  assert.equal(res.status, 400);
  assert.equal(runtime.pendingActions.get(queued.result.actionId).error, "synthetic execution failure");
  assert.equal(runtime.outreach.get(item.id).status, "error");
  assert.equal(runtime.outreach.get(item.id).error, "synthetic execution failure");
  await app.close?.();
});

test("startup recovery reconciles executing approvals with their linked outreach", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "out-interrupted-"));
  const seedRuntime = createDurableRuntime({ dataDir });
  // Constructing the interface attaches the outreach mapper; listening is not
  // required to persist the mirror generated by enqueue().
  createHostedInterface(seedRuntime, { host: "127.0.0.1", port: 0 });
  const action = seedRuntime.pendingActions.enqueue({
    toolName: "interrupted_side_effect",
    summary: "Interrupted side effect",
    context: { sessionId: "restart-chat" }
  });
  const outreach = seedRuntime.outreach.list().find((candidate) => candidate.sourceRef?.id === action.id);
  assert.ok(outreach);
  assert.ok(seedRuntime.pendingActions.claimForExecution(action.id));

  const recoveredRuntime = createDurableRuntime({ dataDir });
  assert.equal(recoveredRuntime.pendingActions.get(action.id).status, "interrupted");
  // bindEvents flushes the constructor-time recovery event after the hosted
  // listener exists, resolving the already-durable outreach copy.
  createHostedInterface(recoveredRuntime, { host: "127.0.0.1", port: 0 });
  const reconciled = recoveredRuntime.outreach.get(outreach.id);
  assert.equal(reconciled.status, "error");
  assert.match(reconciled.error, /interrupted by a daemon restart/);
});

test("POST /outreach/:id/act on unknown id returns 404", async () => {
  const { app, base } = await bootApp();
  const res = await fetch(`${base}/outreach/nope/act`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "approve" })
  });
  assert.equal(res.status, 404);
  await app.close?.();
});

test("POST /outreach/:id/reply forwards the text to the agent with item context", async () => {
  const { runtime, app, base } = await bootApp();
  const item = runtime.outreach.append({ type: "stalled-task", sourceRef: { kind: "task", id: "task_9" }, title: "Stalled: X", needsDecision: true, actions: ["close", "keep"] });
  let lastForward = null;
  const fakeChannels = { handleLocalMessage: async (m) => { lastForward = m; return { reply: "ok" }; } };
  app.__setChannels(fakeChannels);
  const res = await fetch(`${base}/outreach/${item.id}/reply`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "close it and remind me Friday" })
  });
  assert.equal(res.status, 200);
  assert.match(lastForward.text, /close it and remind me Friday/);
  assert.match(lastForward.text, /Stalled: X/);
  await app.close?.();
});

test("GET /outreach/digest is read-only (no new digest item, queue not consumed)", async () => {
  const { runtime, app, base } = await bootApp();
  runtime.outreach.append({ type: "draft", title: "D1" });
  await (await fetch(`${base}/outreach/digest`)).json();
  await (await fetch(`${base}/outreach/digest`)).json();
  assert.equal(runtime.outreach.list().filter((i) => i.type === "digest").length, 0, "GET must not append a digest");
  assert.equal(runtime.outreach.list({ status: "unseen" }).filter((i) => i.type === "draft").length, 1, "GET must not markSeen the queue");
  await app.close?.();
});

test("POST /outreach/:id/act on a clarification answers it and resolves the task", async () => {
  const { runtime, app, base } = await bootApp();
  // Seed a task + a clarification gating it (real ClarificationStore.add API).
  const task = runtime.tasks.add({ title: "Did I finish X?" });
  const clar = runtime.clarifications.add({
    taskId: task.id,
    question: "Finish X?",
    proposedAction: "complete",
    confidence: 0.5,
    sources: ["ocr"]
  });
  const item = runtime.outreach.append({ type: "clarification", sourceRef: { kind: "clarification", id: clar.id }, title: "Finish X?", needsDecision: true, actions: ["yes","no","in_progress","dropped"] });
  const res = await fetch(`${base}/outreach/${item.id}/act`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "yes" }) });
  assert.equal(res.status, 200);
  assert.equal(runtime.clarifications.get(clar.id).status, "answered");
  await app.close?.();
});

test("GET /outreach/config includes the destination", async () => {
  const { app, base } = await bootApp();
  const res = await fetch(`${base}/outreach/config`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.destination, "mac");
  await app.close?.();
});
