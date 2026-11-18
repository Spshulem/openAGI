// Optional learned keep-score for memory (OPENAGI_LEARNED_MEMORY).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableRuntime, DeterministicModelProvider } from "../src/index.js";
import { MemorySystem } from "../src/memory-system.js";
import { FileBackedMemorySystem } from "../src/file-backed-memory-system.js";
import { LEARNED_ENV_UNSET, fakeScoringService, withEnv } from "./support/fake-scoring-service.js";

const DAY_MS = 86_400_000;
const START = new Date("2026-02-01T00:00:00Z");

function tempDir(t, prefix = "openagi-learned-memory-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Three medium-tier items (decay 0.01 a day) at strength 0.8: no score,
// keep-score 1.0 and keep-score 0.0, plus a protected one scored 1.0.
function seeded(memory) {
  const add = (content, extra = {}) => memory.remember(
    { content, source: "test", repetition: 0.5, ...extra },
    { now: START.toISOString(), strength: 0.8, tier: "medium" }
  );
  const ids = {
    plain: add("plain item").id,
    likely: add("likely recalled").id,
    unlikely: add("unlikely recalled").id,
    saved: add("user saved fact", { tags: ["tool:remember"] }).id
  };
  memory.setKeepScore(ids.likely, 1, "v1");
  memory.setKeepScore(ids.unlikely, 0, "v1");
  memory.setKeepScore(ids.saved, 1, "v1");
  return ids;
}

function strengths(memory, ids) {
  return Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, memory.items.get(id).strength]));
}

const close = (actual, expected) => Math.abs(actual - expected) < 1e-9;

test("shadow stores keep-scores and changes neither decay nor eviction", () => {
  const control = new MemorySystem();
  const shadow = new MemorySystem({ learnedMode: "shadow" });
  const controlIds = seeded(control);
  const shadowIds = seeded(shadow);
  assert.equal(shadow.items.get(shadowIds.likely).metadata.keepScore, 1);
  assert.equal(shadow.items.get(shadowIds.likely).metadata.keepScoreVersion, "v1");
  const at = new Date(START.getTime() + 10 * DAY_MS);
  control.decay(at);
  shadow.decay(at);
  assert.deepEqual(Object.values(strengths(shadow, shadowIds)), Object.values(strengths(control, controlIds)));
  assert.equal(shadow.keepMultiplier(shadow.items.get(shadowIds.likely)), 1);
  assert.equal(shadow.keepMultiplier(shadow.items.get(shadowIds.unlikely)), 1);
});

test("live: keep-score 1.0 decays at half the rate, 0.0 at one and a half times, unscored and protected items as before", () => {
  const memory = new MemorySystem({ learnedMode: "live" });
  const ids = seeded(memory);
  memory.decay(new Date(START.getTime() + 10 * DAY_MS));
  const s = strengths(memory, ids);
  assert.ok(close(s.plain, 0.7), `plain ${s.plain}`);
  assert.ok(close(s.likely, 0.75), `likely ${s.likely}`);
  assert.ok(close(s.unlikely, 0.65), `unlikely ${s.unlikely}`);
  assert.ok(close(s.saved, 0.7), `protected ${s.saved}`);
});

test("live: the multiplier applies when a repeat moves the decay baseline too", () => {
  const memory = new MemorySystem({ learnedMode: "live" });
  const item = memory.remember({ content: "repeated", source: "test" }, { now: START.toISOString(), strength: 0.8, tier: "medium" });
  memory.setKeepScore(item.id, 1, "v1");
  memory.advanceDecayBaseline(item, new Date(START.getTime() + 10 * DAY_MS).toISOString());
  assert.ok(close(item.strength, 0.75), `${item.strength}`);
});

test("live has no effect while the runtime reports the keep head as unusable", () => {
  const memory = new MemorySystem({ learnedMode: "live", keepScoresUsable: () => false });
  const control = new MemorySystem();
  const ids = seeded(memory);
  const controlIds = seeded(control);
  const at = new Date(START.getTime() + 10 * DAY_MS);
  memory.decay(at);
  control.decay(at);
  assert.deepEqual(Object.values(strengths(memory, ids)), Object.values(strengths(control, controlIds)));
});

function evictionRun(learnedMode) {
  const memory = new MemorySystem({ learnedMode, limits: { short: 2 } });
  const add = (content, strength) => memory.remember({ content, source: "test" }, { tier: "short", strength });
  const a = add("item a", 0.5);
  const b = add("item b", 0.45);
  memory.setKeepScore(a.id, 0, "v1");
  memory.setKeepScore(b.id, 1, "v1");
  add("item c", 0.9);
  return { kept: new Set(memory.items.keys()), a: a.id, b: b.id };
}

test("eviction order changes only in live mode", () => {
  for (const mode of ["off", "shadow"]) {
    const run = evictionRun(mode);
    assert.equal(run.kept.has(run.b), false, `${mode}: the weaker item goes`);
    assert.equal(run.kept.has(run.a), true);
  }
  const live = evictionRun("live");
  assert.equal(live.kept.has(live.a), false, "live: the item unlikely to be recalled goes");
  assert.equal(live.kept.has(live.b), true);
});

test("setKeepScore accepts only probabilities for known items", () => {
  const memory = new MemorySystem();
  const item = memory.remember({ content: "x", source: "test" });
  assert.equal(memory.setKeepScore("missing", 0.5), null);
  for (const bad of [-0.1, 1.1, Number.NaN, "0.5", null, undefined]) assert.equal(memory.setKeepScore(item.id, bad), null);
  assert.equal(item.metadata.keepScore, undefined);
  memory.setKeepScore(item.id, 0.25, 42);
  assert.equal(item.metadata.keepScore, 0.25);
  assert.equal(item.metadata.keepScoreVersion, null, "a non-string version is not stored");
  assert.ok(Number.isFinite(Date.parse(item.metadata.keepScoredAt)));
});

test("file-backed: a keep-score is persisted with ids and numbers only, and survives a reload", (t) => {
  const dir = tempDir(t);
  const memory = new FileBackedMemorySystem({ dir });
  const item = memory.remember({ content: "a private note about the vendor", source: "test" });
  memory.setKeepScore(item.id, 0.7, "v3");
  const events = fs.readFileSync(path.join(dir, "memory-events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const keep = events.find((event) => event.op === "keep-score");
  assert.deepEqual(keep.payload, { id: item.id, keepScore: 0.7, version: "v3" });
  assert.equal(JSON.stringify(keep).includes("vendor"), false);
  const reloaded = new FileBackedMemorySystem({ dir });
  assert.equal(reloaded.items.get(item.id).metadata.keepScore, 0.7);
});

function makeRuntime(t, modelClient) {
  return createDurableRuntime({
    dataDir: tempDir(t),
    ...(modelClient ? { modelClient } : {}),
    modelProvider: new DeterministicModelProvider(),
    autoConnectMcp: false
  });
}

test("the runtime sets the memory mode from the flag only when the service is configured", async (t) => {
  await withEnv({ ...LEARNED_ENV_UNSET, OPENAGI_LEARNED_MEMORY: "live" }, () => {
    assert.equal(makeRuntime(t).memory.learnedMode, "off", "no service: off whatever the flag");
  });
  for (const [flag, expected] of [[undefined, "shadow"], ["live", "live"], ["off", "off"], ["bogus", "shadow"]]) {
    const service = fakeScoringService(tempDir(t));
    await withEnv({ ...LEARNED_ENV_UNSET, OPENAGI_LEARNED_MEMORY: flag }, () => {
      assert.equal(makeRuntime(t, service.client).memory.learnedMode, expected, `flag ${flag}`);
    });
  }
});

test("processSignal asks for a keep-score without waiting and stores it when it lands", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = fakeScoringService(tempDir(t), {
    "POST /memory/keep": async (body) => {
      await gate;
      return { scores: Object.fromEntries(body.items.map((item) => [item.id, 0.8])), version: "v5" };
    }
  });
  const runtime = makeRuntime(t, service.client);
  const output = await withEnv(LEARNED_ENV_UNSET, () => runtime.processSignal({
    id: "sig_keep", source: "test", type: "message", summary: "vendor checklist", content: "vendor checklist for onboarding",
    citations: ["a", "b", "c"], urgency: 0.6, impact: 0.6, risk: 0.3, novelty: 0.4, repetition: 0.3
  }));
  assert.ok(output.memory, "the signal was committed to memory");
  assert.equal(output.memory.metadata.keepScore, undefined, "processSignal returned before the score");
  release();
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const item = runtime.memory.items.get(output.memory.id);
  assert.equal(item.metadata.keepScore, 0.8);
  assert.equal(item.metadata.keepScoreVersion, "v5");
  const call = service.calls.find((entry) => entry.key === "POST /memory/keep");
  assert.deepEqual(Object.keys(call.body.items[0]).sort(),
    ["id", "kind", "novelty", "repetition", "risk", "source", "specificity", "strength", "text", "tier"]);
  assert.equal(call.body.items[0].id, output.memory.id);
});

test("processSignal asks for nothing when the memory use is off", async (t) => {
  const service = fakeScoringService(tempDir(t));
  const runtime = makeRuntime(t, service.client);
  await withEnv({ ...LEARNED_ENV_UNSET, OPENAGI_LEARNED_MEMORY: "off" }, () => runtime.processSignal({
    id: "sig_off", source: "test", type: "message", summary: "vendor checklist", content: "vendor checklist",
    citations: ["a", "b", "c"], urgency: 0.6, impact: 0.6
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.calls.some((call) => call.key === "POST /memory/keep"), false);
});

test("a service with no keep head (scores null) leaves memory exactly as it was", async (t) => {
  const service = fakeScoringService(tempDir(t), { "POST /memory/keep": { scores: null, version: "v1" } });
  const runtime = makeRuntime(t, service.client);
  const output = await withEnv(LEARNED_ENV_UNSET, () => runtime.processSignal({
    id: "sig_nohead", source: "test", type: "message", summary: "vendor checklist", content: "vendor checklist for onboarding",
    citations: ["a", "b", "c"], urgency: 0.6, impact: 0.6, risk: 0.3, novelty: 0.4, repetition: 0.3
  }));
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(service.calls.some((call) => call.key === "POST /memory/keep"));
  assert.equal(runtime.memory.items.get(output.memory.id).metadata.keepScore, undefined);
  const events = fs.readFileSync(path.join(runtime.memory.dir, "memory-events.jsonl"), "utf8");
  assert.equal(events.includes("keep-score"), false);
  assert.equal(service.client._failures, 0, "not counted as a failure");
});
