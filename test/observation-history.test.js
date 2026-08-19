import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ObservationStore } from "../src/observation-store.js";

test("unfiltered Computer History merges focus activity with OCR-backed frames", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-observation-history-"));
  const store = new ObservationStore({ dir });
  await store.ready;
  t.after(() => {
    store.db?.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await store.record([
    {
      kind: "activity",
      at: "2026-08-19T20:00:00.000Z",
      app: "com.openai.codex",
      window: "Review the timeline",
      event: "focus",
      sourceMachineId: "node-a"
    },
    {
      kind: "frame-summary",
      frameId: "frame-safe-example",
      at: "2026-08-19T20:01:00.000Z",
      app: "com.openai.codex",
      window: "Review the timeline",
      ocrText: "screen text available to history",
      sourceMachineId: "node-a"
    },
    {
      kind: "frame-summary",
      frameId: "frame-other-node",
      at: "2026-08-19T20:02:00.000Z",
      app: "com.apple.finder",
      window: "Files",
      ocrText: "other machine",
      sourceMachineId: "node-b"
    }
  ]);

  const merged = await store.search({
    kinds: ["activity", "frame"],
    machine: "node-a",
    limit: 10
  });
  assert.deepEqual(merged.map((row) => row.kind), ["frame", "activity"]);
  assert.equal(merged[0].ref, "frame-safe-example");
  assert.equal(merged[0].text, "screen text available to history");
  assert.ok(merged.every((row) => row.sourceMachineId === "node-a"));

  const framesOnly = await store.search({ kinds: ["frame"], app: "com.apple.finder", limit: 10 });
  assert.equal(framesOnly.length, 1);
  assert.equal(framesOnly[0].ref, "frame-other-node");

  const legacyDefault = await store.search({ limit: 10 });
  assert.deepEqual(legacyDefault.map((row) => row.kind), ["activity"],
    "callers that omit kinds keep the existing activity-only contract");
});
