import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableRuntime, DeterministicModelProvider } from "../src/index.js";

function runtimeWithLegacyWork() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-backfill-"));
  const runtime = createDurableRuntime({ dataDir, modelProvider: new DeterministicModelProvider(), autoConnectMcp: false });
  const dir = runtime.proactiveObserver.suggestDir;
  for (const [id, status] of [["prop_a", "accepted"], ["prop_b", "rejected"], ["prop_c", "auto-dismissed"], ["prop_d", "pending"]]) {
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, status, category: "task", title: id, proposedAt: "2026-07-01T10:00:00.000Z" }));
  }
  // Drafts resolved before grading existed: status set without the resolve hook.
  for (const [body, status] of [["first body", "approved"], ["second body", "discarded"]]) {
    const d = runtime.drafts.add({ title: "t", body, kind: "email" });
    d.status = status;
  }
  runtime.drafts.snapshot();
  return runtime;
}

test("default jobs: daily sweep on, backfill off", () => {
  const runtime = runtimeWithLegacyWork();
  const jobs = Object.fromEntries(runtime.cron.listJobs().map((j) => [j.id, j]));
  assert.equal(jobs["grounded-sweep"].enabled, true);
  assert.equal(jobs["grounded-sweep"].dailyAt, "04:45");
  assert.equal(jobs["grounded-backfill"].enabled, false);
});

test("backfill is a dry run by default, grades on apply, and skips what is already graded", async () => {
  const runtime = runtimeWithLegacyWork();
  const dry = await runtime.runJobTask({ id: "grounded-backfill", task: "grounded-backfill", input: {} });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.suggestions.byFate, { accepted: 1, rejected: 1, "silence-undelivered": 1 });
  assert.deepEqual(dry.drafts.byFate, { approved: 1, discarded: 1 });
  assert.equal(runtime.outcomes.groundedStats().graded, 0);

  const applied = await runtime.runJobTask({ id: "grounded-backfill", task: "grounded-backfill", input: { apply: true } });
  assert.equal(applied.dryRun, false);
  const stats = runtime.outcomes.groundedStats({ windowDays: 3650 });
  assert.equal(stats.total, 5);
  assert.equal(stats.graded, 4);       // silence-undelivered has no score
  assert.equal(stats.ungraded, 1);

  const again = await runtime.runJobTask({ id: "grounded-backfill", task: "grounded-backfill", input: { apply: true } });
  assert.equal(again.skipped, 5);
  assert.deepEqual(again.suggestions.byFate, {});
});

test("the sweep job runs", async () => {
  const runtime = runtimeWithLegacyWork();
  const result = await runtime.runJobTask({ id: "grounded-sweep", task: "grounded-sweep", input: {} });
  assert.equal(typeof result.grounded, "number");
});
