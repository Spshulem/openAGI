// Corrections lock in, never repeat: correct() supersedes the stale memory
// (hidden from recall forever) and stores a locked correction that neither
// decays, expires, nor gets evicted — and promotes toward long-term instead.
// Plus: fidelity finally feeds retrieval ranking.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemorySystem } from "../src/memory-system.js";
import { FileBackedMemorySystem } from "../src/file-backed-memory-system.js";
import { ToolRegistry, registerCoreTools } from "../src/index.js";

function seedStaleFact(memory) {
  return memory.remember(
    { source: "test", content: "The Acme review meeting is at 3pm on Thursday", tags: ["meeting", "acme"], specificity: 0.7 },
    { strength: 0.8 }
  );
}

test("correct() supersedes the stale memory and recall returns only the correction", () => {
  const memory = new MemorySystem();
  const stale = seedStaleFact(memory);

  const { item, superseded } = memory.correct({
    query: "Acme review meeting time",
    content: "The Acme review meeting is at 4pm on Thursday, not 3pm"
  });

  assert.equal(superseded.length, 1);
  assert.equal(superseded[0].id, stale.id);
  assert.equal(stale.metadata.supersededBy, item.id);
  assert.equal(item.locked, true);
  assert.equal(item.kind, "correction");
  assert.equal(item.strength, 1);
  assert.ok(item.tags.includes("correction"));
  assert.ok(item.tags.includes("acme"), "correction inherits the stale item's tags");

  const hits = memory.retrieve("Acme review meeting time");
  assert.ok(hits.length > 0);
  assert.equal(hits[0].item.id, item.id, "the correction ranks first");
  assert.ok(!hits.some((h) => h.item.id === stale.id), "the stale fact never resurfaces");
});

test("correct() by explicit id supersedes exactly that item", () => {
  const memory = new MemorySystem();
  const stale = seedStaleFact(memory);
  const other = memory.remember({ source: "test", content: "Standup is 9am Mondays", tags: ["meeting"] });

  const { superseded } = memory.correct({ id: stale.id, content: "Acme review moved to Friday" });
  assert.deepEqual(superseded.map((s) => s.id), [stale.id]);
  assert.equal(other.metadata.supersededBy, undefined, "unrelated memories untouched");
});

test("a vague query with no confident match supersedes nothing but still locks in the fact", () => {
  const memory = new MemorySystem();
  seedStaleFact(memory);
  const { item, superseded } = memory.correct({ query: "zzz qqq unrelated nonsense", content: "Spencer prefers tea over coffee" });
  assert.equal(superseded.length, 0);
  assert.equal(item.locked, true);
});

test("locked corrections don't decay, don't evict, and promote toward long-term", () => {
  const memory = new MemorySystem({ limits: { short: 100, medium: 2, long: 100 } });
  const { item } = memory.correct({ content: "Production deploys are Tuesdays ONLY" });
  assert.equal(item.tier, "medium");

  // Strength does not fade with decay ticks.
  memory.decay(new Date());
  assert.equal(memory.items.get(item.id).strength, 1);

  // Cap eviction skips locked items even when the tier is over its limit.
  memory.remember({ source: "t", content: "filler one" }, { tier: "medium", strength: 0.05 });
  memory.remember({ source: "t", content: "filler two" }, { tier: "medium", strength: 0.05 });
  memory.remember({ source: "t", content: "filler three" }, { tier: "medium", strength: 0.05 });
  assert.ok(memory.items.get(item.id), "correction survives cap eviction");

  // Past the medium TTL (45d), a locked item promotes to long instead of deleting.
  const future = new Date(Date.now() + 50 * 24 * 60 * 60 * 1000);
  const { promoted, removed } = memory.decay(future);
  const promotedCorrection = promoted.find((p) => p.kind === "correction");
  assert.ok(promotedCorrection, "locked correction promotes at TTL");
  assert.equal(promotedCorrection.tier, "long");
  assert.ok(!removed.some((r) => r.kind === "correction"));
});

test("superseded items never promote into long-term memory", () => {
  const memory = new MemorySystem();
  // A high-repetition fact that would normally promote medium → long.
  const stale = memory.remember(
    { source: "t", content: "Weekly report goes to alice@example.com", repetition: 0.9, tags: ["report"] },
    { tier: "medium", strength: 0.8 }
  );
  memory.correct({ id: stale.id, content: "Weekly report goes to bob@example.com now" });

  const future = new Date(Date.now() + 50 * 24 * 60 * 60 * 1000);
  const { promoted, removed } = memory.decay(future);
  assert.ok(!promoted.some((p) => p.id === stale.id), "stale fact must not ride promotion to Lava");
  assert.ok(removed.some((r) => r.id === stale.id), "stale fact expires at TTL instead");
});

test("fidelity feeds ranking: specific items edge out generic ones on equal matches", () => {
  const memory = new MemorySystem();
  // Same tier + strength + comparable text match, so the only differentiator
  // is fidelity ("specific" from high specificity vs "normal").
  const generic = memory.remember(
    { source: "t", content: "spiders are dangerous to people sometimes", tags: ["spiders"], specificity: 0.3 },
    { strength: 0.7, tier: "medium" }
  );
  const specific = memory.remember(
    { source: "t", content: "hourglass-marked spiders are dangerous black widows", tags: ["spiders"], specificity: 0.9 },
    { strength: 0.7, tier: "medium" }
  );
  assert.equal(generic.fidelity, "normal");
  assert.equal(specific.fidelity, "specific");
  const hits = memory.retrieve("are spiders dangerous");
  const specificRank = hits.findIndex((h) => h.item.id === specific.id);
  const genericRank = hits.findIndex((h) => h.item.id === generic.id);
  assert.ok(specificRank !== -1 && genericRank !== -1);
  assert.ok(specificRank < genericRank, "specific-fidelity item ranks above the generic one");
});

test("corrections persist and restore through the file-backed store", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mem-correct-"));
  const memory = new FileBackedMemorySystem({ dir });
  const stale = memory.remember({ source: "t", content: "API key rotation is quarterly", tags: ["ops"] });
  const { item } = memory.correct({ id: stale.id, content: "API key rotation is MONTHLY as of June" });

  const reloaded = new FileBackedMemorySystem({ dir });
  const restoredCorrection = reloaded.items.get(item.id);
  assert.ok(restoredCorrection);
  assert.equal(restoredCorrection.locked, true);
  const restoredStale = reloaded.items.get(stale.id);
  assert.equal(restoredStale.metadata.supersededBy, item.id, "supersede mutation survives restart");
  const hits = reloaded.retrieve("API key rotation");
  assert.equal(hits[0].item.id, item.id);
  assert.ok(!hits.some((h) => h.item.id === stale.id));

  fs.rmSync(dir, { recursive: true });
});

test("correct_memory tool wires through with scope + recall exposes confidence fields", async () => {
  const memory = new MemorySystem();
  const runtime = { memory };
  const tools = new ToolRegistry();
  registerCoreTools(tools, runtime);

  memory.remember({ source: "t", content: "Standup is at 9am", tags: ["standup"] });
  const { ok, result } = await tools.invoke("correct_memory", { correction: "Standup moved to 9:30am", query: "standup time" }, { agentId: "main", sessionId: "s1" });
  assert.ok(ok);
  assert.equal(result.supersededCount, 1);

  const recall = await tools.invoke("recall", { query: "standup time" }, { agentId: "main" });
  assert.ok(recall.ok);
  const top = recall.result.items[0];
  assert.equal(top.id, result.id);
  assert.equal(top.locked, true);
  assert.equal(typeof top.strength, "number");
  assert.ok(["specific", "normal", "compressed"].includes(top.fidelity));
});
