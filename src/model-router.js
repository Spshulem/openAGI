// Model tiering / routing.
//
// One "base" model handles everything by default. Lighter, cheaper models can
// take the small, frequent background jobs — you do NOT need a top model for
// every internal task. Out of the box every task still resolves to the base
// model (no behavior change), so tiering is strictly opt-in: set the tier env
// vars and the recommended tasks shift automatically. Any task can also be
// pinned to an exact model.
//
// Two knobs:
//   • Tiers   — name a cheaper model once, reuse it.  e.g. OPENAI_MODEL_NANO=gpt-5-nano
//   • Tasks   — pin one job to an exact model.        e.g. OPENAI_MODEL_TASK_OBSERVER=gpt-5-mini
//
// Resolution for a task:  task pin  >  task's recommended tier  >  base model.

// The "where" — every internal job that calls the model, with a recommended
// tier and the reason it's safe to shrink. `chat` and `autopilot` intentionally
// stay on base (real reasoning + tool use); the rest are small and/or frequent,
// which is exactly where a mini/nano model saves the most money.
export const TASK_PROFILES = {
  chat:      { tier: "base", label: "User chat",            why: "Real reasoning, user-facing replies — keep this on your best model." },
  autopilot: { tier: "base", label: "Autopilot task work", why: "Plans and executes real work with tools — needs the strong model." },
  observer:  { tier: "nano", label: "Proactive observer",  why: "Mostly 'suggest one thing or stay quiet', runs often — nano is plenty." },
  scrutiny:  { tier: "nano", label: "Scrutiny judges",     why: "Short act/ask/watch/ignore classification, very frequent — nano is plenty." },
  condense:  { tier: "mini", label: "Memory condensing",   why: "Summarize a cluster of notes into one — a mini model handles it." },
  mine:      { tier: "mini", label: "Session mining",      why: "Cluster intents out of a transcript — mini is enough." },
  plan:      { tier: "mini", label: "Daily plan / recap",  why: "Summarize the day — mini is enough." },
  extract:   { tier: "nano", label: "iMessage extraction", why: "Pull follow-ups/events from a batch of texts, runs often — nano is plenty." },
  sweep:     { tier: "mini", label: "Task list hygiene",    why: "Classify queue + dedupe/stale-judge the task list — mini has the judgment for it." }
};

// Order matters for display (strongest → cheapest).
export const TIERS = ["base", "mini", "nano"];

export class ModelRouter {
  // envPrefix: "OPENAI" | "ANTHROPIC". baseModel: the already-resolved base model.
  // overrides (optional, for tests/programmatic config):
  //   { tiers: { mini, nano }, tasks: { observer: "<model>" } }
  constructor({ envPrefix = "OPENAI", baseModel, env = process.env, overrides = {} } = {}) {
    this.envPrefix = envPrefix;
    this.baseModel = baseModel;
    this.env = env;
    this.overrides = overrides;
  }

  // Model for a tier name. Unset tiers fall back to base, so an undefined
  // tier is always safe (you just don't save until you configure it).
  tierModel(tier) {
    if (!tier || tier === "base") return this.baseModel;
    const fromOverride = this.overrides.tiers?.[tier];
    if (fromOverride) return fromOverride;
    const fromEnv = this.env[`${this.envPrefix}_MODEL_${tier.toUpperCase()}`];
    return fromEnv || this.baseModel;
  }

  // Model for a named task: explicit task pin > task's recommended tier > base.
  resolve(task) {
    if (!task) return this.baseModel;
    const taskPin =
      this.overrides.tasks?.[task] ||
      this.env[`${this.envPrefix}_MODEL_TASK_${task.toUpperCase()}`];
    if (taskPin) return taskPin;
    const profile = TASK_PROFILES[task];
    return this.tierModel(profile?.tier ?? "base");
  }

  // Which models are actually wired up (base + any configured tiers).
  tierModels() {
    const out = { base: this.baseModel };
    for (const tier of TIERS) {
      if (tier === "base") continue;
      out[tier] = this.tierModel(tier);
    }
    return out;
  }

  // Human-readable plan: every task, its recommended tier, the model it resolves
  // to right now, and why. `onBase` flags tasks that are NOT yet saving (still
  // on the base model because their tier isn't configured).
  describe() {
    return Object.entries(TASK_PROFILES).map(([task, p]) => {
      const model = this.resolve(task);
      return {
        task,
        label: p.label,
        tier: p.tier,
        model,
        why: p.why,
        onBase: model === this.baseModel
      };
    });
  }
}

// Pretty multi-line summary for the CLI (`openagi models`).
export function renderModelPlan(router, { provider } = {}) {
  const lines = [];
  const models = router.tierModels();
  lines.push(`Provider: ${provider ?? "?"}   Base model: ${models.base}`);
  const configured = TIERS.filter((t) => t !== "base" && models[t] !== models.base);
  if (configured.length === 0) {
    lines.push("Tiers:    (none configured — everything runs on the base model)");
  } else {
    lines.push(`Tiers:    ${configured.map((t) => `${t}=${models[t]}`).join("   ")}`);
  }
  lines.push("");
  lines.push("Where each job runs (→ = recommended smaller model):");
  for (const row of router.describe()) {
    const arrow = row.onBase && row.tier !== "base" ? "  ⚠ still on base" : "";
    const tag = row.tier === "base" ? "[base]" : `[${row.tier}]`;
    lines.push(`  ${tag.padEnd(7)} ${row.label.padEnd(22)} ${row.model}${arrow}`);
    lines.push(`          ${row.why}`);
  }
  const onBase = router.describe().filter((r) => r.onBase && r.tier !== "base");
  if (onBase.length > 0) {
    const prefix = router.envPrefix;
    lines.push("");
    lines.push("Recommended savings — set these to use cheaper models for small jobs:");
    if (router.describe().some((r) => r.tier === "nano" && r.onBase)) {
      lines.push(`  ${prefix}_MODEL_NANO=${prefix === "OPENAI" ? "gpt-5-nano" : "claude-haiku-4-5"}   # observer, scrutiny judges`);
    }
    if (router.describe().some((r) => r.tier === "mini" && r.onBase)) {
      lines.push(`  ${prefix}_MODEL_MINI=${prefix === "OPENAI" ? "gpt-5-mini" : "claude-haiku-4-5"}   # condensing, mining, daily recap`);
    }
  }
  return lines.join("\n");
}
