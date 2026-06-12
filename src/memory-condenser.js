import { createId, nowIso, tokenize } from "./utils.js";

// Condenses raw memory items into distilled "principles" stored in long-tier.
// Sources keep their normal lifecycle and may decay; principles outlive them.
//
// Strategy:
//   1. Group medium-tier raw items by tag overlap.
//   2. For each group of >= MIN_GROUP_SIZE, ask the model provider to distill
//      into a 200–400 char principle. Fall back to extractive summary when no
//      LLM is configured (deterministic provider).
//   3. Write principle to long-tier with metadata { kind: 'principle', sources,
//      confidence, quarantineUntil }.
//   4. Quarantine principles for QUARANTINE_DAYS so contradictions can retire
//      them before they propagate. Promotion check is implicit: principles are
//      already in long-tier, but their `confidence` is read by recall ranking.

const MIN_GROUP_SIZE = 3;
const MAX_GROUPS_PER_RUN = 8;
const QUARANTINE_DAYS = 7;

export class MemoryCondenser {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.minGroupSize = options.minGroupSize ?? MIN_GROUP_SIZE;
    this.maxGroupsPerRun = options.maxGroupsPerRun ?? MAX_GROUPS_PER_RUN;
    this.quarantineDays = options.quarantineDays ?? QUARANTINE_DAYS;
  }

  async condense({ now = new Date(), scope = null, writeScope = null, originSpecialistId = null } = {}) {
    if (!this.runtime?.memory) throw new Error("MemoryCondenser requires a runtime with memory.");
    let candidates = [...this.runtime.memory.byTier("medium"), ...this.runtime.memory.byTier("short")]
      .filter((item) => item.kind !== "principle" && !item.metadata?.condensedInto);
    if (scope) {
      candidates = candidates.filter((item) => item.scope === scope);
    } else {
      candidates = candidates.filter((item) => !item.scope || item.scope === "main");
    }
    if (candidates.length < this.minGroupSize) {
      return { groups: 0, principles: 0, reason: "not enough items in scope" };
    }
    const groups = clusterByTagOverlap(candidates, this.minGroupSize).slice(0, this.maxGroupsPerRun);
    const principles = [];

    for (const group of groups) {
      const principle = await this.distill(group);
      if (!principle) continue;
      const quarantineUntil = new Date(now.getTime() + this.quarantineDays * 86400 * 1000).toISOString();
      const tags = [...new Set(group.flatMap((m) => m.tags ?? []).concat(["principle"]))];
      if (originSpecialistId) tags.push(`legacy:${originSpecialistId}`);
      const item = this.runtime.memory.remember(
        {
          source: originSpecialistId ? "legacy" : "condenser",
          kind: "principle",
          scope: writeScope ?? "main",
          content: principle.text,
          tags,
          risk: median(group.map((m) => m.risk ?? 0)),
          specificity: 0.7,
          repetition: 0.8,
          metadata: {
            sources: group.map((m) => m.id),
            confidence: principle.confidence,
            quarantineUntil,
            distilledAt: nowIso(),
            originSpecialistId: originSpecialistId ?? null
          }
        },
        { source: originSpecialistId ? "legacy" : "condenser", strength: 0.8, tier: "long", critical: true }
      );
      // Index for Lava intuition lookups.
      this.runtime.vectorStore?.upsert("principle", item.id, principle.text, {
        confidence: principle.confidence,
        tags: item.tags
      }).catch(() => {});
      // Mark sources so we don't re-condense them.
      for (const src of group) {
        const existing = this.runtime.memory.items.get(src.id);
        if (existing) existing.metadata = { ...(existing.metadata ?? {}), condensedInto: item.id };
      }
      principles.push({ id: item.id, sources: group.map((m) => m.id), text: principle.text, confidence: principle.confidence });
    }

    if (typeof this.runtime.memory.persist === "function") this.runtime.memory.persist("condense", { count: principles.length });
    return { groups: groups.length, principles: principles.length, items: principles };
  }

  async distill(items) {
    const provider = this.runtime?.agentHost?.modelProvider;
    const prompt = buildDistillPrompt(items);

    // LLM path
    if (provider?.isConfigured?.() && typeof provider.generate === "function" && provider.constructor.name !== "DeterministicModelProvider") {
      try {
        const result = await provider.generate({
          input: prompt,
          task: "condense",
          agent: { id: "condenser", name: "memory-condenser" },
          memoryHits: [],
          messages: [],
          tools: [],
          toolRegistry: null,
          instructions: "You are a memory condenser. Read the raw notes and emit ONE distilled principle (200–400 chars, plain prose). Be specific where it matters; don't generalize danger away. End with `(confidence: high|medium|low)`. Output only the principle, no preamble.",
          context: {}
        });
        return parsePrinciple(result.text);
      } catch (error) {
        // fall through to extractive
      }
    }

    // Extractive fallback (deterministic)
    return extractive(items);
  }
}

function clusterByTagOverlap(items, minGroupSize) {
  const groups = [];
  const used = new Set();
  // Greedy: pick each unused item, gather everything that shares >=2 tags.
  for (const seed of items) {
    if (used.has(seed.id)) continue;
    const seedTags = new Set((seed.tags ?? []).map((t) => String(t).toLowerCase()));
    const cluster = [seed];
    used.add(seed.id);
    for (const candidate of items) {
      if (used.has(candidate.id)) continue;
      const cTags = new Set((candidate.tags ?? []).map((t) => String(t).toLowerCase()));
      let overlap = 0;
      for (const t of cTags) if (seedTags.has(t)) overlap += 1;
      if (overlap >= 2) {
        cluster.push(candidate);
        used.add(candidate.id);
      }
    }
    if (cluster.length >= minGroupSize) groups.push(cluster);
  }
  return groups;
}

function buildDistillPrompt(items) {
  const lines = items.map((m, i) => `(${i + 1}) [tags: ${(m.tags ?? []).join(", ")}] ${m.content}`).join("\n");
  return `Distill the following ${items.length} related notes into ONE durable principle (200–400 chars). Preserve specifics that matter for safety or correctness. Plain prose, no markdown. End with "(confidence: high|medium|low)".

${lines}`;
}

function parsePrinciple(text) {
  const match = /\(confidence:\s*(high|medium|low)\s*\)\s*$/i.exec(text);
  const confidence = match ? match[1].toLowerCase() : "medium";
  const cleaned = match ? text.slice(0, match.index).trim() : text.trim();
  if (!cleaned) return null;
  return { text: cleaned, confidence };
}

function extractive(items) {
  // Pick the most-shared salient phrase via token frequency; fallback to longest item.
  const tokenCounts = new Map();
  for (const item of items) {
    for (const t of tokenize(item.content)) {
      if (t.length < 4) continue;
      tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1);
    }
  }
  const longest = items.slice().sort((a, b) => (b.content?.length ?? 0) - (a.content?.length ?? 0))[0];
  return {
    text: `Pattern across ${items.length} notes: ${longest.content.slice(0, 320)}`,
    confidence: "low"
  };
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
