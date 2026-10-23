import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileBackedMemorySystem } from "../src/file-backed-memory-system.js";
import { VectorStore } from "../src/vector-store.js";
import { HashBagEmbedder } from "../src/embeddings.js";
import { filterPrincipleHits } from "../src/agent-host.js";
import { MemorySystem } from "../src/memory-system.js";
import { MemoryCondenser } from "../src/memory-condenser.js";

function fixture(tier = "medium") {
  const memory = new MemorySystem();
  const rows = ["Obsolete schedule: review at nine, with the old detailed instructions.", "Review checklist includes a summary.", "Review checklist includes a decision."].map(content =>
    memory.remember({ content, source: "local", tags: ["review", "schedule"] }, { tier, strength: 0.8 }));
  return { memory, rows };
}

for (const tier of ["short", "medium"]) {
  test(`condensation excludes corrected ${tier} evidence from prompt and lineage`, async () => {
    const { memory, rows } = fixture(tier);
    const { item: correction } = memory.correct({ id: rows[0].id, content: "Review starts at ten." });
    let prompt;
    const provider = { isConfigured: () => true, async generate({ input }) {
      prompt = input;
      return { text: "Review starts at ten. (confidence: high)" };
    } };
    const result = await new MemoryCondenser({ runtime: { memory, agentHost: { modelProvider: provider } } }).condense();
    assert.equal(result.principles, 1);
    assert.ok(!prompt.includes(rows[0].content), "superseded fact never reaches the model");
    assert.ok(prompt.includes(correction.content));
    const principle = memory.items.get(result.items[0].id);
    assert.deepEqual(new Set(principle.metadata.sources), new Set([rows[1].id, rows[2].id, correction.id]));
    assert.equal(rows[0].metadata.condensedInto, undefined);
    assert.equal(memory.items.get(rows[0].id), rows[0], "historical source is retained");
  });
}

test("superseded sources do not satisfy the minimum evidence threshold", async () => {
  const { memory, rows } = fixture();
  memory.correct({ id: rows[0].id, content: "Review starts at ten." });
  memory.correct({ id: rows[1].id, content: "Review starts at ten." });
  // Keep the current corrections outside the input tiers, as happens after promotion.
  for (const row of memory.items.values()) if (row.kind === "correction") row.tier = "long";
  const result = await new MemoryCondenser({ runtime: { memory } }).condense();
  assert.equal(result.principles, 0);
  assert.equal(memory.byTier("long").filter(row => row.kind === "principle").length, 0);
});

test("a correction during model generation discards stale output and allows a fresh run", async () => {
  const { memory, rows } = fixture();
  let corrected = false;
  const indexed = [];
  const provider = { isConfigured: () => true, async generate() {
    if (!corrected) {
      memory.correct({ id: rows[0].id, content: "Review starts at ten." });
      corrected = true;
      return { text: "Review starts at nine. (confidence: high)" };
    }
    return { text: "Review starts at ten. (confidence: high)" };
  } };
  const condenser = new MemoryCondenser({ runtime: { memory, agentHost: { modelProvider: provider },
    vectorStore: { async upsert(...args) { indexed.push(args); } } } });
  const first = await condenser.condense();
  assert.equal(first.principles, 0);
  assert.equal(indexed.length, 0);
  assert.ok(rows.every(row => !row.metadata.condensedInto));
  const second = await condenser.condense();
  assert.equal(second.principles, 1);
  assert.equal(indexed.length, 1);
  assert.equal(second.items[0].text, "Review starts at ten.");
});


for (const mode of ["id", "query"]) {
  test(`a later ${mode} correction retires derived recall and vectors durably`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-condense-correction-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const memory = new FileBackedMemorySystem({ dir: path.join(dir, "memory") });
    const vectors = new VectorStore({ dir: path.join(dir, "vectors"), embedder: new HashBagEmbedder() });
    memory.bindVectorStore(vectors);
    const rows = ["Review starts at nine under the obsolete detailed schedule.",
      "Review preparation includes a summary.", "Review preparation includes a decision."].map(content =>
      memory.remember({ source: "local", content, tags: ["review", "schedule"] }, { tier: "medium" }));
    const condenser = new MemoryCondenser({ runtime: { memory } });
    // A distilled conclusion need not share the source's query keywords.
    condenser.distill = async () => ({ text: "Prepare meeting notes early.", confidence: "high" });
    const first = await condenser.condense();
    const principle = memory.items.get(first.items[0].id);
    await vectors.upsert("principle", principle.id, principle.content);
    const oldHits = await vectors.search("principle", "review schedule", { minScore: 0 });
    assert.equal(oldHits.length, 1);
    const { item: correction, superseded } = memory.correct({
      ...(mode === "id" ? { id: rows[0].id } : { query: "nine obsolete detailed schedule" }),
      content: "Review starts at ten."
    });
    assert.ok(superseded.some(row => row.id === rows[0].id));
    assert.ok(superseded.some(row => row.id === principle.id));
    assert.equal(principle.metadata.supersededBy, correction.id);
    assert.equal(vectors.list("principle").length, 0);
    assert.equal(filterPrincipleHits(oldHits, memory, { now: Date.now() + 8 * 86400000 }).length, 0,
      "a cached vector hit is also excluded after quarantine");
    assert.ok(!memory.retrieve("review schedule", { limit: 20 }).some(hit => hit.item.id === principle.id));
    assert.ok(rows.slice(1).every(row => !row.metadata.condensedInto), "current notes can be regrouped");
    const restored = new FileBackedMemorySystem({ dir: path.join(dir, "memory") });
    assert.equal(restored.items.get(principle.id).metadata.supersededBy, correction.id);
    assert.ok(restored.items.has(rows[0].id), "audit history is retained");
    const rebuilt = await new MemoryCondenser({ runtime: { memory: restored } }).condense();
    assert.equal(rebuilt.principles, 1);
    assert.ok(!restored.items.get(rebuilt.items[0].id).metadata.sources.includes(rows[0].id));
    assert.ok(restored.items.get(rebuilt.items[0].id).metadata.sources.includes(correction.id));
  });
}

test("derived invalidation follows same-scope lineage without mutating peer memory", () => {
  const memory = new MemorySystem();
  const source = memory.remember({ scope: "specialist:planner", content: "Review at nine" });
  const derived = (scope, sources) => memory.remember({ source: "local", scope, kind: "principle", content: `Review schedule derived from ${sources.join(", ")}`, metadata: { sources } }, { tier: "long" });
  const first = derived("specialist:planner", [source.id]);
  const second = derived("specialist:planner", [first.id]);
  const peer = derived("specialist:peer", [source.id]);
  const unrelated = derived("specialist:planner", ["unrelated-source"]);
  const result = memory.correct({ id: source.id, scope: "specialist:planner", content: "Review at ten" });
  assert.deepEqual(new Set(result.superseded.map(row => row.id)), new Set([source.id, first.id, second.id]));
  assert.equal(peer.metadata.supersededBy, undefined);
  assert.equal(unrelated.metadata.supersededBy, undefined);
});

test("queued groups invalidated by an earlier model call never reach the model", async () => {
  const { memory } = fixture();
  const queued = ["Obsolete deployment window", "Deployment checklist", "Deployment owner"].map(content =>
    memory.remember({ content, source: "local", tags: ["deploy", "window"] }, { tier: "medium" }));
  const prompts = [];
  const provider = { isConfigured: () => true, async generate({ input }) {
    prompts.push(input);
    if (prompts.length === 1) memory.correct({ id: queued[0].id, content: "Deployment window updated" });
    return { text: "Current review principle. (confidence: high)" };
  } };
  const result = await new MemoryCondenser({ runtime: { memory, agentHost: { modelProvider: provider } } }).condense();
  assert.equal(prompts.length, 1, "invalid queued evidence incurs no model request");
  assert.equal(result.principles, 1);
  assert.ok(queued.every(row => !row.metadata.condensedInto));
});

for (const mode of ["id", "query"]) {
  test(`direct ${mode} principle correction cannot resurrect its obsolete sources after restart`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-direct-correction-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const memory = new FileBackedMemorySystem({ dir });
    const rows = ["Review at nine under the old schedule.", "Prepare review at nine.", "Confirm review at nine."].map(content =>
      memory.remember({ source: "local", content, tags: ["review", "schedule"] }, { tier: "medium" }));
    const first = await new MemoryCondenser({ runtime: { memory } }).condense();
    const principle = memory.items.get(first.items[0].id);
    const { item: correction } = memory.correct({
      ...(mode === "id" ? { id: principle.id } : { query: principle.content }),
      content: "Review starts at ten."
    });
    assert.equal(correction.tier, "long");
    assert.equal(principle.metadata.supersededBy, correction.id);
    const restored = new FileBackedMemorySystem({ dir });
    const result = await new MemoryCondenser({ runtime: { memory: restored } }).condense();
    assert.equal(result.principles, 0, "unchanged notes cannot re-create the corrected conclusion");
    assert.ok(rows.every(row => restored.items.get(row.id).metadata.condensedInto === principle.id));
    assert.ok(restored.retrieve("review", { limit: 20 }).some(hit => hit.item.id === correction.id));
  });
}

test("correcting a source cancels its principle's in-flight embedding durably", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-pending-vector-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const embedder = new HashBagEmbedder();
  const vectors = new VectorStore({ dir, embedder: { embed: async text => {
    await pending;
    return embedder.embed(text);
  } } });
  const { memory, rows } = fixture();
  memory.bindVectorStore(vectors);
  let write;
  const result = await new MemoryCondenser({ runtime: { memory, vectorStore: {
    upsert(...args) { write = vectors.upsert(...args); return write; }
  } } }).condense();
  const principle = memory.items.get(result.items[0].id);
  assert.equal(vectors.list("principle").length, 0, "embedding is still pending");
  memory.correct({ id: rows[0].id, content: "Review starts at ten." });
  assert.ok(principle.metadata.supersededBy);
  release();
  await write;
  assert.equal(vectors.list("principle").length, 0, "retired principle must not be re-indexed");
  assert.equal(new VectorStore({ dir, embedder }).list("principle").length, 0);
});
