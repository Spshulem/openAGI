// B2.1 regression: user feedback must resolve outcomes on the turn it arrives.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface, DeterministicModelProvider, OutcomeStore } from "../src/index.js";

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("next user message in the same session resolves the prior turn as user-followup, not system-inferred", async () => {
  const runtime = createDurableRuntime({ dataDir: tmpDir("outcome-fb-"), modelProvider: new DeterministicModelProvider() });
  await runtime.agentHost.handleMessage({ channel: "local", from: "user", text: "what is on my calendar today?" });
  const pendingBefore = runtime.outcomes.pending().filter((o) => o.kind === "agent-reply");
  assert.equal(pendingBefore.length, 1, "turn 1 records one pending agent-reply outcome");
  const first = pendingBefore[0];

  await runtime.agentHost.handleMessage({ channel: "local", from: "user", text: "thanks, perfect!" });

  const resolved = runtime.outcomes.recent(10).find((o) => o.id === first.id);
  assert.equal(resolved.resolved, true, "prior outcome resolves on the followup turn itself");
  assert.equal(resolved.source, "user-followup");
  assert.equal(resolved.qualityScore, 0.85);
});

test("negative followup tone scores low", async () => {
  const runtime = createDurableRuntime({ dataDir: tmpDir("outcome-fb-neg-"), modelProvider: new DeterministicModelProvider() });
  await runtime.agentHost.handleMessage({ channel: "local", from: "user", text: "draft a reply to the vendor" });
  const first = runtime.outcomes.pending().filter((o) => o.kind === "agent-reply")[0];
  await runtime.agentHost.handleMessage({ channel: "local", from: "user", text: "wrong, that is broken" });
  const resolved = runtime.outcomes.recent(10).find((o) => o.id === first.id);
  assert.equal(resolved.source, "user-followup");
  assert.equal(resolved.qualityScore, 0.2);
});

test("authenticated outcome feedback targets exact rows and overrides inferred scores", async () => {
  const runtime = createDurableRuntime({ dataDir: tmpDir("outcome-route-") });
  const outcome = runtime.outcomes.record({ kind: "agent-reply", refId: null, sessionId: "private-session" });
  runtime.outcomes.resolve(outcome.id, 0.7, "system-inferred", "heuristic score");
  const app = createHostedInterface(runtime, { port: 0, authToken: "test-outcome-token" });
  const address = await app.listen();
  const submit = (id, body, authorized = true) => fetch(`${address.url}/outcomes/${encodeURIComponent(id)}/feedback`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorized ? { authorization: "Bearer test-outcome-token" } : {})
    },
    body: JSON.stringify(body)
  });
  try {
    const denied = await submit(outcome.id, { qualityScore: 0.1 }, false);
    assert.equal(denied.status, 401);
    assert.equal(runtime.outcomes.outcomes.get(outcome.id).source, "system-inferred");

    const accepted = await submit(outcome.id, { qualityScore: 0.1, note: "Direct correction" });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), {
      id: outcome.id,
      resolved: true,
      qualityScore: 0.1,
      source: "explicit-rating",
      resolvedAt: runtime.outcomes.outcomes.get(outcome.id).resolvedAt
    });
    assert.equal(runtime.outcomes.outcomes.get(outcome.id).metadata.resolutionNote, "Direct correction");

    assert.equal((await submit(outcome.id, { qualityScore: 2 })).status, 400);
    assert.equal((await submit(outcome.id, { qualityScore: 0.5, note: "x".repeat(2001) })).status, 400);
    assert.equal((await submit("missing-outcome", { qualityScore: 0.5 })).status, 404);
  } finally {
    await app.close();
  }
});

test("synthetic autopilot housekeeping does not create a quality outcome", async () => {
  const runtime = createDurableRuntime({ dataDir: tmpDir("outcome-fb-ap-"), modelProvider: new DeterministicModelProvider() });
  await runtime.agentHost.handleMessage({ channel: "autopilot", from: "autopilot", origin: "autopilot", sessionId: "autopilot:agent-pulse", text: "Pulse: anything to do?" });
  assert.equal(runtime.outcomes.pending().some((o) => o.kind === "autopilot-fire"), false,
    "a pulse with no successful side-effecting action is housekeeping, not an outcome");
  await runtime.agentHost.handleMessage({ channel: "autopilot", from: "autopilot", origin: "autopilot", sessionId: "autopilot:agent-pulse", text: "Pulse: anything to do?" });
  assert.equal(runtime.outcomes.recent(10).some((o) => o.kind === "autopilot-fire"), false,
    "repeated quiet pulses do not inflate the outcome scorecard");
});

test("autopilot outcomes require a successful side-effecting tool", async () => {
  const providerFor = (name) => ({
    isConfigured: () => true,
    model: "stub",
    generate: async () => ({
      id: `response-${name}`,
      provider: "stub",
      model: "stub",
      text: "done",
      toolCalls: [{ name, arguments: {}, result: { ok: true } }]
    })
  });

  const readOnlyRuntime = createDurableRuntime({
    dataDir: tmpDir("outcome-fb-ap-read-"),
    modelProvider: providerFor("list_tasks")
  });
  await readOnlyRuntime.agentHost.handleMessage({
    channel: "autopilot",
    from: "autopilot",
    origin: "autopilot",
    sessionId: "autopilot:read-only",
    text: "Review current state."
  });
  assert.equal(readOnlyRuntime.outcomes.recent(10).some((o) => o.kind === "autopilot-fire"), false,
    "successful observation-only work must not inflate the quality scorecard");

  const mutatingRuntime = createDurableRuntime({
    dataDir: tmpDir("outcome-fb-ap-write-"),
    modelProvider: providerFor("add_task")
  });
  await mutatingRuntime.agentHost.handleMessage({
    channel: "autopilot",
    from: "autopilot",
    origin: "autopilot",
    sessionId: "autopilot:write",
    text: "Carry out the approved maintenance."
  });
  const recorded = mutatingRuntime.outcomes.recent(10).filter((o) => o.kind === "autopilot-fire");
  assert.equal(recorded.length, 1, "successful state-changing work remains measurable");
  assert.deepEqual(recorded[0].toolCalls, [{ name: "add_task", ok: true }]);
});

test("an autopilot tool waiting for approval is not recorded as completed work", async () => {
  const runtime = createDurableRuntime({
    dataDir: tmpDir("outcome-fb-ap-approval-"),
    modelProvider: {
      isConfigured: () => true,
      model: "stub",
      generate: async () => ({
        id: "response-awaiting",
        provider: "stub",
        model: "stub",
        text: "Waiting for approval.",
        toolCalls: [{
          name: "add_task",
          arguments: { title: "Do not create yet" },
          result: { ok: true, result: { status: "awaiting_confirmation", actionId: "act_pending" } }
        }]
      })
    }
  });
  await runtime.agentHost.handleMessage({
    channel: "autopilot",
    from: "autopilot",
    origin: "autopilot",
    sessionId: "autopilot:approval",
    text: "Propose work that needs approval."
  });
  assert.equal(runtime.outcomes.recent(10).some((o) => o.kind === "autopilot-fire"), false);
});

test("sensitive tool arguments are redacted from durable chat transcripts", async () => {
  const secretText = "a typed value that must never land in history";
  const runtime = createDurableRuntime({
    dataDir: tmpDir("outcome-fb-sensitive-"),
    modelProvider: {
      isConfigured: () => true,
      model: "stub",
      generate: async () => ({
        id: "response-sensitive",
        provider: "stub",
        model: "stub",
        text: "Typed the requested value.",
        toolCalls: [{
          name: "sensitive_test_tool",
          arguments: { text: secretText, target: "field" },
          result: { ok: true, result: { done: true } }
        }]
      })
    }
  });
  runtime.tools.register({
    name: "sensitive_test_tool",
    metadata: { sensitiveArguments: ["text"] },
    handler: async () => ({ done: true })
  });
  const turn = await runtime.agentHost.handleMessage({
    channel: "local",
    from: "user",
    text: "type the private value"
  });
  const session = runtime.agentHost.store.getSession(turn.session.id);
  const stored = session.messages.at(-1).metadata.toolCalls[0].arguments;
  assert.equal(stored.target, "field");
  assert.deepEqual(stored.text, {
    redacted: true,
    characterCount: [...secretText].length,
    byteCount: Buffer.byteLength(secretText, "utf8")
  });
  assert.doesNotMatch(JSON.stringify(session), new RegExp(secretText));
});

test("resolveSweep holds fresh cron/autopilot fires open for the followup window", () => {
  const store = new OutcomeStore({ dir: tmpDir("sweep-window-") });
  const o = store.record({ kind: "autopilot-fire", sessionId: "autopilot:agent-pulse", toolCalls: [{ name: "list_tasks", ok: true }] });

  const early = store.resolveSweep();
  assert.equal(early.length, 0, "a fresh fire must stay pending so feedback can land first");
  assert.equal(store.outcomes.get(o.id).resolved, false);

  const late = store.resolveSweep({ now: new Date(Date.now() + 31 * 60 * 1000) });
  assert.equal(late.length, 1, "past the window the sweep still scores productivity");
  assert.equal(late[0].source, "system-inferred");
  assert.equal(store.outcomes.get(o.id).qualityScore, 0.7);
});

test("resolveSweep scores an approved local tool call after the feedback window", () => {
  const store = new OutcomeStore({ dir: tmpDir("sweep-approved-tool-") });
  const outcome = store.record({
    kind: "tool-call",
    refId: "act-approved",
    sessionId: "session-local",
    toolCalls: [{ name: "add_task", ok: true }],
    metadata: { approvedExecution: true }
  });

  const early = store.resolveSweep();
  assert.equal(early.length, 0);
  const late = store.resolveSweep({ now: new Date(Date.now() + 31 * 60 * 1000) });
  assert.equal(late.length, 1);
  assert.equal(store.outcomes.get(outcome.id).qualityScore, 0.7);
  assert.equal(store.outcomes.get(outcome.id).source, "system-inferred");
});
