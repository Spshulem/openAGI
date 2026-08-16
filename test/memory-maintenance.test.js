import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemorySystem } from "../src/memory-system.js";
import { FileBackedMemorySystem } from "../src/file-backed-memory-system.js";
import { MemoryCondenser } from "../src/memory-condenser.js";

const DAY_MS = 24 * 60 * 60 * 1000;

test("decay is elapsed-time based instead of charging every runtime tick", () => {
  const memory = new MemorySystem();
  const at = "2026-08-01T00:00:00.000Z";
  const item = memory.remember({ content: "automated runtime note" }, { tier: "medium", strength: 0.8, now: at });

  for (let seconds = 10; seconds <= 3600; seconds += 10) {
    memory.decay(new Date(Date.parse(at) + seconds * 1000));
  }
  assert.equal(item.strength, 0.8, "ten-second ticks do not drain strength");

  const afterOneDay = memory.decay(new Date(Date.parse(at) + DAY_MS + 1000));
  assert.equal(afterOneDay.decayed.length, 1);
  assert.equal(item.strength, 0.79, "one elapsed day applies one medium-tier decay period");

  memory.decay(new Date(Date.parse(at) + DAY_MS + 10_000));
  assert.equal(item.strength, 0.79, "another tick in the same day is idempotent");
});

test("legacy snapshots establish a decay baseline without a destructive catch-up", () => {
  const memory = new MemorySystem();
  const item = memory.remember(
    { content: "legacy automated note" },
    { tier: "medium", strength: 0.01, now: "2026-01-01T00:00:00.000Z" }
  );
  delete item.lastDecayedAt;

  const result = memory.decay(new Date("2026-01-20T00:00:00.000Z"));
  assert.equal(item.strength, 0.25, "over-decayed legacy row receives one conservative tier floor");
  assert.deepEqual(result.initialized.map((entry) => entry.id), [item.id]);
  assert.deepEqual(result.repaired.map((entry) => entry.id), [item.id]);
  assert.equal(item.metadata.decayRepair.version, 1);
  assert.equal(item.metadata.decayRepair.previousStrength, 0.01);

  memory.decay(new Date("2026-01-20T00:00:10.000Z"));
  assert.equal(item.strength, 0.25, "repair is not applied again on later ticks");
});

test("exact automated repeats reinforce one row while explicit memories remain one-for-one", () => {
  const memory = new MemorySystem();
  const first = memory.remember({ source: "agent-host", content: "same automatic turn", tags: ["agent-turn"] }, { tier: "medium", strength: 0.4 });
  const second = memory.remember({ source: "agent-host", content: "same automatic turn", tags: ["agent-turn"] }, { tier: "medium", strength: 0.5 });

  assert.equal(second.id, first.id);
  assert.equal(memory.byTier("medium").length, 1);
  assert.equal(first.metadata.duplicateCount, 2);
  assert.ok(first.strength > 0.5);

  memory.remember({ source: "local", content: "remember my preference", tags: ["tool:remember"] }, { tier: "medium" });
  memory.remember({ source: "local", content: "remember my preference", tags: ["tool:remember"] }, { tier: "medium" });
  assert.equal(memory.byTier("medium").filter((item) => item.content === "remember my preference").length, 2);
});

test("a fresh exact repeat extends retention and consolidation keeps the newest observation", () => {
  const memory = new MemorySystem({ ttlMs: { medium: 2 * DAY_MS } });
  const start = "2026-08-01T00:00:00.000Z";
  const repeatedAt = "2026-08-02T23:59:00.000Z";
  const first = memory.remember(
    { source: "agent-host", content: "still-current automated fact", tags: ["runtime"] },
    { id: "older", tier: "medium", strength: 0.4, now: start }
  );
  const repeated = memory.remember(
    { source: "agent-host", content: "still-current automated fact", tags: ["runtime"] },
    { tier: "medium", strength: 0.3, now: repeatedAt }
  );
  assert.equal(repeated.id, first.id);
  assert.equal(first.lastObservedAt, repeatedAt);

  memory.decay(new Date("2026-08-03T00:01:00.000Z"));
  assert.ok(memory.items.has(first.id), "a fact observed two minutes ago is not deleted on its original TTL");
  assert.ok(Math.abs(first.strength - 0.42) < 1e-9,
    "the repeat is reinforced after old elapsed decay and is not aged retroactively");

  const fresherDuplicate = { ...first, id: "fresh-copy", strength: 0.1, lastObservedAt: "2026-08-03T00:00:30.000Z", metadata: {} };
  memory.items.set(fresherDuplicate.id, fresherDuplicate);
  memory.consolidateAutomatedDuplicates({ maxRemovals: 10, now: new Date("2026-08-03T00:01:00.000Z") });
  assert.equal(first.lastObservedAt, fresherDuplicate.lastObservedAt,
    "retaining the strongest copy must still merge the freshest evidence");
  assert.equal(first.lastDecayedAt, fresherDuplicate.lastObservedAt,
    "consolidation advances the decay checkpoint through the freshest evidence");
});

test("a late exact repeat does not lose its new strength to the original row's age", () => {
  const memory = new MemorySystem({ ttlMs: { medium: 90 * DAY_MS } });
  const originalAt = "2026-06-01T00:00:00.000Z";
  const repeatedAt = "2026-07-15T00:00:00.000Z";
  const first = memory.remember(
    { source: "agent-host", content: "a fact observed again today", tags: ["runtime"] },
    { tier: "medium", strength: 0.4, now: originalAt }
  );

  memory.remember(
    { source: "agent-host", content: "a fact observed again today", tags: ["runtime"] },
    { tier: "medium", strength: 0.4, now: repeatedAt }
  );
  assert.ok(Math.abs(first.strength - 0.43) < 1e-9, "old evidence decays before the new observation reinforces it");
  assert.equal(first.lastDecayedAt, repeatedAt);

  memory.decay(new Date("2026-07-15T00:01:00.000Z"));
  assert.ok(Math.abs(first.strength - 0.43) < 1e-9, "the next runtime tick cannot retroactively age fresh evidence");
});

test("duplicate consolidation compares stale and fresh copies at one decay time", () => {
  const memory = new MemorySystem({ ttlMs: { medium: 90 * DAY_MS } });
  const staleAt = "2026-06-01T00:00:00.000Z";
  const freshAt = "2026-07-15T00:00:00.000Z";
  const stale = memory.remember(
    { source: "agent-host", content: "the same historical automated fact", tags: ["runtime"] },
    { id: "stale-strong", tier: "medium", strength: 0.8, now: staleAt }
  );
  // Seed a pre-admission-dedupe copy. Although its raw strength is lower, it is
  // the stronger evidence at the merge time after the stale copy pays 44 days
  // of elapsed medium-tier decay (0.8 - 0.44 = 0.36).
  const fresh = {
    ...stale,
    id: "fresh-weaker",
    strength: 0.4,
    createdAt: freshAt,
    lastAccessedAt: freshAt,
    lastObservedAt: freshAt,
    lastDecayedAt: freshAt,
    metadata: {}
  };
  memory.items.set(fresh.id, fresh);

  const result = memory.consolidateAutomatedDuplicates({ maxRemovals: 10, now: new Date(freshAt) });

  assert.deepEqual(result.removed.map((item) => item.id), [stale.id]);
  assert.equal(result.retained[0].id, fresh.id, "fresh evidence wins after both copies are compared at the merge time");
  assert.ok(Math.abs(result.retained[0].strength - 0.4) < 1e-9,
    "the retained row cannot inherit the stale copy's pre-decay strength");
  assert.equal(result.retained[0].lastDecayedAt, freshAt);
});

test("file-backed consolidation archives exact automated duplicates before removing them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-memory-maintenance-"));
  const memory = new FileBackedMemorySystem({ dir, autoLoad: false });
  // Seed pre-upgrade duplicates directly: current remember() prevents these.
  const one = MemorySystem.prototype.remember.call(memory, { source: "agent-host", content: "duplicate automated output" }, { id: "auto_1", tier: "medium", strength: 0.3 });
  const two = { ...one, id: "auto_2", strength: 0.2, metadata: {} };
  memory.items.set(two.id, two);
  memory.saveSnapshot();

  const result = memory.consolidateAutomatedDuplicates({ maxRemovals: 10, now: new Date("2026-08-14T00:00:00.000Z") });
  assert.equal(result.groups, 1);
  assert.deepEqual(result.removed.map((item) => item.id), ["auto_2"]);
  assert.equal(memory.items.size, 1);

  const archive = fs.readFileSync(memory.duplicateArchivePath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(archive.length, 1);
  assert.equal(archive[0].item.id, "auto_2");
  assert.equal(archive[0].canonicalId, "auto_1");

  const reloaded = new FileBackedMemorySystem({ dir });
  assert.equal(reloaded.items.size, 1, "consolidated active snapshot survives restart");
  fs.rmSync(dir, { recursive: true });
});

test("duplicate maintenance never consolidates explicit user memories or corrections", () => {
  const memory = new MemorySystem();
  const explicit = memory.remember({ source: "local", content: "Keep this exact preference", tags: ["tool:remember"] }, { id: "explicit_1", tier: "medium" });
  memory.items.set("explicit_2", { ...explicit, id: "explicit_2", metadata: {} });
  const correction = memory.correct({ content: "The corrected value is final" }).item;
  memory.items.set("correction_2", { ...correction, id: "correction_2", metadata: {} });

  const result = memory.consolidateAutomatedDuplicates({ maxRemovals: 10 });
  assert.equal(result.removed.length, 0);
  assert.ok(memory.items.has("explicit_1") && memory.items.has("explicit_2"));
  assert.ok(memory.items.has(correction.id) && memory.items.has("correction_2"));
});

test("daily condenser runs bounded duplicate maintenance before principle clustering", async () => {
  const memory = new MemorySystem();
  const one = memory.remember({ source: "agent-host", content: "same automatic output", tags: ["runtime"] }, { id: "one", tier: "medium" });
  memory.items.set("two", { ...one, id: "two", metadata: {} });
  const condenser = new MemoryCondenser({ runtime: { memory }, minGroupSize: 3 });

  const result = await condenser.condense({ now: new Date("2026-08-14T00:00:00.000Z") });
  assert.equal(result.duplicatesConsolidated, 1);
  assert.equal(memory.items.size, 1);
  assert.equal(result.principles, 0);
});
