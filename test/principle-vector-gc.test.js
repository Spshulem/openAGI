// G10 remediation: principle vectors must be garbage-collected when their
// backing memory item is superseded (correct()) or cap-evicted
// (enforceLimits), reconciled at boot when orphaned, and filtered out of the
// C2 intuition channel when missing, superseded, or quarantined.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HashBagEmbedder,
  MemorySystem,
  VectorStore,
  createDefaultRuntime,
  createDurableRuntime
} from "../src/index.js";
import { AgentHost, filterPrincipleHits } from "../src/agent-host.js";

function tmpVectorStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-pvgc-"));
  return new VectorStore({ embedder: new HashBagEmbedder(), dir });
}

test("correct() deletes the superseded item's principle vector", async () => {
  const memory = new MemorySystem();
  const vectors = tmpVectorStore();
  memory.bindVectorStore(vectors);

  const principle = memory.remember(
    { content: "Standup meetings are at 9am Mondays.", tags: ["principle", "standup"], kind: "principle" },
    { tier: "long" }
  );
  await vectors.upsert("principle", principle.id, principle.content, { confidence: "high" });
  assert.equal(vectors.list("principle").length, 1);

  const { superseded } = memory.correct({ id: principle.id, content: "Standup meetings moved to 9:30am Mondays." });

  assert.equal(superseded[0].id, principle.id);
  assert.equal(vectors.list("principle").length, 0, "superseding a principle removes its vector");
});

test("cap eviction deletes the evicted item's principle vector", async () => {
  const memory = new MemorySystem({ limits: { short: 100, medium: 100, long: 1 } });
  const vectors = tmpVectorStore();
  memory.bindVectorStore(vectors);

  const weak = memory.remember(
    { content: "Old principle: check the calendar before booking anything.", kind: "principle" },
    { tier: "long", strength: 0.1 }
  );
  await vectors.upsert("principle", weak.id, weak.content);
  assert.equal(vectors.list("principle").length, 1);

  // Long-tier cap is 1: this stronger item evicts the weak principle.
  memory.remember({ content: "Newer long-term note that wins the cap." }, { tier: "long", strength: 0.9 });

  assert.equal(memory.items.has(weak.id), false, "weaker item was evicted");
  assert.equal(vectors.list("principle").length, 0, "evicted item's vector removed");
});

test("reconcilePrincipleVectors removes orphaned and superseded vectors, keeps live ones", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-pvgc-rec-"));
  const runtime = createDefaultRuntime({
    agentHost: false,
    embedderOptions: { forceHash: true },
    vectorStoreOptions: { dir }
  });

  const live = runtime.memory.remember({ content: "Live principle about calendar hygiene.", kind: "principle" }, { tier: "long" });
  await runtime.vectorStore.upsert("principle", live.id, live.content);
  await runtime.vectorStore.upsert("principle", "mem_long_wiped_1", "Orphan principle whose memory item is gone.");
  const stale = runtime.memory.remember({ content: "Stale principle later corrected.", kind: "principle" }, { tier: "long" });
  await runtime.vectorStore.upsert("principle", stale.id, stale.content);
  // Simulate a supersede that happened before the GC wiring existed.
  stale.metadata = { ...stale.metadata, supersededBy: "mem_medium_fake_1" };

  const result = runtime.reconcilePrincipleVectors();

  assert.equal(result.checked, 3);
  assert.equal(result.removed, 2);
  assert.deepEqual(runtime.vectorStore.list("principle").map((e) => e.id), [live.id]);
});

test("createDurableRuntime reconciles orphaned principle vectors at boot", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-pvgc-boot-"));
  const seed = new VectorStore({ embedder: new HashBagEmbedder(), dir: path.join(dataDir, "vectors") });
  await seed.upsert("principle", "mem_long_wiped_2", "Orphan vector from a wiped memory state.");

  const runtime = createDurableRuntime({
    dataDir,
    agentHost: false,
    autoConnectMcp: false,
    embedderOptions: { forceHash: true }
  });

  assert.equal(runtime.vectorStore.list("principle").length, 0, "boot reconcile removed the orphan");
});

test("filterPrincipleHits drops missing, superseded, and quarantined hits; top-N cut applies after filtering", async () => {
  const memory = new MemorySystem();
  const vectors = tmpVectorStore();
  const addPrinciple = async (content, metadata = {}) => {
    const item = memory.remember({ content, kind: "principle", metadata }, { tier: "long" });
    await vectors.upsert("principle", item.id, content);
    return item;
  };

  const liveA = await addPrinciple("Standup meeting principle A: schedule prep before standup meetings.");
  const liveB = await addPrinciple("Standup meeting principle B: schedule notes after standup meetings.");
  const liveC = await addPrinciple("Standup meeting principle C: schedule follow-ups from standup meetings.");
  const expired = await addPrinciple("Standup meeting principle D: schedule demos in standup meetings.", {
    quarantineUntil: new Date(Date.now() - 86400 * 1000).toISOString()
  });
  const superseded = await addPrinciple("Standup meeting principle E: superseded standup meetings advice.");
  superseded.metadata = { ...superseded.metadata, supersededBy: "mem_medium_fake_2" };
  const quarantined = await addPrinciple("Standup meeting principle F: quarantined standup meetings hunch.", {
    quarantineUntil: new Date(Date.now() + 86400 * 1000).toISOString()
  });
  await vectors.upsert("principle", "mem_long_missing_9", "Standup meeting principle G: orphaned standup meetings vector.");

  const hits = await vectors.search("principle", "schedule standup meetings", { limit: 20, minScore: 0 });
  assert.equal(hits.length, 7);

  const eligible = filterPrincipleHits(hits, memory, { limit: 10 });
  const ids = eligible.map((h) => h.id);
  assert.equal(eligible.length, 4, "only live + expired-quarantine principles remain");
  assert.deepEqual(ids.slice().sort(), [liveA.id, liveB.id, liveC.id, expired.id].sort());
  assert.ok(!ids.includes(superseded.id));
  assert.ok(!ids.includes(quarantined.id));
  assert.ok(!ids.includes("mem_long_missing_9"));

  const capped = filterPrincipleHits(hits, memory, { limit: 3 });
  assert.equal(capped.length, 3, "top-3 cut applies AFTER filtering");
});

test("handleMessage injects live principles but never quarantined ones", async () => {
  const memory = new MemorySystem();
  const vectors = tmpVectorStore();
  memory.bindVectorStore(vectors);

  const live = memory.remember(
    { content: "Standup meetings run at 9am; block prep time before standup meetings.", kind: "principle" },
    { tier: "long" }
  );
  await vectors.upsert("principle", live.id, live.content);
  const quarantined = memory.remember(
    {
      content: "Quarantined hunch: cancel standup meetings on Fridays.",
      kind: "principle",
      metadata: { quarantineUntil: new Date(Date.now() + 86400 * 1000).toISOString() }
    },
    { tier: "long" }
  );
  await vectors.upsert("principle", quarantined.id, quarantined.content);

  const captured = {};
  const runtime = {
    memory,
    vectorStore: vectors,
    outcomes: null,
    processSignal: () => ({
      id: "out_1",
      scrutiny: { action: "act", score: 0.7, reasons: ["stub"], dimensions: { novelty: 0.4, risk: 0.3, repetition: 0.3 } },
      customContext: [],
      propagation: { created: false }
    })
  };
  const host = new AgentHost({
    runtime,
    modelProvider: {
      isConfigured: () => true,
      model: "stub",
      generate: async (args) => {
        captured.instructions = args.instructions;
        // D2 moved per-turn state (intuitions included) out of the static
        // system prompt into the turn-context block.
        captured.turnContext = args.turnContext;
        return { text: "ok", provider: "stub", model: "stub", id: "r1", toolCalls: [] };
      }
    }
  });

  await host.handleMessage({ text: "when do standup meetings run?", channel: "local", from: "u" });

  assert.match(captured.turnContext, /block prep time before standup meetings/, "live principle injected as intuition");
  assert.doesNotMatch(captured.turnContext, /Quarantined hunch/, "quarantined principle NOT injected");
  assert.doesNotMatch(captured.instructions, /block prep time/, "static instructions stay principle-free (byte-stable for the prompt cache)");
  assert.equal(live.metadata.recallCount, 1, "placing a principle in turn context records a recall");
  assert.deepEqual(live.metadata.recallSources, { "principle-context": 1 });
  assert.equal(quarantined.metadata.recallCount, undefined, "filtered principles are never credited as recalled");
});
