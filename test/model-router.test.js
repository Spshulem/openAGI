// Model tiering: one base model by default, cheaper tiers for small background
// jobs, every task pinnable, and nothing changes until you opt in.
import assert from "node:assert/strict";
import test from "node:test";
import { ModelRouter, TASK_PROFILES, renderModelPlan } from "../src/model-router.js";

test("default: every task resolves to the base model (opt-in, no behavior change)", () => {
  const r = new ModelRouter({ envPrefix: "OPENAI", baseModel: "gpt-5", env: {} });
  for (const task of Object.keys(TASK_PROFILES)) {
    assert.equal(r.resolve(task), "gpt-5", `${task} should fall back to base`);
  }
  assert.equal(r.resolve(undefined), "gpt-5");
});

test("configured tiers route the recommended tasks to cheaper models", () => {
  const env = { OPENAI_MODEL_MINI: "gpt-5-mini", OPENAI_MODEL_NANO: "gpt-5-nano" };
  const r = new ModelRouter({ envPrefix: "OPENAI", baseModel: "gpt-5", env });
  // nano-tier jobs
  assert.equal(r.resolve("observer"), "gpt-5-nano");
  assert.equal(r.resolve("scrutiny"), "gpt-5-nano");
  // mini-tier jobs
  assert.equal(r.resolve("condense"), "gpt-5-mini");
  assert.equal(r.resolve("mine"), "gpt-5-mini");
  assert.equal(r.resolve("plan"), "gpt-5-mini");
  // base jobs stay on base even with tiers configured
  assert.equal(r.resolve("chat"), "gpt-5");
  assert.equal(r.resolve("autopilot"), "gpt-5");
});

test("a per-task pin overrides the tier", () => {
  const env = { OPENAI_MODEL_NANO: "gpt-5-nano", OPENAI_MODEL_TASK_OBSERVER: "gpt-5-mini" };
  const r = new ModelRouter({ envPrefix: "OPENAI", baseModel: "gpt-5", env });
  assert.equal(r.resolve("observer"), "gpt-5-mini", "task pin wins over tier");
  assert.equal(r.resolve("scrutiny"), "gpt-5-nano", "other nano tasks still follow the tier");
});

test("tierModel falls back to base for unconfigured / base tier", () => {
  const r = new ModelRouter({ envPrefix: "OPENAI", baseModel: "gpt-5", env: {} });
  assert.equal(r.tierModel("base"), "gpt-5");
  assert.equal(r.tierModel("nano"), "gpt-5");
  assert.equal(r.tierModel(undefined), "gpt-5");
});

test("programmatic overrides work without env (Anthropic prefix)", () => {
  const r = new ModelRouter({
    envPrefix: "ANTHROPIC",
    baseModel: "claude-sonnet-4-6",
    env: {},
    overrides: { tiers: { mini: "claude-haiku-4-5", nano: "claude-haiku-4-5" } }
  });
  assert.equal(r.resolve("condense"), "claude-haiku-4-5");
  assert.equal(r.resolve("chat"), "claude-sonnet-4-6");
});

test("describe() flags which tasks are still on base (not yet saving)", () => {
  const r = new ModelRouter({ envPrefix: "OPENAI", baseModel: "gpt-5", env: { OPENAI_MODEL_NANO: "gpt-5-nano" } });
  const rows = Object.fromEntries(r.describe().map((row) => [row.task, row]));
  assert.equal(rows.observer.onBase, false, "observer now on nano");
  assert.equal(rows.condense.onBase, true, "condense still on base (mini unset)");
  assert.equal(rows.chat.onBase, true, "chat intentionally on base");
});

test("renderModelPlan shows configured tiers + savings recommendations", () => {
  const r = new ModelRouter({ envPrefix: "OPENAI", baseModel: "gpt-5", env: { OPENAI_MODEL_NANO: "gpt-5-nano" } });
  const out = renderModelPlan(r, { provider: "openai" });
  assert.match(out, /Base model: gpt-5/);
  assert.match(out, /nano=gpt-5-nano/);
  // mini is still unset → recommend it
  assert.match(out, /OPENAI_MODEL_MINI=gpt-5-mini/);
});
