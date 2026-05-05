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
    const item = {
      id,
      tier,
      content: compressed,
      rawContentHash: stableHash(content),
      tags: [...new Set([...(observation.tags ?? []), ...(context.tags ?? [])])],
      source: observation.source ?? context.source ?? "runtime",
      createdAt,
      lastAccessedAt: createdAt,
      strength: clamp(context.strength ?? this.initialStrength(observation, context)),
      fidelity,
      novelty: clamp(observation.novelty ?? context.novelty ?? 0),
      risk: clamp(observation.risk ?? context.risk ?? 0),
      repetition: clamp(observation.repetition ?? context.repetition ?? 0),
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

    const scored = [];
    for (const item of this.items.values()) {
      if (!tiers.has(item.tier)) continue;
      const textScore = tokenOverlapScore(queryText, `${item.content} ${item.tags.join(" ")}`);
      const tierWeight = item.tier === "short" ? 1.15 : item.tier === "medium" ? 1 : 0.85;
      const strengthWeight = 0.4 + item.strength * 0.6;
      const score = textScore * tierWeight * strengthWeight;
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

  decay(now = new Date()) {
    const current = now instanceof Date ? now : new Date(now);
    const removed = [];
    const promoted = [];

    for (const item of [...this.items.values()]) {
      const ageMs = current.getTime() - new Date(item.createdAt).getTime();
      const ttl = this.ttlMs[item.tier];

      if (ageMs <= ttl) {
        item.strength = clamp(item.strength - this.decayRate(item.tier));
        continue;
      }

      if (item.tier === "short" && (item.repetition >= 0.55 || item.risk >= 0.7 || item.novelty >= 0.7)) {
        const medium = this.promote(item, "medium", current.toISOString());
        promoted.push(medium);
        continue;
      }

      if (item.tier === "medium" && (item.risk >= 0.8 || item.repetition >= 0.75)) {
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

  compressForTier(content, tier, fidelity) {
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

    tierItems
      .sort((a, b) => a.strength - b.strength || a.lastAccessedAt.localeCompare(b.lastAccessedAt))
      .slice(0, tierItems.length - limit)
      .forEach((item) => this.items.delete(item.id));
  }
}
