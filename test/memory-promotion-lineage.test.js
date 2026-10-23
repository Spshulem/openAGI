import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemorySystem } from "../src/memory-system.js";
import { FileBackedMemorySystem } from "../src/file-backed-memory-system.js";
import { MemoryCondenser } from "../src/memory-condenser.js";

for (const mode of ["id", "query"]) {
  test(`correction by ${mode} invalidates a principle after its source promotes`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-promotion-lineage-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const memory = new FileBackedMemorySystem({ dir });
    const now = new Date("2026-01-01T00:00:00.000Z");
    const rows = ["Release review starts at nine.", "Release review requires a checklist.", "Release review requires a summary."].map(content =>
      memory.remember({ content, source: "local", tags: ["release", "review"], repetition: 0.8 },
        { tier: "medium", now: now.toISOString() }));
    const condenser = new MemoryCondenser({ runtime: { memory } });
    condenser.distill = async () => ({ text: "Prepare early for the old meeting time.", confidence: "high" });
    const result = await condenser.condense({ now });
    const principleId = result.items[0].id;
    memory.decay(new Date("2026-03-01T00:00:00.000Z"));
    const restored = new FileBackedMemorySystem({ dir });
    const promoted = restored.byTier("long").find(item => item.content === rows[0].content);
    assert.ok(promoted);
    const deletedVectors = [];
    restored.bindVectorStore({ delete(namespace, id) { deletedVectors.push([namespace, id]); } });
    const corrected = restored.correct({ ...(mode === "id" ? { id: rows[0].id } : { query: "nine" }), content: "Release review starts at ten." });
    assert.ok(corrected.superseded.some(item => item.id === promoted.id), "promoted source is corrected");
    assert.ok(corrected.superseded.some(item => item.id === principleId), "derived advice cannot survive source promotion and correction");
    assert.ok(deletedVectors.some(([namespace, id]) => namespace === "principle" && id === principleId));
    const final = new FileBackedMemorySystem({ dir });
    assert.equal(final.items.get(principleId).metadata.supersededBy, corrected.item.id);
    assert.ok(!final.retrieve("old meeting time").some(hit => hit.item.id === principleId));
  });
}

test("promotion retains IDs, correction links and scope through both tier transitions", () => {
  const memory = new MemorySystem();
  const source = memory.remember({ content: "Synthetic review at nine.", scope: "specialist", repetition: 0.8 },
    { tier: "short", now: "2026-01-01T00:00:00.000Z" });
  const correction = memory.correct({ id: source.id, scope: "specialist", content: "Synthetic review at ten." }).item;
  const promotedCorrection = memory.promote(correction, "long", "2026-03-01T00:00:00.000Z");
  assert.equal(promotedCorrection.id, correction.id);
  assert.equal(memory.items.get(source.id).metadata.supersededBy, promotedCorrection.id);
  const other = memory.remember({ content: "Synthetic checklist.", scope: "specialist", repetition: 0.8 }, { tier: "short" });
  const medium = memory.promote(other, "medium", "2026-03-01T00:00:00.000Z");
  const long = memory.promote(medium, "long", "2026-05-01T00:00:00.000Z");
  assert.equal(long.id, other.id);
  assert.equal(long.scope, "specialist");
  assert.equal(memory.items.size, 3);
});
