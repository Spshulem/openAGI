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

const DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const AUTOMATED_MEMORY_SOURCES = new Set([
  "agent-host", "ambient-digest", "autopilot", "condenser", "daily-plan", "daily-recap", "runtime"
]);

// These memories exist because the user explicitly asked OpenAGI to retain
// them (or approved a knowledge suggestion). They are never admission-deduped
// or removed by automated duplicate maintenance. Repetition can itself be
// meaningful user evidence, and corrections are a hard safety boundary.
export function isProtectedMemory(item = {}) {
  const tags = new Set((item.tags ?? []).map((tag) => String(tag).toLowerCase()));
  return Boolean(
    item.locked ||
    item.kind === "correction" ||
    item.metadata?.userAuthored ||
    tags.has("correction") ||
    tags.has("tool:remember") ||
    tags.has("import") ||
    (tags.has("knowledge") && tags.has("proactive-suggestion"))
  );
}

function legacyStrengthFloor(item) {
  const tierFloor = item.tier === "long" ? 0.3 : item.tier === "medium" ? 0.25 : 0.2;
  const evidenceFloor = 0.2
    + clamp(item.risk ?? 0) * 0.1
    + clamp(item.novelty ?? 0) * 0.1
    + clamp(item.repetition ?? 0) * 0.1;
  // This is damage repair, not promotion. Recovered rows stay below the
  // ordinary initial-strength baseline for strong memories.
  return Math.min(0.45, Math.max(tierFloor, evidenceFloor));
}

function latestIso(values) {
  let latest = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const ms = Date.parse(value ?? "");
    if (Number.isFinite(ms) && ms > latestMs) {
      latest = value;
      latestMs = ms;
    }
  }
  return latest;
}

export class MemorySystem {
  constructor(options = {}) {
    this.items = new Map();
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
    this.ttlMs = { ...DEFAULT_TTL_MS, ...(options.ttlMs ?? {}) };
    this.vectors = null;
  }

  bindVectorStore(vectorStore) {
    this.vectors = vectorStore;
  }

  dropPrincipleVector(id) {
    if (!this.vectors) return false;
    try {
      return this.vectors.delete("principle", id);
    } catch {
      return false;
    }
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
    const rawContentHash = stableHash(content);
    const tags = [...new Set([...(observation.tags ?? []), ...(context.tags ?? [])])];
    const source = observation.source ?? context.source ?? "runtime";
    const scope = observation.scope ?? context.scope ?? "main";
    const kind = observation.kind ?? context.kind ?? "raw";
    const incomingMetadata = { ...(observation.metadata ?? {}), ...(context.metadata ?? {}) };
    const protectedWrite = isProtectedMemory({
      locked: Boolean(observation.locked ?? context.locked ?? false),
      kind,
      tags,
      source,
      metadata: incomingMetadata
    });

    // Exact automated repeats should reinforce one memory, not occupy another
    // tier slot. Keep this deliberately exact and same-tier/scope/kind: fuzzy
    // merging can erase a meaningful distinction, while exact duplicates add
    // no recall value. Explicit/user-authored memories remain one-for-one.
    if (!protectedWrite) {
      const existing = [...this.items.values()].find((candidate) =>
        !candidate.metadata?.supersededBy &&
        !isProtectedMemory(candidate) &&
        candidate.tier === tier &&
        candidate.scope === scope &&
        candidate.kind === kind &&
        candidate.source === source &&
        [...(candidate.tags ?? [])].map(String).sort().join("\u0000") === [...tags].map(String).sort().join("\u0000") &&
        candidate.rawContentHash === rawContentHash
      );
      if (existing) {
        // Age only the strength that actually existed during the elapsed
        // period. A fresh observation is new evidence: charging the old
        // row's entire history after reinforcement can immediately erase the
        // reinforcement (for example, a 44-day-old medium memory repeated
        // today). Move the decay baseline to this observation before adding
        // its strength.
        this.advanceDecayBaseline(existing, createdAt);
        existing.strength = clamp(Math.max(existing.strength ?? 0, context.strength ?? this.initialStrength(observation, context)) + 0.03);
        existing.repetition = clamp(Math.max(existing.repetition ?? 0, observation.repetition ?? context.repetition ?? 0));
        existing.lastAccessedAt = createdAt;
        existing.lastObservedAt = createdAt;
        existing.metadata = {
          ...(existing.metadata ?? {}),
          // Preserve lineage when independently condensed evidence produces
          // the exact same principle again.
          ...((Array.isArray(existing.metadata?.sources) || Array.isArray(incomingMetadata.sources))
            ? { sources: [...new Set([...(existing.metadata?.sources ?? []), ...(incomingMetadata.sources ?? [])])] }
            : {}),
          duplicateCount: Math.max(1, Number(existing.metadata?.duplicateCount) || 1) + 1,
          duplicateLastSeenAt: createdAt
        };
        return existing;
      }
    }
    const item = {
      id,
      tier,
      content: compressed,
      rawContentHash,
      tags,
      source,
      scope,
      createdAt,
      lastAccessedAt: createdAt,
      lastObservedAt: createdAt,
      // Decay is elapsed-time based. AbiRuntime.tick() runs roughly every ten
      // seconds, so decrementing once per call drained medium memories to zero
      // within minutes. This timestamp makes repeated ticks idempotent.
      lastDecayedAt: createdAt,
      strength: clamp(context.strength ?? this.initialStrength(observation, context)),
      fidelity,
      novelty: clamp(observation.novelty ?? context.novelty ?? 0),
      risk,
      specificity,
      dangerLevel,
      repetition: clamp(observation.repetition ?? context.repetition ?? 0),
      kind,
      // Locked items (user corrections) neither strength-decay nor get
      // evicted/TTL-deleted; past their tier TTL they promote upward instead,
      // so a locked-in correction eventually becomes long-term intuition.
      locked: Boolean(observation.locked ?? context.locked ?? false),
      metadata: {
        ...incomingMetadata
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
      this.dropPrincipleVector(target.id);
    }

    return { item: corrected, superseded: targets };
  }

  decay(now = new Date()) {
    const current = now instanceof Date ? now : new Date(now);
    const removed = [];
    const promoted = [];
    const decayed = [];
    const initialized = [];
    const repaired = [];
    const currentIso = current.toISOString();

    for (const item of [...this.items.values()]) {
      const ageMs = current.getTime() - new Date(item.createdAt).getTime();
      const observedAtMs = Date.parse(item.lastObservedAt ?? item.createdAt);
      const staleAgeMs = current.getTime() - (Number.isFinite(observedAtMs)
        ? observedAtMs
        : new Date(item.createdAt).getTime());
      const ttl = this.ttlMs[item.tier];

      if (ageMs <= ttl) {
        // Locked corrections don't fade.
        if (!item.locked) {
          const lastDecayMs = Date.parse(item.lastDecayedAt ?? "");
          // Existing snapshots predate lastDecayedAt. Establish a baseline on
          // upgrade rather than retroactively charging dozens of decay periods
          // and destroying their remaining strength in one boot.
          if (!Number.isFinite(lastDecayMs)) {
            item.lastDecayedAt = currentIso;
            // Pre-fix rows may have been charged once every ~10 seconds and
            // flattened to zero. Restore a conservative evidence-derived
            // floor once, recording the previous value so the repair remains
            // auditable. Do this before duplicate maintenance; exact repeats
            // will still collapse rather than becoming extra principles.
            const floor = legacyStrengthFloor(item);
            if ((item.strength ?? 0) < floor) {
              const previousStrength = item.strength ?? 0;
              item.strength = floor;
              item.metadata = {
                ...(item.metadata ?? {}),
                decayRepair: { version: 1, at: currentIso, previousStrength }
              };
              repaired.push(item);
            }
            initialized.push(item);
          } else {
            const periods = Math.floor(Math.max(0, current.getTime() - lastDecayMs) / DECAY_INTERVAL_MS);
            if (periods > 0) {
              item.strength = clamp(item.strength - this.decayRate(item.tier) * periods);
              item.lastDecayedAt = new Date(lastDecayMs + periods * DECAY_INTERVAL_MS).toISOString();
              decayed.push(item);
            }
          }
        }
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

      // A fresh exact repeat reinforces the existing row instead of creating
      // a duplicate. Retention follows that latest observation so the newly
      // reinforced fact is not deleted merely because its first copy is old.
      // Promotion above still follows original age/evidence, so repetition
      // cannot keep a strong memory trapped in a lower tier forever.
      if (!superseded && staleAgeMs <= ttl) {
        const lastDecayMs = Date.parse(item.lastDecayedAt ?? "");
        if (!item.locked && Number.isFinite(lastDecayMs)) {
          const periods = Math.floor(Math.max(0, current.getTime() - lastDecayMs) / DECAY_INTERVAL_MS);
          if (periods > 0) {
            item.strength = clamp(item.strength - this.decayRate(item.tier) * periods);
            item.lastDecayedAt = new Date(lastDecayMs + periods * DECAY_INTERVAL_MS).toISOString();
            decayed.push(item);
          }
        }
        continue;
      }

      this.items.delete(item.id);
      removed.push(item);
    }

    return { removed, promoted, decayed, initialized, repaired };
  }

  /**
   * Collapse exact duplicate automated memories already present in a store.
   * `archive` is called before each removal; if it throws, that row stays
   * active. FileBackedMemorySystem stores a content-free audit receipt so the
   * maintenance decision remains traceable without duplicating private text.
   */
  consolidateAutomatedDuplicates({ maxRemovals = 250, archive = null, now = new Date() } = {}) {
    const cap = Number.isFinite(Number(maxRemovals)) ? Math.max(0, Math.trunc(Number(maxRemovals))) : 250;
    const groups = new Map();
    for (const item of this.items.values()) {
      if (isProtectedMemory(item) || item.metadata?.supersededBy || !item.rawContentHash) continue;
      const key = [
        item.tier,
        item.scope ?? "main",
        item.kind ?? "raw",
        item.source ?? "runtime",
        [...(item.tags ?? [])].map(String).sort().join("\u0001"),
        item.rawContentHash
      ].join("\u0000");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }

    const removed = [];
    const retained = [];
    const at = (now instanceof Date ? now : new Date(now)).toISOString();
    for (const group of groups.values()) {
      if (removed.length >= cap || group.length < 2) continue;
      // Historical duplicates may have been independently reinforced after
      // their last decay checkpoint. Compare every row at the same merge time:
      // normalizing only through each row's own observation lets an old, strong
      // copy beat fresher evidence and then inherit the fresh copy's checkpoint
      // without paying the intervening decay. This is maintenance rather than a
      // new observation, so preserve the sub-period remainder instead of moving
      // every checkpoint all the way to `at`.
      for (const item of group) {
        this.advanceDecayBaseline(item, at, { preserveRemainder: true });
      }
      const ordered = [...group].sort((a, b) =>
        (b.strength ?? 0) - (a.strength ?? 0) ||
        String(b.lastAccessedAt ?? "").localeCompare(String(a.lastAccessedAt ?? "")) ||
        String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""))
      );
      const canonical = ordered[0];
      let merged = 0;
      const mergedItems = [canonical];
      for (const duplicate of ordered.slice(1)) {
        if (removed.length >= cap) break;
        try {
          archive?.({ at, canonicalId: canonical.id, item: duplicate });
        } catch {
          continue;
        }
        this.items.delete(duplicate.id);
        this.dropPrincipleVector(duplicate.id);
        removed.push(duplicate);
        mergedItems.push(duplicate);
        merged += 1;
      }
      if (merged > 0) {
        canonical.strength = Math.max(canonical.strength ?? 0, ...mergedItems.map((item) => item.strength ?? 0));
        canonical.repetition = clamp(Math.max(canonical.repetition ?? 0, ...mergedItems.map((item) => item.repetition ?? 0)));
        canonical.lastObservedAt = latestIso(mergedItems.map((item) => item.lastObservedAt ?? item.createdAt));
        canonical.lastAccessedAt = latestIso(mergedItems.map((item) => item.lastAccessedAt ?? item.createdAt));
        canonical.lastDecayedAt = latestIso([
          ...mergedItems.map((item) => item.lastDecayedAt),
          canonical.lastObservedAt
        ]) ?? canonical.lastDecayedAt;
        canonical.metadata = {
          ...(canonical.metadata ?? {}),
          duplicateCount: Math.max(1, Number(canonical.metadata?.duplicateCount) || 1) + merged,
          duplicatesConsolidatedAt: at
        };
        retained.push(canonical);
      }
    }
    return { groups: retained.length, removed, retained };
  }

  retireWeakAutomatedNoise({
    maxRemovals = 100,
    minAgeDays = 30,
    maxStrength = 0.25,
    maxInactiveStrength = 0.4,
    archive = null,
    now = new Date()
  } = {}) {
    const at = now instanceof Date ? now : new Date(now);
    const cutoff = at.getTime() - Math.max(1, Number(minAgeDays) || 30) * 24 * 60 * 60 * 1000;
    const cap = Math.max(0, Math.min(500, Number(maxRemovals) || 0));
    const removed = [];
    const candidates = [...this.items.values()]
      .filter((item) => {
        const lastEvidence = Date.parse(item.lastObservedAt ?? item.lastAccessedAt ?? item.createdAt ?? "");
        const lastRecall = Date.parse(item.lastAccessedAt ?? item.createdAt ?? "");
        const strictlyLowSignal = item.kind !== "principle"
          && Number(item.strength ?? 0) <= maxStrength
          && Number(item.risk ?? 0) < 0.3
          && Number(item.novelty ?? 0) < 0.3
          && Number(item.repetition ?? 0) < 0.2;
        const source = String(item.source ?? "");
        const syntheticCondenserPrinciple = source === "condenser" && item.kind === "principle";
        const inactiveAutomated = AUTOMATED_MEMORY_SOURCES.has(source)
          && Number(item.strength ?? 0) < maxInactiveStrength
          && Number(item.dangerLevel ?? 0) < 0.75
          // Strong recurrence remains evidence even when recall is quiet. The
          // legacy low-signal path above already requires <0.2. Condenser
          // principles are the exception: the condenser assigns 0.8 to every
          // output as a construction default, so that value is not independent
          // evidence that this particular principle kept recurring.
          && (syntheticCondenserPrinciple || Number(item.repetition ?? 0) < 0.8)
          && Number.isFinite(lastRecall)
          && lastRecall < cutoff;
        return !isProtectedMemory(item)
          && !item.metadata?.supersededBy
          && Number.isFinite(lastEvidence)
          && lastEvidence < cutoff
          && (strictlyLowSignal || inactiveAutomated);
      })
      .sort((a, b) => String(a.lastObservedAt ?? a.createdAt).localeCompare(String(b.lastObservedAt ?? b.createdAt)));

    for (const item of candidates.slice(0, cap)) {
      try {
        archive?.({ at: at.toISOString(), item });
      } catch {
        continue;
      }
      this.items.delete(item.id);
      this.dropPrincipleVector(item.id);
      removed.push(item);
    }
    return { removed, deferred: Math.max(0, candidates.length - removed.length) };
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
      lastObservedAt: now,
      lastDecayedAt: now,
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

  advanceDecayBaseline(item, at, { preserveRemainder = false } = {}) {
    if (!item || item.locked) return 0;
    const atMs = at instanceof Date ? at.getTime() : Date.parse(at ?? "");
    if (!Number.isFinite(atMs)) return 0;
    const lastDecayMs = Date.parse(item.lastDecayedAt ?? "");
    let periods = 0;
    if (Number.isFinite(lastDecayMs) && atMs > lastDecayMs) {
      periods = Math.floor((atMs - lastDecayMs) / DECAY_INTERVAL_MS);
      if (periods > 0) {
        item.strength = clamp((item.strength ?? 0) - this.decayRate(item.tier) * periods);
      }
    }
    // A repeat is a new evidence boundary even when less than one full decay
    // interval elapsed. Consolidation, however, is maintenance rather than new
    // evidence and must retain the fractional interval for the next decay tick.
    // Never move a checkpoint backwards for imported data.
    const advancedToMs = Number.isFinite(lastDecayMs)
      ? preserveRemainder
        ? lastDecayMs + periods * DECAY_INTERVAL_MS
        : Math.max(lastDecayMs, atMs)
      : atMs;
    item.lastDecayedAt = new Date(advancedToMs).toISOString();
    return periods;
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
      .forEach((item) => {
        this.items.delete(item.id);
        this.dropPrincipleVector(item.id);
      });
  }
}
