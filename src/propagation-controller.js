import { clamp, createId, nowIso, stableHash, summarizeText } from "./utils.js";

export class PropagationController {
  constructor(options = {}) {
    this.specialists = new Map();
    this.maxSpecialists = options.maxSpecialists ?? 25;
    this.repetitionThreshold = options.repetitionThreshold ?? 0.72;
    this.riskNoveltyThreshold = options.riskNoveltyThreshold ?? 0.62;
  }

  shouldPropagate({ signal, scrutiny, memoryHits = [] }) {
    const repetition = clamp(signal.repetition ?? scrutiny?.dimensions?.repetition ?? 0);
    const risk = clamp(signal.risk ?? scrutiny?.dimensions?.risk ?? 0);
    const novelty = clamp(signal.novelty ?? scrutiny?.dimensions?.novelty ?? 0);
    const memoryCoverage = clamp(memoryHits.reduce((sum, hit) => sum + hit.score, 0) / Math.max(memoryHits.length, 1));
    const repeated = repetition >= this.repetitionThreshold;
    const novelAndRisky = risk * novelty >= this.riskNoveltyThreshold;
    const explicitlyRequired = signal.requiresSpecialist === true || scrutiny?.action === "propagate";
    const underCovered = memoryCoverage < 0.35 && risk >= 0.6;

    return {
      decision: explicitlyRequired || repeated || novelAndRisky || underCovered,
      repeated,
      novelAndRisky,
      explicitlyRequired,
      underCovered,
      memoryCoverage
    };
  }

  propagate({ signal, workflow, scrutiny, tools = [] }) {
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

    const specialist = {
      id: createId("agent"),
      signature,
      name: this.specialistName(signal, workflow),
      parentGoal: workflow?.goal ?? signal.goal ?? "Improve outcome from signal evidence.",
      boundedScope: summarizeText(signal.specialistScope ?? signal.summary ?? signal.content ?? "Investigate and act on this signal class.", 240),
      successMetric: signal.successMetric ?? workflow?.successMetric ?? "Produces cited, actionable recommendations with lower repeated parent effort.",
      allowedTools: tools.map((tool) => (typeof tool === "string" ? tool : tool.name)).filter(Boolean),
      status: "available",
      createdAt: nowIso(),
      lastActivatedAt: nowIso(),
      activationCount: 1,
      reasons: scrutiny?.reasons ?? []
    };

    this.specialists.set(signature, specialist);
    return { created: true, reason: "specialist-created", specialist };
  }

  list() {
    return [...this.specialists.values()].sort((a, b) => b.lastActivatedAt.localeCompare(a.lastActivatedAt));
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
