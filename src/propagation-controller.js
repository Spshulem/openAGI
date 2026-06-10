import { clamp, createId, nowIso, stableHash, summarizeText, tokenOverlapScore } from "./utils.js";

// A specialist's allowedTools used to be "every tool that existed at spawn
// time" — a bound that bounds nothing. Division that inherits the whole
// generalist toolset is just multiplication with a themed name. Instead:
// keep only the tools whose name/description overlaps the bounded scope,
// capped, ranked by overlap. (Core internal tools — recall/remember/task
// ops — are granted at the enforcement layer in agent-host, not here.)
const MAX_SCOPE_TOOLS = 10;
export function selectScopedTools(tools, scopeText) {
  const scored = [];
  for (const tool of tools ?? []) {
    const name = typeof tool === "string" ? tool : tool?.name;
    if (!name) continue;
    const description = typeof tool === "object" ? (tool.description ?? "") : "";
    const score = tokenOverlapScore(scopeText, `${name.replace(/[_-]/g, " ")} ${description}`);
    if (score > 0.05) scored.push({ name, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return [...new Set(scored.slice(0, MAX_SCOPE_TOOLS).map((entry) => entry.name))];
}

export class PropagationController {
  constructor(options = {}) {
    this.specialists = new Map();
    this.maxSpecialists = options.maxSpecialists ?? 25;
    this.repetitionThreshold = options.repetitionThreshold ?? 0.72;
    this.riskNoveltyThreshold = options.riskNoveltyThreshold ?? 0.62;
    this.maxDepth = options.maxDepth ?? 3;
    this.maxBreadthPerParent = options.maxBreadthPerParent ?? 5;
  }

  shouldPropagate({ signal, scrutiny, memoryHits = [], parentSpecialistId = null }) {
    const repetition = clamp(signal.repetition ?? scrutiny?.dimensions?.repetition ?? 0);
    const risk = clamp(signal.risk ?? scrutiny?.dimensions?.risk ?? 0);
    const novelty = clamp(signal.novelty ?? scrutiny?.dimensions?.novelty ?? 0);
    const memoryCoverage = clamp(memoryHits.reduce((sum, hit) => sum + hit.score, 0) / Math.max(memoryHits.length, 1));
    const repeated = repetition >= this.repetitionThreshold;
    const novelAndRisky = risk * novelty >= this.riskNoveltyThreshold;
    const explicitlyRequired = signal.requiresSpecialist === true || scrutiny?.action === "propagate";
    const underCovered = memoryCoverage < 0.35 && risk >= 0.6;

    // D1: cycle / depth / breadth checks for sub-propagation.
    let blockedBy = null;
    if (parentSpecialistId) {
      const parent = [...this.specialists.values()].find((s) => s.id === parentSpecialistId);
      if (parent) {
        if ((parent.depth ?? 0) >= this.maxDepth - 1) blockedBy = `max-depth-${this.maxDepth}`;
        const children = [...this.specialists.values()].filter((s) => s.parentSpecialistId === parentSpecialistId && s.status !== "retired");
        if (!blockedBy && children.length >= this.maxBreadthPerParent) blockedBy = `max-breadth-${this.maxBreadthPerParent}`;
        // Struggling parents shouldn't spawn more.
        if (!blockedBy && (parent.outcomeSamples ?? 0) >= 5 && (parent.meanOutcomeQuality ?? 1) < 0.4) blockedBy = "parent-low-quality";
      }
    }

    return {
      decision: !blockedBy && (explicitlyRequired || repeated || novelAndRisky || underCovered),
      repeated,
      novelAndRisky,
      explicitlyRequired,
      underCovered,
      memoryCoverage,
      blockedBy
    };
  }

  propagate({ signal, workflow, scrutiny, tools = [], parentSpecialistId = null }) {
    if (this.specialists.size >= this.maxSpecialists) {
      return {
        created: false,
        reason: "specialist-limit-reached",
        specialist: null
      };
    }

    const signature = this.signature(signal, workflow);
    const existing = this.specialists.get(signature);
    if (existing) {
      existing.lastActivatedAt = nowIso();
      existing.activationCount += 1;
      existing.reasons.push(...(scrutiny?.reasons ?? []).slice(0, 2));
      return { created: false, reason: "existing-specialist-activated", specialist: existing };
    }

    const parent = parentSpecialistId
      ? [...this.specialists.values()].find((s) => s.id === parentSpecialistId)
      : null;
    const specialist = {
      id: createId("agent"),
      signature,
      name: this.specialistName(signal, workflow),
      parentGoal: workflow?.goal ?? signal.goal ?? "Improve outcome from signal evidence.",
      boundedScope: summarizeText(signal.specialistScope ?? signal.summary ?? signal.content ?? "Investigate and act on this signal class.", 240),
      successMetric: signal.successMetric ?? workflow?.successMetric ?? "Produces cited, actionable recommendations with lower repeated parent effort.",
      allowedTools: selectScopedTools(
        tools,
        `${signal.specialistScope ?? ""} ${signal.summary ?? ""} ${signal.content ?? ""} ${workflow?.goal ?? ""}`
      ),
      status: "available",
      createdAt: nowIso(),
      lastActivatedAt: nowIso(),
      activationCount: 1,
      reasons: scrutiny?.reasons ?? [],
      meanOutcomeQuality: null,
      outcomeSamples: 0,
      retiredAt: null,
      retirementReason: null,
      seasonal: signal.seasonal === true,
      parentSpecialistId: parentSpecialistId ?? null,
      depth: parent ? (parent.depth ?? 0) + 1 : 0
    };

    this.specialists.set(signature, specialist);
    return { created: true, reason: "specialist-created", specialist };
  }

  list({ includeRetired = false } = {}) {
    let arr = [...this.specialists.values()];
    if (!includeRetired) arr = arr.filter((s) => s.status !== "retired");
    return arr.sort((a, b) => b.lastActivatedAt.localeCompare(a.lastActivatedAt));
  }

  recordOutcomeQuality(specialistId, qualityScore) {
    if (typeof qualityScore !== "number") return null;
    const sp = [...this.specialists.values()].find((s) => s.id === specialistId);
    if (!sp) return null;
    const prev = sp.meanOutcomeQuality ?? 0;
    const n = sp.outcomeSamples ?? 0;
    sp.meanOutcomeQuality = (prev * n + qualityScore) / (n + 1);
    sp.outcomeSamples = n + 1;
    return sp;
  }

  retire(specialistId, reason = "manual") {
    const sp = [...this.specialists.values()].find((s) => s.id === specialistId);
    if (!sp || sp.status === "retired") return null;
    sp.status = "retired";
    sp.retiredAt = nowIso();
    sp.retirementReason = reason;
    return sp;
  }

  /**
   * Sweep retirement criteria: dormant for >dormancyDays, OR rolling outcome
   * quality < qualityFloor over >=minSamples activations. Seasonal specialists
   * skip the dormancy check.
   */
  retirementSweep({ dormancyDays = 30, qualityFloor = 0.3, minSamples = 10, now = new Date() } = {}) {
    const retired = [];
    const cutoff = (now instanceof Date ? now.getTime() : new Date(now).getTime()) - dormancyDays * 86400 * 1000;
    for (const sp of this.specialists.values()) {
      if (sp.status === "retired") continue;
      const lastMs = sp.lastActivatedAt ? new Date(sp.lastActivatedAt).getTime() : 0;
      if (!sp.seasonal && lastMs < cutoff) {
        sp.status = "retired";
        sp.retiredAt = nowIso();
        sp.retirementReason = `dormant > ${dormancyDays}d`;
        retired.push(sp);
        continue;
      }
      if ((sp.outcomeSamples ?? 0) >= minSamples && (sp.meanOutcomeQuality ?? 1) < qualityFloor) {
        sp.status = "retired";
        sp.retiredAt = nowIso();
        sp.retirementReason = `mean quality ${sp.meanOutcomeQuality?.toFixed(2)} < ${qualityFloor}`;
        retired.push(sp);
      }
    }
    return retired;
  }

  signature(signal, workflow) {
    return stableHash({
      workflow: workflow?.id ?? workflow?.name ?? "default",
      domain: signal.domain ?? "general",
      taskType: signal.taskType ?? signal.type ?? "signal",
      goal: signal.goal ?? workflow?.goal ?? "outcome"
    }).slice(0, 24);
  }

  specialistName(signal, workflow) {
    const domain = signal.domain ?? workflow?.domain ?? "general";
    const task = signal.taskType ?? signal.type ?? "signal";
    return `${domain}-${task}-specialist`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  }
}
