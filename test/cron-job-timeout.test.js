// test/cron-job-timeout.test.js
// D1 part 2: every cron job handler races a per-job timeout so one hung
// handler (stuck LLM call, wedged MCP server) cannot stall the schedule.
// On timeout the fire records as failed, nextRunAt advances normally, and
// the runtime bus emits "cron-job-timeout". NOTE: Promise.race abandons the
// hung promise — it is not cancelled. Acceptable v1: the schedule keeps
// moving, which is the property these tests pin.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CronScheduler, TIMEOUT_MS, resolveJobTimeoutMs } from "../src/cron-scheduler.js";
import { createDefaultRuntime } from "../src/index.js";

test("TIMEOUT_MS defaults to 10 minutes; env override validated finite>0", () => {
  assert.equal(TIMEOUT_MS, 10 * 60 * 1000);
  assert.equal(resolveJobTimeoutMs({}), TIMEOUT_MS);
  assert.equal(resolveJobTimeoutMs({ OPENAGI_CRON_JOB_TIMEOUT_MS: "5000" }), 5000);
  assert.equal(resolveJobTimeoutMs({ OPENAGI_CRON_JOB_TIMEOUT_MS: "banana" }), TIMEOUT_MS);
  assert.equal(resolveJobTimeoutMs({ OPENAGI_CRON_JOB_TIMEOUT_MS: "-1" }), TIMEOUT_MS);
  assert.equal(resolveJobTimeoutMs({ OPENAGI_CRON_JOB_TIMEOUT_MS: "0" }), TIMEOUT_MS);
  assert.equal(resolveJobTimeoutMs({ OPENAGI_CRON_JOB_TIMEOUT_MS: "Infinity" }), TIMEOUT_MS);
});

test("a job that never resolves records a failed fire and the schedule advances", { timeout: 5000 }, async () => {
  const cron = new CronScheduler();
  cron.addJob({
    id: "hung",
    name: "Hung job",
    enabled: true,
    task: "test",
    intervalMs: 60_000,
    nextRunAt: "2026-01-01T00:00:00.000Z"
  });
  const timeouts = [];
  const results = await cron.runDue(
    () => new Promise(() => {}), // never settles
    new Date("2026-01-01T00:00:01.000Z"),
    { timeoutMs: 20, onTimeout: (job, ms) => timeouts.push({ id: job.id, ms }) }
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].result.failed, true);
  assert.equal(results[0].result.timedOut, true);
  assert.match(results[0].result.error, /timed out after 20ms/);
  assert.deepEqual(timeouts, [{ id: "hung", ms: 20 }]);
  const job = cron.listJobs()[0];
  assert.equal(job.lastRunAt, "2026-01-01T00:00:01.000Z");
  assert.equal(job.nextRunAt, "2026-01-01T00:01:01.000Z", "nextRunAt advanced normally");
});

test("a hung job does not block later due jobs in the same fire", { timeout: 5000 }, async () => {
  const cron = new CronScheduler();
  cron.addJob({ id: "hung", name: "Hung", enabled: true, task: "a", intervalMs: 60_000, nextRunAt: "2026-01-01T00:00:00.000Z" });
  cron.addJob({ id: "healthy", name: "Healthy", enabled: true, task: "b", intervalMs: 60_000, nextRunAt: "2026-01-01T00:00:00.500Z" });
  const results = await cron.runDue(
    (job) => (job.id === "hung" ? new Promise(() => {}) : Promise.resolve({ ok: true })),
    new Date("2026-01-01T00:00:01.000Z"),
    { timeoutMs: 20 }
  );
  assert.equal(results.length, 2);
  const healthy = results.find((r) => r.job.id === "healthy");
  assert.deepEqual(healthy.result, { ok: true });
});

test("a throwing handler records a failed fire instead of aborting the loop", async () => {
  const cron = new CronScheduler();
  cron.addJob({ id: "boom", name: "Boom", enabled: true, task: "a", intervalMs: 60_000, nextRunAt: "2026-01-01T00:00:00.000Z" });
  cron.addJob({ id: "after", name: "After", enabled: true, task: "b", intervalMs: 60_000, nextRunAt: "2026-01-01T00:00:00.500Z" });
  const results = await cron.runDue(
    (job) => (job.id === "boom" ? Promise.reject(new Error("handler exploded")) : Promise.resolve({ ok: true })),
    new Date("2026-01-01T00:00:01.000Z")
  );
  assert.equal(results.length, 2);
  const boom = results.find((r) => r.job.id === "boom");
  assert.equal(boom.result.failed, true);
  assert.equal(boom.result.timedOut, false);
  assert.match(boom.result.error, /handler exploded/);
  assert.deepEqual(results.find((r) => r.job.id === "after").result, { ok: true });
});

test("runtime tick emits cron-job-timeout on the event bus for a hung task", { timeout: 5000 }, async () => {
  const runtime = createDefaultRuntime({ agentHost: false,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "openagi-cron-timeout-")) });
  runtime.condenser.condense = () => new Promise(() => {}); // hang the handler
  runtime.cron.addJob({
    id: "hung-condense",
    name: "Hung condense",
    enabled: true,
    task: "condense",
    intervalMs: 60_000,
    nextRunAt: new Date(Date.now() - 1000).toISOString()
  });
  const bus = new EventEmitter();
  Object.defineProperty(runtime, "events", { value: bus, enumerable: false });
  const seen = [];
  bus.on("cron-job-timeout", (d) => seen.push(d));
  process.env.OPENAGI_CRON_JOB_TIMEOUT_MS = "25";
  let results;
  try {
    results = await runtime.tick(new Date());
  } finally {
    delete process.env.OPENAGI_CRON_JOB_TIMEOUT_MS;
  }
  const fired = results.find((r) => r.job.id === "hung-condense");
  assert.ok(fired, "hung job appears in tick results");
  assert.equal(fired.result.failed, true);
  assert.equal(fired.result.timedOut, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].jobId, "hung-condense");
  assert.equal(seen[0].jobName, "Hung condense");
  assert.equal(seen[0].timeoutMs, 25);
  assert.ok(seen[0].at, "event carries a timestamp");
});
