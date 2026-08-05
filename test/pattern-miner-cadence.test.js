import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDefaultRuntime, CronScheduler } from "../src/index.js";

function makeRuntime(dataDir, options = {}) {
  return createDefaultRuntime({
    dataDir,
    agentHost: false,
    cron: new CronScheduler(),
    observationOptions: { dir: path.join(dataDir, "observations") },
    outcomeOptions: { dir: path.join(dataDir, "outcomes") },
    vectorStoreOptions: { dir: path.join(dataDir, "vectors") },
    budgetOptions: { storePath: path.join(dataDir, "budget", "usage.json") },
    ...options
  });
}

async function settleRuntime(runtime) {
  await Promise.all([runtime.sessionIndex?.ready, runtime.observations?.ready].filter(Boolean));
}

function closeRuntime(runtime) {
  try { runtime.sessionIndex?.db?.close?.(); } catch { /* already closed */ }
  try { runtime.observations?.db?.close?.(); } catch { /* already closed */ }
}

test("default runtime keeps nightly validation and adds an hourly workflow-learning pass", async (t) => {
  const previous = process.env.OPENAGI_PATTERN_MINE_INTERVAL_MIN;
  delete process.env.OPENAGI_PATTERN_MINE_INTERVAL_MIN;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAGI_PATTERN_MINE_INTERVAL_MIN;
    else process.env.OPENAGI_PATTERN_MINE_INTERVAL_MIN = previous;
  });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-pattern-cadence-"));
  const runtime = makeRuntime(dataDir);
  await settleRuntime(runtime);
  t.after(() => {
    closeRuntime(runtime);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const jobs = runtime.cron.listJobs();
  const fast = jobs.find((job) => job.id === "hourly-pattern-mine");
  const deep = jobs.find((job) => job.id === "nightly-pattern-mine");

  assert.ok(fast, "fast workflow miner should be registered");
  assert.equal(fast.intervalMs, 60 * 60 * 1000);
  assert.deepEqual(fast.input, { maxCandidates: 2, mode: "continuous" });
  assert.ok(deep, "nightly deep pass should remain registered");
  assert.equal(deep.dailyAt, "02:30");
  assert.deepEqual(deep.input, { maxCandidates: 5, mode: "deep" });
});

test("pattern-mine cron dispatch passes cadence mode and proposal budget to the miner", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-pattern-dispatch-"));
  const calls = [];
  const patternMiner = {
    mine: async (options) => {
      calls.push(options);
      return { candidates: 0 };
    }
  };
  const runtime = makeRuntime(dataDir, { patternMiner });
  await settleRuntime(runtime);
  t.after(() => {
    closeRuntime(runtime);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const now = new Date("2026-07-11T17:00:00.000Z");
  for (const job of runtime.cron.listJobs()) {
    runtime.cron.updateJob(job.id, {
      nextRunAt: job.id === "hourly-pattern-mine"
        ? now.toISOString()
        : new Date(now.getTime() + 86_400_000).toISOString()
    });
  }

  const result = await runtime.tick(now);
  assert.equal(result.length, 1);
  assert.equal(result[0].job.id, "hourly-pattern-mine");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, "continuous");
  assert.equal(calls[0].maxCandidates, 2);
  assert.equal(calls[0].now, now);
});

test("a persisted disabled nightly miner keeps the new hourly miner disabled", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-pattern-disabled-"));
  const cron = new CronScheduler();
  cron.addJob({
    id: "nightly-pattern-mine",
    name: "Nightly activity pattern miner",
    enabled: false,
    task: "pattern-mine",
    dailyAt: "02:30"
  });
  const runtime = makeRuntime(dataDir, { cron });
  await settleRuntime(runtime);
  t.after(() => {
    closeRuntime(runtime);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  assert.equal(runtime.cron.listJobs().find((job) => job.id === "nightly-pattern-mine").enabled, false);
  assert.equal(runtime.cron.listJobs().find((job) => job.id === "hourly-pattern-mine").enabled, false);
});
