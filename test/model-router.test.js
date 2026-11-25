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
  assert.match(out, /OPENAI_MODEL_MINI=gpt-6-luna/);
});

test("OPENAGI_MODEL_DENY: a denied model never reaches a call, whatever asks for it", async () => {
  const { ModelRouter, deniedModel } = await import("../src/model-router.js");
  const { OpenAIResponsesProvider } = await import("../src/model-provider.js");
  const env = {
    OPENAGI_MODEL_DENY: "gpt-6-astra*, gpt-5.5", OPENAI_MODEL_DENY_FALLBACK: "gpt-6.1-sol",
    OPENAI_MODEL_TASK_CHAT: "gpt-6-astra", OPENAI_MODEL_MINI: "gpt-5.5"
  };
  assert.equal(deniedModel("gpt-6-astra", env), true);
  assert.equal(deniedModel("gpt-6-astra-2026-10-01", env), true, "a prefix rule covers dated names");
  assert.equal(deniedModel("gpt-6.1-sol", env), false);
  assert.equal(deniedModel("gpt-5.5", env), true);
  assert.equal(deniedModel("gpt-5.5-mini", env), false, "an exact rule is exact");
  const router = new ModelRouter({ envPrefix: "OPENAI", baseModel: "gpt-6-astra", env });
  const provider = new OpenAIResponsesProvider({ apiKey: "k", model: "gpt-6-astra", router });
  assert.equal(provider.resolveModel({}), "gpt-6.1-sol", "the base model");
  assert.equal(provider.resolveModel({ task: "chat" }), "gpt-6.1-sol", "a task pin");
  assert.equal(provider.resolveModel({ tier: "mini" }), "gpt-6.1-sol", "a tier");
  assert.equal(provider.resolveModel({ model: "gpt-6-astra" }), "gpt-6.1-sol", "an explicit model");
  assert.equal(provider.resolveModel({ model: "gpt-6-luna" }), "gpt-6-luna", "allowed models pass");
  assert.ok(router.describe().every((row) => !deniedModel(row.model, env)), "openagi models shows what really runs");
  // With no fallback, an allowed base takes over; with none allowed the call fails loudly.
  const noFallback = new ModelRouter({ envPrefix: "OPENAI", baseModel: "gpt-6-luna", env: { OPENAGI_MODEL_DENY: "gpt-6-astra" } });
  assert.equal(noFallback.allowed("gpt-6-astra"), "gpt-6-luna");
  const stuck = new ModelRouter({ envPrefix: "OPENAI", baseModel: "gpt-6-astra", env: { OPENAGI_MODEL_DENY: "gpt-6-astra" } });
  assert.throws(() => stuck.allowed("gpt-6-astra"), /denied by OPENAGI_MODEL_DENY/);
  // The plan reports what runs: the effective base, and tasks on it count as on base.
  const plan = router.describe();
  assert.equal(router.tierModels().base, "gpt-6.1-sol");
  assert.equal(router.tierModels().mini, "gpt-6.1-sol");
  assert.equal(plan.find((row) => row.task === "observer").onBase, true, "an unconfigured tier still shows as on base");
  // A fallback for the other provider is never sent to this one.
  const claude = new ModelRouter({ envPrefix: "ANTHROPIC", baseModel: "claude-sonnet-4-6", env: { OPENAGI_MODEL_DENY: "claude-opus*", OPENAGI_MODEL_DENY_FALLBACK: "gpt-6.1-sol" } });
  assert.equal(claude.allowed("claude-opus-4-7"), "claude-sonnet-4-6");
  const shared = new ModelRouter({ envPrefix: "OPENAI", baseModel: "gpt-6-astra", env: { OPENAGI_MODEL_DENY: "gpt-6-astra", OPENAGI_MODEL_DENY_FALLBACK: "gpt-6.1-sol" } });
  assert.equal(shared.allowed("gpt-6-astra"), "gpt-6.1-sol", "the shared fallback still works for its own provider");
  // Unset, nothing changes.
  assert.equal(new ModelRouter({ envPrefix: "OPENAI", baseModel: "gpt-6-astra", env: {} }).allowed("gpt-6-astra"), "gpt-6-astra");
});

test("gpt-6.1-sol bills at its own price", async () => {
  const { BudgetGuard } = await import("../src/budget-guard.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sol-price-"));
  const guard = new BudgetGuard({ storePath: path.join(dir, "usage.json"), dailyUsdLimit: 100 });
  const res = guard.record({ input_tokens: 1_000_000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 100_000 }, "gpt-6.1-sol");
  assert.equal(Number(res.added.toFixed(4)), 3);
});
