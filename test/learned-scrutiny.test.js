// Optional learned scrutiny score (OPENAGI_LEARNED_SCRUTINY).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDurableRuntime, DeterministicModelProvider } from "../src/index.js";
import { DirectionalAdaptiveScrutiny } from "../src/directional-adaptive-scrutiny.js";
import { ScrutinyPanel } from "../src/scrutiny-panel.js";
import { FIXED_SCRUTINY_ARGS, normalize } from "./support/learned-scores-scenario.js";
import { LEARNED_ENV_UNSET, fakeScoringService, withEnv } from "./support/fake-scoring-service.js";

const GOLDEN = JSON.parse(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "learned-scores-inert.json"), "utf8"));

// The risk rule: risk >= 0.8 with no memories always asks.
const RISKY = { risk: 0.9, novelty: 0, repetition: 0.2 };

function tempDir(t, prefix = "openagi-learned-scrutiny-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeRuntime(t, modelClient) {
  return createDurableRuntime({
    dataDir: tempDir(t),
    ...(modelClient ? { modelClient } : {}),
    modelProvider: new DeterministicModelProvider(),
    autoConnectMcp: false
  });
}

function signal(extra = {}) {
  return {
    id: `sig_${Math.random().toString(16).slice(2)}`,
    source: "test",
    type: "message",
    summary: "check the quarterly numbers",
    content: "check the quarterly numbers",
    citations: ["a", "b"],
    urgency: 0.45,
    impact: 0.5,
    risk: 0.2,
    novelty: 0.3,
    repetition: 0.2,
    ...extra
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test("off: evaluate output is identical to before for a fixed signal", () => {
  for (const overrides of [undefined, {}, { learnedValue: null }, { learnedValue: undefined }]) {
    const args = { ...structuredClone(FIXED_SCRUTINY_ARGS), ...(overrides ? { overrides } : {}) };
    assert.deepEqual(normalize(new DirectionalAdaptiveScrutiny().evaluate(args)), GOLDEN.scrutiny.single);
    assert.deepEqual(normalize(new ScrutinyPanel().evaluate(structuredClone(args))), GOLDEN.scrutiny.panel);
  }
});

test("a learned value replaces the score, keeps the rule score beside it, and the risk rule still asks", () => {
  const args = { signal: signal(RISKY), workflow: null, memories: [], context: {}, overrides: { learnedValue: 0.9 } };
  const single = new DirectionalAdaptiveScrutiny().evaluate(args);
  const ruleOnly = new DirectionalAdaptiveScrutiny().evaluate({ ...args, overrides: {} });
  assert.equal(single.action, "ask");
  assert.equal(single.score, 0.9);
  assert.equal(single.ruleScore, ruleOnly.score);
  assert.deepEqual(single.dimensions, ruleOnly.dimensions);

  const panel = new ScrutinyPanel().evaluate(args);
  const panelRule = new ScrutinyPanel().evaluate({ ...args, overrides: {} });
  assert.equal(panel.action, "ask");
  assert.equal(panel.score, 0.9);
  assert.equal(panel.ruleScore, panelRule.score);
});

test("a learned value is clamped and other overrides still apply", () => {
  const judge = new DirectionalAdaptiveScrutiny();
  const base = { signal: signal(), workflow: null, memories: [], context: {} };
  assert.equal(judge.evaluate({ ...base, overrides: { learnedValue: 1.7 } }).score, 1);
  assert.equal(judge.evaluate({ ...base, overrides: { learnedValue: -0.4 } }).score, 0);
  const raised = judge.evaluate({ ...base, overrides: { learnedValue: 0.8, act: 0.9 } });
  assert.equal(raised.action, "ask", "the raised act bar still holds against a learned score");
});

test("processSignal: live with a usable head uses the value, and the risk rule still holds", async (t) => {
  const service = fakeScoringService(tempDir(t));
  const runtime = makeRuntime(t, service.client);
  await service.client.health();
  await withEnv({ ...LEARNED_ENV_UNSET, OPENAGI_LEARNED_SCRUTINY: "live" }, () => {
    const risky = runtime.processSignal(signal({ ...RISKY, learned: { mode: "live", value: 0.9, version: "v1" } }), { isolatedContext: true });
    assert.equal(risky.scrutiny.score, 0.9);
    assert.equal(risky.scrutiny.action, "ask");
    assert.equal(typeof risky.scrutiny.ruleScore, "number");
    assert.equal(risky.scrutiny.shadowLearnedValue, 0.9);

    const plain = runtime.processSignal(signal({ learned: { mode: "live", value: 0.95, version: "v1" } }), { isolatedContext: true });
    assert.ok(Math.abs(plain.scrutiny.score - 0.95) < 1e-9, `panel mean of three equal learned scores (${plain.scrutiny.score})`);
    assert.ok(plain.scrutiny.ruleScore < 0.9);
  });
});

test("processSignal: live with a null value, or an unusable head, falls back to the rule score", async (t) => {
  const health = { ok: true, version: "v1", heads: { value: { labels: 10, auroc: 0.5, usable: false } }, thresholds: {} };
  for (const [routes, value] of [[{}, null], [{ "GET /health": health }, 0.9]]) {
    const service = fakeScoringService(tempDir(t), routes);
    const runtime = makeRuntime(t, service.client);
    await service.client.health();
    await withEnv({ ...LEARNED_ENV_UNSET, OPENAGI_LEARNED_SCRUTINY: "live" }, () => {
      const base = signal(RISKY);
      const ruleOnly = runtime.processSignal({ ...base, id: "sig_rule" }, { isolatedContext: true });
      const learned = runtime.processSignal({ ...base, id: "sig_learned", learned: { mode: "live", value, version: "v1" } }, { isolatedContext: true });
      assert.equal(learned.scrutiny.score, ruleOnly.scrutiny.score);
      assert.equal(learned.scrutiny.action, ruleOnly.scrutiny.action);
      assert.equal(Object.hasOwn(learned.scrutiny, "ruleScore"), false);
      assert.equal(learned.scrutiny.shadowLearnedValue, value);
    });
  }
});

test("processSignal: a shadow value is recorded and changes nothing", async (t) => {
  const service = fakeScoringService(tempDir(t));
  const runtime = makeRuntime(t, service.client);
  await service.client.health();
  await withEnv(LEARNED_ENV_UNSET, () => {
    const ruleOnly = runtime.processSignal(signal({ id: "sig_a" }), { isolatedContext: true });
    const shadow = runtime.processSignal(signal({ id: "sig_b", learned: { mode: "shadow", value: 0.95, version: "v1" } }), { isolatedContext: true });
    assert.equal(shadow.scrutiny.score, ruleOnly.scrutiny.score);
    assert.equal(shadow.scrutiny.action, ruleOnly.scrutiny.action);
    assert.equal(shadow.scrutiny.shadowLearnedValue, 0.95);
  });
});

test("a chat turn in shadow: same verdict as without a service, both scores and the turn score on its outcome", async (t) => {
  const text = "please check the quarterly numbers for the vendor";
  const without = makeRuntime(t);
  const baseline = await withEnv(LEARNED_ENV_UNSET, () => without.agentHost.handleMessage({ channel: "local", from: "user", text }));

  const service = fakeScoringService(tempDir(t));
  const runtime = makeRuntime(t, service.client);
  const turn = await withEnv(LEARNED_ENV_UNSET, () => runtime.agentHost.handleMessage({ channel: "local", from: "user", text }));
  await settle();
  assert.equal(turn.output.action, baseline.output.action);
  assert.equal(turn.output.scrutiny.score, baseline.output.scrutiny.score);
  const outcome = runtime.outcomes.recent(10).find((o) => o.kind === "agent-reply");
  assert.equal(outcome.metadata.learnedMode, "shadow");
  assert.equal(outcome.metadata.learnedValue, 0.9);
  assert.equal(outcome.metadata.learnedVersion, "v1");
  assert.equal(outcome.metadata.ruleScore, baseline.output.scrutiny.score);
  assert.deepEqual(outcome.metadata.learnedTurn, { pStop: 0.2, pNudge: 0.1, version: "v1" });
  const turnCall = service.calls.find((call) => call.key === "POST /score/turn");
  assert.equal(turnCall.body.prev_owner_text, text);
  assert.equal(turnCall.body.agent_text, turn.reply);
  const signalCall = service.calls.find((call) => call.key === "POST /score/signal");
  assert.deepEqual(signalCall.body, { text, channel: "local" });
  // Persisted, not just in memory.
  const snapshot = JSON.parse(fs.readFileSync(path.join(runtime.outcomes.dir, "snapshot.json"), "utf8"));
  assert.deepEqual(snapshot.outcomes.find((o) => o.id === outcome.id).metadata.learnedTurn, outcome.metadata.learnedTurn);
});

test("shadow never waits for the score: the turn finishes first and the outcome is filled in when it lands", async (t) => {
  const gate = deferred();
  const service = fakeScoringService(tempDir(t), {
    "POST /score/signal": async () => { await gate.promise; return { value: 0.4, version: "v2" }; }
  });
  const runtime = makeRuntime(t, service.client);
  const turn = await withEnv(LEARNED_ENV_UNSET, () => runtime.agentHost.handleMessage({ channel: "local", from: "user", text: "check the numbers" }));
  assert.ok(turn.reply, "the turn completed while the score was still pending");
  const outcome = runtime.outcomes.recent(10).find((o) => o.kind === "agent-reply");
  assert.equal(outcome.metadata.learnedValue, null, "not known when the outcome was written");
  gate.resolve();
  await settle();
  assert.equal(outcome.metadata.learnedValue, 0.4);
  assert.equal(outcome.metadata.learnedVersion, "v2");
});

test("live with a usable head waits for the score (bounded by the client); with an unusable head it does not", async (t) => {
  const health = { ok: true, version: "v1", heads: { value: { labels: 10, auroc: 0.5, usable: false } }, thresholds: {} };
  for (const [routes, waits] of [[{}, true], [{ "GET /health": health }, false]]) {
    const service = fakeScoringService(tempDir(t), {
      ...routes,
      "POST /score/signal": async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return { value: 0.9, version: "v1" }; }
    });
    const runtime = makeRuntime(t, service.client);
    await service.client.health();
    const agent = runtime.agentHost.store.getAgent("main");
    const result = await withEnv({ ...LEARNED_ENV_UNSET, OPENAGI_LEARNED_SCRUTINY: "live" }, () => runtime.agentHost.messageToSignal({
      text: "check the numbers", channel: "local", from: "user", agent, sessionId: "s1", metadata: {}
    }));
    assert.equal(result.learned.mode, "live");
    assert.equal(result.learned.value, waits ? 0.9 : undefined, waits ? "waited" : "did not wait");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

test("ephemeral turns ask nothing", async (t) => {
  const service = fakeScoringService(tempDir(t));
  const runtime = makeRuntime(t, service.client);
  await withEnv(LEARNED_ENV_UNSET, () => runtime.agentHost.handleMessage({ channel: "local", from: "user", text: "hello", ephemeral: true }));
  await settle();
  assert.deepEqual(service.calls.filter((call) => call.key !== "GET /health"), []);
});
