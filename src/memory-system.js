import { clamp, createId, nowIso, stableHash, summarizeText, tokenOverlapScore } from "./utils.js";

const DEFAULT_LIMITS = {
  short: 100,
  medium: 500,
  long: 1000
};

const DEFAULT_TTL_MS = {
  short: 1000 * 60 * 60 * 8,
  medium: 1000 * 60 * 60 * 24 * 45,
  long: Number.POSITIVE_INFINITY
};

export class MemorySystem {
  constructor(options = {}) {
    this.items = new Map();
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
    this.ttlMs = { ...DEFAULT_TTL_MS, ...(options.ttlMs ?? {}) };
  }

  remember(observation, context = {}) {
    const createdAt = context.now ?? nowIso();
    const tier = context.tier ?? this.selectTier(observation, context);
    const content = this.formatContent(observation);
    const fidelity = this.selectFidelity(tier, observation, context);
    const compressed = this.compressForTier(content, tier, fidelity);
    const id = context.id ?? createId(`mem_${tier}`);
    const risk = clamp(observation.risk ?? context.risk ?? 0);
    const specificity = clamp(observation.specificity ?? context.specificity ?? 0.45);
    // dangerLevel: high-risk + high-specificity items ("hourglass on a spider will kill you")
    // resist compression and outrank generic recalls when their tags match.
    const dangerLevel = clamp(risk * 0.6 + specificity * 0.4);
    const item = {
      id,
      tier,
      content: compressed,
      rawContentHash: stableHash(content),
      tags: [...new Set([...(observation.tags ?? []), ...(context.tags ?? [])])],
      source: observation.source ?? context.source ?? "runtime",
      scope: observation.scope ?? context.scope ?? "main",
      createdAt,
      lastAccessedAt: createdAt,
      strength: clamp(context.strength ?? this.initialStrength(observation, context)),
      fidelity,
      novelty: clamp(observation.novelty ?? context.novelty ?? 0),
      risk,
      specificity,
      dangerLevel,
      repetition: clamp(observation.repetition ?? context.repetition ?? 0),
      kind: observation.kind ?? context.kind ?? "raw",
      // Locked items (user corrections) neither strength-decay nor get
      // evicted/TTL-deleted; past their tier TTL they promote upward instead,
      // so a locked-in correction eventually becomes long-term intuition.
      locked: Boolean(observation.locked ?? context.locked ?? false),
      metadata: {
        ...(observation.metadata ?? {}),
        ...(context.metadata ?? {})
      }
    };

    this.items.set(item.id, item);
    this.enforceLimits(tier);
    return item;
  }

  retrieve(query, options = {}) {
    const tiers = new Set(options.tiers ?? ["short", "medium", "long"]);
    const limit = options.limit ?? 8;
    const queryText = typeof query === "string" ? query : this.formatContent(query);
    const queryTags = new Set((options.tags ?? []).map((t) => String(t).toLowerCase()));
    const scope = options.scope ?? null;

    const scored = [];
    for (const item of this.items.values()) {
      if (!tiers.has(item.tier)) continue;
      if (scope && item.scope && item.scope !== scope && item.scope !== "main") continue;
      // Superseded items were corrected by the user — never recall the stale
      // version (the correction itself carries the fact forward).
      if (item.metadata?.supersededBy) continue;
      const textScore = tokenOverlapScore(queryText, `${item.content} ${item.tags.join(" ")}`);
      const tierWeight = item.tier === "short" ? 1.15 : item.tier === "medium" ? 1 : 0.85;
      const strengthWeight = 0.4 + item.strength * 0.6;
      // Danger boost: high-specificity high-risk items outrank for tag-matched recalls.
      let dangerBoost = 0;
      if ((item.dangerLevel ?? 0) > 0.65 && queryTags.size > 0) {
        const hits = item.tags.filter((t) => queryTags.has(String(t).toLowerCase())).length;
        if (hits > 0) dangerBoost = 0.25 * (item.dangerLevel ?? 0);
      }
      // Principle boost: distilled principles get a small edge in long-tier recall.
      const principleBoost = item.kind === "principle" ? 0.1 : 0;
      // Corrections outrank whatever they replaced; fidelity finally feeds the
      // ranking ("the hourglass on the spider"): specific-fidelity items edge
      // out generic ones when both match. Gated on a real text match so
      // unrelated corrections/specific items don't surface on every query.
      const correctionBoost = textScore > 0 && item.kind === "correction" ? 0.3 : 0;
      const fidelityBoost = textScore > 0 && item.fidelity === "specific" ? 0.05 : 0;
      const score = textScore * tierWeight * strengthWeight + dangerBoost + principleBoost + correctionBoost + fidelityBoost;
      if (score > 0) scored.push({ item, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const now = options.now ?? nowIso();
    for (const entry of scored.slice(0, limit)) {
      entry.item.lastAccessedAt = now;
      entry.item.strength = clamp(entry.item.strength + 0.03);
    }
    return scored.slice(0, limit);
  }

  reinforce(id, amount = 0.1) {
    const item = this.items.get(id);
    if (!item) return null;
    item.strength = clamp(item.strength + amount);
    item.lastAccessedAt = nowIso();
    return item;
  }

  /**
   * Lock in a correction: hide the stale memory from all future retrieval
   * and store the corrected fact as a locked item ("learn it once, never
   * make that mistake again"). The stale item(s) are matched by explicit
   * `id`, or by retrieval on `query` — only the top hit and its near-ties
   * are superseded, so a fuzzy query can't bury unrelated memories.
   * Returns { item, superseded } where `item` is the new locked correction.
   */
  correct({ id = null, query = null, content, tags = [], scope = "main", source = "correction", metadata = {} } = {}) {
    const text = String(content ?? "").trim();
    if (!text) throw new Error("correct() requires the corrected content.");

    const targets = [];
    if (id) {
      const item = this.items.get(id);
      // A prior correction CAN be re-corrected (9:00 → 9:30 → 10:00): supersede
      // even locked items, just not one already superseded.
      if (item && !item.metadata?.supersededBy) targets.push(item);
    } else if (query) {
      const hits = this.retrieve(query, { limit: 5, scope });
      const top = hits[0]?.score ?? 0;
      for (const { item, score } of hits) {
        // retrieve() already hides superseded items; corrections themselves are
        // fair game so a re-correction supersedes the prior one (no stacking).
        if (score >= 0.15 && score >= top * 0.8) targets.push(item);
        if (targets.length >= 3) break;
      }
    }

    // The correction inherits the staleness-resistant traits of what it
    // replaces: at least medium tier (corrections must outlive RAM), the
    // highest tier among its targets, and high specificity.
    const tierRank = { short: 0, medium: 1, long: 2 };
    const targetTier = targets.reduce((best, t) => (tierRank[t.tier] > tierRank[best] ? t.tier : best), "medium");
    const inheritedTags = [...new Set(targets.flatMap((t) => t.tags ?? []))];

    const corrected = this.remember(
      {
        source,
        scope,
        content: text,
        tags: [...new Set(["correction", ...inheritedTags, ...tags])],
        risk: Math.max(0.3, ...targets.map((t) => t.risk ?? 0)),
        specificity: 0.85,
        novelty: 0.4,
        repetition: 0.3,
        kind: "correction",
        locked: true,
        metadata: { ...metadata, corrects: targets.map((t) => t.id) }
      },
      { strength: 1.0, tier: targetTier }
    );

    const at = nowIso();
    for (const target of targets) {
      target.metadata = { ...target.metadata, supersededBy: corrected.id, supersededAt: at };
    }

    return { item: corrected, superseded: targets };
  }

  decay(now = new Date()) {
    const current = now instanceof Date ? now : new Date(now);
    const removed = [];
    const promoted = [];

    for (const item of [...this.items.values()]) {
      const ageMs = current.getTime() - new Date(item.createdAt).getTime();
      const ttl = this.ttlMs[item.tier];

      if (ageMs <= ttl) {
        // Locked corrections don't fade.
        if (!item.locked) item.strength = clamp(item.strength - this.decayRate(item.tier));
        continue;
      }

      // Superseded items never promote — a corrected fact must not ride the
      // promotion path into long-term memory. They expire on tier TTL.
      const superseded = Boolean(item.metadata?.supersededBy);

      if (!superseded && item.tier === "short" && (item.locked || item.repetition >= 0.55 || item.risk >= 0.7 || item.novelty >= 0.7)) {
        const medium = this.promote(item, "medium", current.toISOString());
        promoted.push(medium);
        continue;
      }

      if (!superseded && item.tier === "medium" && (item.locked || item.risk >= 0.8 || item.repetition >= 0.75)) {
        const long = this.promote(item, "long", current.toISOString());
        promoted.push(long);
        continue;
      }

      this.items.delete(item.id);
      removed.push(item);
    }

    return { removed, promoted };
  }

  snapshot() {
    return {
      short: this.byTier("short"),
      medium: this.byTier("medium"),
      long: this.byTier("long")
    };
  }

  byTier(tier) {
    return [...this.items.values()]
      .filter((item) => item.tier === tier)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  selectTier(observation, context) {
    const risk = clamp(observation.risk ?? context.risk ?? 0);
    const novelty = clamp(observation.novelty ?? context.novelty ?? 0);
    const repetition = clamp(observation.repetition ?? context.repetition ?? 0);
    const critical = observation.critical === true || context.critical === true;

    if (critical || risk >= 0.85 || (risk >= 0.7 && novelty >= 0.6)) return "long";
    if (repetition >= 0.5 || novelty >= 0.55 || risk >= 0.45) return "medium";
    return "short";
  }

  selectFidelity(tier, observation, context) {
    const risk = clamp(observation.risk ?? context.risk ?? 0);
    const specificity = clamp(observation.specificity ?? context.specificity ?? 0.5);
    if (risk >= 0.75 || specificity >= 0.8) return "specific";
    if (tier === "long") return "compressed";
    return "normal";
  }

  initialStrength(observation, context) {
    return clamp(
      0.35 +
        clamp(observation.risk ?? context.risk ?? 0) * 0.25 +
        clamp(observation.novelty ?? context.novelty ?? 0) * 0.2 +
        clamp(observation.repetition ?? context.repetition ?? 0) * 0.2
    );
  }

  formatContent(observation) {
    if (typeof observation === "string") return observation;
    return observation.content ?? observation.summary ?? JSON.stringify(observation);
  }

  compressForTier(content, tier, fidelity, dangerLevel = 0) {
    // High-danger items resist compression at every tier — preserve specificity.
    if (dangerLevel > 0.7) return summarizeText(content, 1200);
    if (fidelity === "specific") return summarizeText(content, tier === "long" ? 900 : 700);
    if (tier === "long") return summarizeText(content, 360);
    if (tier === "medium") return summarizeText(content, 620);
    return summarizeText(content, 900);
  }

  promote(item, tier, now) {
    const promoted = {
      ...item,
      id: createId(`mem_${tier}`),
      tier,
      content: this.compressForTier(item.content, tier, item.fidelity),
      createdAt: now,
      lastAccessedAt: now,
      strength: clamp(item.strength + 0.08)
    };
    this.items.delete(item.id);
    this.items.set(promoted.id, promoted);
    this.enforceLimits(tier);
    return promoted;
  }

  decayRate(tier) {
    if (tier === "short") return 0.03;
    if (tier === "medium") return 0.01;
    return 0.002;
  }

  enforceLimits(tier) {
    const limit = this.limits[tier];
    const tierItems = this.byTier(tier);
    if (tierItems.length <= limit) return;

    // Locked corrections are exempt from cap eviction (low volume by nature;
    // a tier may briefly exceed its cap rather than forget a correction).
    tierItems
      .filter((item) => !item.locked)
      .sort((a, b) => a.strength - b.strength || a.lastAccessedAt.localeCompare(b.lastAccessedAt))
      .slice(0, Math.max(0, tierItems.length - limit))
      .forEach((item) => this.items.delete(item.id));
  }
}
