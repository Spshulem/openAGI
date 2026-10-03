import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemorySystem } from "../src/memory-system.js";
import { FileBackedMemorySystem } from "../src/file-backed-memory-system.js";

function principle(memory, content = "Prefer concise release checklists", options = {}) {
  return memory.remember({ source: "test", kind: "principle", content, ...options }, { tier: "long", strength: 0.5 });
}

test("unrelated principles do not fill recall slots or gain strength and recall credit", () => {
  const memory = new MemorySystem();
  const item = principle(memory);
  const before = JSON.stringify(item);
  assert.deepEqual(memory.retrieve("astronomy telescope nebula"), []);
  assert.equal(JSON.stringify(item), before);
  assert.equal(memory.qualityStats().recalled, 0);
});

test("empty and punctuation-only queries do not reinforce unrelated principles", () => {
  const memory = new MemorySystem();
  const item = principle(memory);
  for (const query of ["", "   ", "?!"]) assert.deepEqual(memory.retrieve(query), []);
  assert.equal(item.metadata.recallCount, undefined);
});

test("relevant principles retain their tie-breaking boost", () => {
  const memory = new MemorySystem();
  const fact = memory.remember({ source: "test", content: "Release checklist" }, { tier: "long", strength: 0.5 });
  const item = principle(memory, "Release checklist");
  const hits = memory.retrieve("release checklist");
  assert.deepEqual(hits.map(x => x.item.id), [item.id, fact.id]);
  assert.ok(Math.abs(hits[0].score - hits[1].score - 0.1) < 1e-9);
  assert.equal(item.metadata.recallCount, 1);
});

test("risk-tag evidence still recalls a safety principle without lexical overlap", () => {
  const memory = new MemorySystem();
  const item = principle(memory, "Never combine incompatible chemicals", { tags: ["lab-safety"], risk: 1, specificity: 1 });
  assert.ok(item.dangerLevel > 0.65);
  const hits = memory.retrieve("", { tags: ["LAB-SAFETY"] });
  assert.equal(hits[0]?.item.id, item.id);
  assert.equal(item.metadata.recallCount, 1);
});

test("scope and superseded guards remain enforced for matching principles", () => {
  const memory = new MemorySystem();
  principle(memory, "Release checklist", { scope: "other-project" });
  principle(memory, "Release checklist", { metadata: { supersededBy: "fixture-correction" } });
  const relevant = principle(memory, "Release checklist", { scope: "main" });
  assert.deepEqual(memory.retrieve("release checklist", { scope: "current-project" }).map(x => x.item.id), [relevant.id]);
});

test("file-backed no-match retrieval leaves durable memory and recall journal untouched", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-principle-relevance-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const memory = new FileBackedMemorySystem({ dir });
  const item = principle(memory);
  const snapshot = fs.readFileSync(memory.snapshotPath, "utf8");
  const events = fs.readFileSync(memory.eventsPath, "utf8");
  assert.deepEqual(memory.retrieve("astronomy telescope nebula"), []);
  assert.equal(fs.readFileSync(memory.snapshotPath, "utf8"), snapshot);
  assert.equal(fs.readFileSync(memory.eventsPath, "utf8"), events);
  const restored = new FileBackedMemorySystem({ dir });
  assert.equal(restored.items.get(item.id).metadata.recallCount, undefined);
  assert.equal(restored.retrieve("release checklist")[0].item.id, item.id);
  assert.equal(new FileBackedMemorySystem({ dir }).items.get(item.id).metadata.recallCount, 1);
});
