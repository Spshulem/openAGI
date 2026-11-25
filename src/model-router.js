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
//   • Tiers   — name a cheaper model once, reuse it.  e.g. OPENAI_MODEL_NANO=gpt-6-luna
//   • Tasks   — pin one job to an exact model.        e.g. OPENAI_MODEL_TASK_OBSERVER=gpt-6-luna
//
// Resolution for a task:  task pin  >  task's recommended tier  >  base model.
//
// Reasoning effort follows the same per-task pattern:
//   OPENAI_REASONING_EFFORT_TASK_CHAT=high  overrides OPENAI_REASONING_EFFORT
// for that one job (e.g. a cheap model thinking harder on user chat).
// The value is trimmed and lowercased; anything outside REASONING_EFFORTS is
// ignored with a warning (the task falls back to the global effort) so a typo
// cannot 400 every call for that task.

// Out-of-the-box OpenAI models when the owner has not picked one. The daily
// model check (model-upgrades.js) suggests newer ones as they ship, so these
// only matter for fresh installs and unset keys.
export const DEFAULT_OPENAI_MODEL = "gpt-6.2-sol";
export const DEFAULT_OPENAI_SMALL_MODEL = "gpt-6-luna";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];

// Which reasoning.effort values a given OpenAI model id accepts. Sending one a
// model does not accept 400s the request, so a per-chat override has to be
// checked against the model it will actually reach — not the full list above.
//   o1/o3/o4 ................. low, medium, high
//   gpt-5 / -mini / -nano .... minimal, low, medium, high
//   gpt-5.1 .................. none, low, medium, high   (codex-max: low..xhigh)
//   gpt-5.2+ and gpt-6+ ...... none, low, medium, high, xhigh
//   gpt-4*, other non-reasoning ids: none supported ([])
// Unrecognized ids get the conservative low/medium/high set every reasoning
// model accepts, so an unknown model never receives an exotic value.
const SAFE_EFFORTS = Object.freeze(["low", "medium", "high"]);
export function reasoningEffortsForModel(model) {
  const id = String(model ?? "").trim().toLowerCase().replace(/^openai\//, "");
  if (!id) return [...SAFE_EFFORTS];
  if (/^o[134](\b|-|$)/.test(id)) return ["low", "medium", "high"];
  if (/^(gpt-4|gpt-3|chatgpt-4o)/.test(id)) return [];
  const gpt = id.match(/^gpt-(\d+)(?:\.(\d+))?/);
  if (!gpt) return [...SAFE_EFFORTS];
  const major = Number(gpt[1]);
  const minor = gpt[2] === undefined ? 0 : Number(gpt[2]);
  if (major < 5) return [];
  if (major === 5 && minor === 0) return id.includes("chat") ? [] : ["minimal", "low", "medium", "high"];
  if (major === 5 && minor === 1) return id.includes("codex-max") ? ["low", "medium", "high", "xhigh"] : ["none", "low", "medium", "high"];
  return ["none", "low", "medium", "high", "xhigh"];
}

// The "where" — every internal job that calls the model, with a recommended
// tier and the reason it's safe to shrink. `chat` and `autopilot` intentionally
// stay on base (real reasoning + tool use); the rest are small and/or frequent,
// which is exactly where a mini/nano model saves the most money.
export const TASK_PROFILES = {
  chat:      { tier: "base", label: "User chat",            why: "Real reasoning, user-facing replies — keep this on your best model." },
  autopilot: { tier: "base", label: "Autopilot task work", why: "Plans and executes real work with tools — needs the strong model." },
  scheduled: { tier: "mini", label: "Scheduled reminders", why: "Background prompts use a smaller model, independent of their delivery channel." },
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

export function agentTurnTask(input = {}) {
  if (input.origin === 'autopilot' || input.channel === 'autopilot') return 'autopilot';
  if (input.origin === 'cron' || input.channel === 'cron' || input.metadata?.scheduledJobId) return 'scheduled';
  return 'chat';
}

// Models the owner never wants used, whatever a tier, task pin or caller asks
// for: OPENAGI_MODEL_DENY, comma-separated, exact names or a prefix ending in
// "*" ("gpt-6-astra*"). A denied model becomes the provider's own fallback
// (<PREFIX>_MODEL_DENY_FALLBACK, e.g. OPENAI_MODEL_DENY_FALLBACK), else
// OPENAGI_MODEL_DENY_FALLBACK when it is this provider's kind of model, else
// the base model when that is allowed; with none allowed the call fails rather
// than quietly using the denied model.
export function deniedModel(model, env = process.env) {
  const name = String(model ?? "").trim();
  if (!name) return false;
  return String(env.OPENAGI_MODEL_DENY ?? "").split(",").map((rule) => rule.trim()).filter(Boolean)
    .some((rule) => (rule.endsWith("*") ? name.startsWith(rule.slice(0, -1)) : name === rule));
}

export class ModelRouter {
  // envPrefix: "OPENAI" | "ANTHROPIC". baseModel: the already-resolved base model.
  // overrides (optional, for tests/programmatic config):
  //   { tiers: { mini, nano }, tasks: { observer: "<model>" } }
  constructor({ envPrefix = "OPENAI", baseModel, env = process.env, overrides = {} } = {}) {
    this.envPrefix = envPrefix;
    this.baseModel = baseModel;
    this.env = env;
    this.overrides = overrides;
    this.warnedEfforts = new Set();
    this.warnedDenied = new Set();
  }

  // The model a call may really use: `model` unless OPENAGI_MODEL_DENY names it.
  allowed(model) {
    if (!deniedModel(model, this.env)) return model;
    const own = String(this.env[`${this.envPrefix}_MODEL_DENY_FALLBACK`] ?? "").trim();
    const shared = String(this.env.OPENAGI_MODEL_DENY_FALLBACK ?? "").trim();
    const to = [own, this.ownKind(shared) ? shared : "", this.baseModel]
      .find((candidate) => candidate && !deniedModel(candidate, this.env)) ?? null;
    if (!to) throw new Error(`Model ${model} is denied by OPENAGI_MODEL_DENY and no allowed fallback is set (${this.envPrefix}_MODEL_DENY_FALLBACK).`);
    if (!this.warnedDenied.has(model)) {
      this.warnedDenied.add(model);
      console.warn(`[model-router] ${model} is denied by OPENAGI_MODEL_DENY; using ${to}.`);
    }
    return to;
  }

  // Whether a model name belongs to this provider: a Claude model never goes
  // to the OpenAI API, nor an OpenAI model to Anthropic's.
  ownKind(model) {
    if (!model) return false;
    return this.envPrefix === "ANTHROPIC" ? /^claude/i.test(model) : !/^claude/i.test(model);
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

  // Reasoning effort pinned for one task, or null to use the provider's global
  // effort. Same lookup as resolve(): override > <PREFIX>_REASONING_EFFORT_TASK_<TASK>.
  reasoningEffort(task) {
    const setting = this.reasoningEffortSetting(task);
    if (setting.invalid != null && !this.warnedEfforts.has(setting.key)) {
      this.warnedEfforts.add(setting.key);
      console.warn(`[model-router] ${setting.key}=${JSON.stringify(setting.invalid)} is not a reasoning effort (${REASONING_EFFORTS.join("/")}); using the global effort.`);
    }
    return setting.effort;
  }

  // { effort, invalid, key }: effort is the normalized value or null; invalid
  // holds the raw value when one was set but is not a known effort.
  reasoningEffortSetting(task) {
    if (!task) return { effort: null, invalid: null, key: null };
    const key = `${this.envPrefix}_REASONING_EFFORT_TASK_${task.toUpperCase()}`;
    const raw = this.overrides.reasoningEffort?.[task] || this.env[key] || null;
    if (raw == null) return { effort: null, invalid: null, key };
    const effort = String(raw).trim().toLowerCase();
    if (!effort) return { effort: null, invalid: null, key };
    return REASONING_EFFORTS.includes(effort) ? { effort, invalid: null, key } : { effort: null, invalid: String(raw), key };
  }

  // Which models are actually wired up (base + any configured tiers).
  tierModels() {
    const out = { base: this.allowed(this.baseModel) };
    for (const tier of TIERS) {
      if (tier === "base") continue;
      out[tier] = this.allowed(this.tierModel(tier));
    }
    return out;
  }

  // Human-readable plan: every task, its recommended tier, the model it resolves
  // to right now, and why. `onBase` flags tasks that are NOT yet saving (still
  // on the base model because their tier isn't configured).
  describe() {
    const base = this.allowed(this.baseModel);
    return Object.entries(TASK_PROFILES).map(([task, p]) => {
      const model = this.allowed(this.resolve(task));
      const effort = this.reasoningEffortSetting(task);
      return {
        task,
        label: p.label,
        tier: p.tier,
        model,
        reasoningEffort: effort.effort,
        invalidReasoningEffort: effort.invalid,
        why: p.why,
        onBase: model === base
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
    const effort = row.invalidReasoningEffort != null
      ? `  (⚠ effort ${JSON.stringify(row.invalidReasoningEffort)} is invalid, using global)`
      : row.reasoningEffort ? `  (effort ${row.reasoningEffort})` : "";
    lines.push(`  ${tag.padEnd(7)} ${row.label.padEnd(22)} ${row.model}${effort}${arrow}`);
    lines.push(`          ${row.why}`);
  }
  const onBase = router.describe().filter((r) => r.onBase && r.tier !== "base");
  if (onBase.length > 0) {
    const prefix = router.envPrefix;
    lines.push("");
    lines.push("Recommended savings — set these to use cheaper models for small jobs:");
    if (router.describe().some((r) => r.tier === "nano" && r.onBase)) {
      lines.push(`  ${prefix}_MODEL_NANO=${prefix === "OPENAI" ? DEFAULT_OPENAI_SMALL_MODEL : "claude-haiku-4-5"}   # observer, scrutiny judges`);
    }
    if (router.describe().some((r) => r.tier === "mini" && r.onBase)) {
      lines.push(`  ${prefix}_MODEL_MINI=${prefix === "OPENAI" ? DEFAULT_OPENAI_SMALL_MODEL : "claude-haiku-4-5"}   # condensing, mining, daily recap`);
    }
  }
  return lines.join("\n");
}
