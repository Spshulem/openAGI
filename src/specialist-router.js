import { tokenOverlapScore } from "./utils.js";

// Routes incoming signals to a bounded specialist when its scope matches strongly.
// v1: keyword + tag overlap (no embedding cost). v2 (D2) swaps in semantic similarity.

const DEFAULT_THRESHOLD = 0.55;

export class SpecialistRouter {
  constructor(options = {}) {
    this.threshold = options.threshold ?? Number.parseFloat(process.env.OPENAGI_ROUTING_THRESHOLD ?? String(DEFAULT_THRESHOLD));
    this.mode = options.mode ?? process.env.OPENAGI_ROUTING_MODE ?? "live"; // live | shadow | off
    this.minActivations = options.minActivations ?? 1;
  }

  /**
   * Score every active specialist for the given signal text.
   * Returns sorted list of { specialist, score, breakdown }.
   */
  search(signalText, signalTags, specialists) {
    const out = [];
    const text = String(signalText ?? "");
    const tags = new Set((signalTags ?? []).map((t) => String(t).toLowerCase()));
    for (const sp of specialists ?? []) {
      if (sp.status === "retired") continue;
      if ((sp.activationCount ?? 0) < this.minActivations) continue;
      const breakdown = scoreMatch(text, tags, sp);
      out.push({ specialist: sp, score: breakdown.score, breakdown });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /**
   * Decide whether to route. Returns { mode, route, candidate, all } where:
   * - mode: 'live' | 'shadow' | 'off'
   * - route: true if the agent should hand off
   * - candidate: top specialist (or null)
   */
  decide(signalText, signalTags, specialists) {
    if (this.mode === "off") return { mode: "off", route: false, candidate: null, all: [] };
    const all = this.search(signalText, signalTags, specialists);
    const top = all[0] ?? null;
    const matched = Boolean(top && top.score >= this.threshold);
    return {
      mode: this.mode,
      route: this.mode === "live" && matched,
      candidate: matched ? top : null,
      threshold: this.threshold,
      all
    };
  }
}

function scoreMatch(text, tags, specialist) {
  const scopeText = `${specialist.boundedScope ?? ""} ${specialist.name ?? ""} ${specialist.parentGoal ?? ""}`;
  const scopeTags = new Set([
    specialist.metadata?.domain ?? "",
    specialist.metadata?.taskType ?? "",
    ...(specialist.metadata?.tags ?? [])
  ].filter(Boolean).map((t) => t.toLowerCase()));

  const textScore = tokenOverlapScore(text, scopeText);

  let tagScore = 0;
  if (tags.size > 0 && scopeTags.size > 0) {
    let hits = 0;
    for (const t of tags) if (scopeTags.has(t)) hits += 1;
    tagScore = hits / Math.min(tags.size, scopeTags.size);
  }

  // Activation count gives a small boost to proven specialists.
  const activationBoost = Math.min(0.1, Math.log10((specialist.activationCount ?? 1) + 1) * 0.05);

  // Recency penalty: cold specialists drift toward the bottom even with text overlap.
  const lastActivated = specialist.lastActivatedAt ? new Date(specialist.lastActivatedAt).getTime() : 0;
  const ageDays = lastActivated > 0 ? (Date.now() - lastActivated) / (1000 * 60 * 60 * 24) : 9999;
  const recencyPenalty = ageDays > 60 ? 0.1 : ageDays > 30 ? 0.05 : 0;

  // Both signals weight equally; bonus when both fire (corroboration is itself a match signal).
  const baseScore = textScore * 0.5 + tagScore * 0.5;
  const corroborationBonus = textScore > 0.1 && tagScore > 0.1 ? 0.1 : 0;
  const combined = baseScore + corroborationBonus + activationBoost - recencyPenalty;

  return {
    score: Math.max(0, Math.min(1, combined)),
    textScore,
    tagScore,
    corroborationBonus,
    activationBoost,
    recencyPenalty
  };
}
