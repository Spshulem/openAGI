import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { suggestionAdmissionStatus, withSuggestionAdmission } from "../src/suggestion-admission.js";
import { ProactiveObserver } from "../src/proactive-observer.js";
import { DraftStore } from "../src/draft-store.js";

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-admission-"));
  fs.mkdirSync(path.join(dir, "proactive", "suggestions"), { recursive: true });
  fs.mkdirSync(path.join(dir, "skills-suggested"), { recursive: true });
  return dir;
}

test("suggestion admission pauses at a bounded pending count without changing existing rows", async () => {
  const dir = tempDir();
  for (let i = 0; i < 3; i += 1) {
    fs.writeFileSync(path.join(dir, "proactive", "suggestions", `prop_${i}.json`), JSON.stringify({ id: `prop_${i}`, status: "pending" }));
  }
  const status = suggestionAdmissionStatus({ dataDir: dir, limit: 3 });
  assert.deepEqual(status, { allowed: false, pending: 3, limit: 3 });

  let observationReads = 0;
  const observer = new ProactiveObserver({
    dataDir: dir,
    maxPendingSuggestions: 3,
    runtime: { observations: { async getRecentContext() { observationReads += 1; return {}; } } }
  });
  const result = await observer.observe({ force: true });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /review limit/);
  assert.equal(observationReads, 0, "backpressure happens before observation or model work");
  assert.equal(fs.readdirSync(path.join(dir, "proactive", "suggestions")).length, 3);
  fs.rmSync(dir, { recursive: true });
});

test("persistence-boundary admission prevents concurrent producers from overshooting", async () => {
  const dir = tempDir();
  const suggestionDir = path.join(dir, "proactive", "suggestions");
  const earlyChecks = [
    suggestionAdmissionStatus({ dataDir: dir, limit: 1 }),
    suggestionAdmissionStatus({ dataDir: dir, limit: 1 })
  ];
  assert.equal(earlyChecks.every((entry) => entry.allowed), true,
    "both async producers can legitimately pass the pre-model check");

  const persist = (id) => withSuggestionAdmission({
    dataDir: dir,
    limit: 1,
    write: () => fs.writeFileSync(
      path.join(suggestionDir, `${id}.json`),
      JSON.stringify({ id, status: "pending" })
    )
  });
  const first = persist("one");
  const second = persist("two");
  assert.equal(first.written, true);
  assert.equal(second.written, false);
  assert.equal(fs.readdirSync(suggestionDir).filter((name) => name.endsWith(".json")).length, 1);
  fs.rmSync(dir, { recursive: true });
});

test("exact same-task drafts coalesce but edited and free-standing drafts stay distinct", () => {
  const dir = tempDir();
  const drafts = new DraftStore({ dir: path.join(dir, "drafts") });
  const first = drafts.add({ taskId: "task_1", kind: "doc", title: "Plan", body: "Exact body" });
  const duplicate = drafts.add({ taskId: "task_1", kind: "doc", title: "Plan", body: "Exact body" });
  assert.equal(duplicate.id, first.id);
  assert.equal(drafts.list().length, 1);
  assert.equal(first.sourceMeta.duplicateCount, 2);

  drafts.edit(first.id, { body: "User-edited body" });
  drafts.add({ taskId: "task_1", kind: "doc", title: "Plan", body: "User-edited body" });
  drafts.add({ kind: "doc", title: "Plan", body: "Same free-standing body" });
  drafts.add({ kind: "doc", title: "Plan", body: "Same free-standing body" });
  assert.equal(drafts.list().length, 4);
  fs.rmSync(dir, { recursive: true });
});
