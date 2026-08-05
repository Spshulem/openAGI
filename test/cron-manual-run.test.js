// test/cron-manual-run.test.js
//
// The measured bug: POST /cron/backlog-triage/run held the HTTP connection
// for >10 minutes and never returned, spent nothing, and left no trace on the
// job row. Three defects behind that one symptom:
//
//   1. The route dispatched ONLY task==="autopilot" specially and sent every
//      other task to runScheduledPrompt() — so a manual "backlog-triage" run
//      fired an agent chat turn with the literal text "(empty scheduled
//      prompt)" and never called backlogTriage.run(). The button could not
//      work, no matter how long you waited.
//   2. The manual path had NO timeout. runDue()'s per-job Promise.race only
//      wraps handlers the TICK invokes; the route awaited the handler naked
//      and answered only when it settled.
//   3. The manual path had NO overlap guard and never went through the
//      scheduler, so it could run the same non-idempotent job the tick was
//      already running, and left lastRunAt/nextRunAt untouched.
//
// These tests pin the fix: one shared execution path (scheduler-owned) for
// both the tick and manual runs, per-job timeouts on both, same-job overlap
// refused with a real answer, cross-job runs never serialized, and a bounded
// tick so a slow job cannot starve the schedule forever.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { CronScheduler } from "../src/cron-scheduler.js";
import { FileBackedCronScheduler } from "../src/file-backed-cron-scheduler.js";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

const never = () => new Promise(() => {});

function schedulerWith(jobs) {
  const cron = new CronScheduler();
  for (const job of jobs) cron.addJob({ enabled: true, intervalMs: 60_000, ...job });
  return cron;
}

// ---------------------------------------------------------------------------
// (a) a manual run of a DIFFERENT job returns promptly while one job hangs
// ---------------------------------------------------------------------------

test("a hung job does not serialize a manual run of a different job", { timeout: 10_000 }, async () => {
  const cron = schedulerWith([
    { id: "hang", name: "Hanging job", task: "hang", timeoutMs: 400 },
    { id: "quick", name: "Quick job", task: "quick" }
  ]);
  const handler = (job) => (job.id === "hang" ? never() : Promise.resolve({ ok: true, ran: job.id }));

  const hung = cron.runJobNow(handler, "hang", { source: "manual" });
  assert.equal(hung.started, true, "the hanging job starts");
  assert.equal(cron.isJobRunning("hang"), true, "and is tracked as in flight");

  const t0 = Date.now();
  const other = cron.runJobNow(handler, "quick", { source: "manual" });
  const settled = await other.promise;
  const elapsed = Date.now() - t0;

  assert.equal(other.started, true);
  assert.equal(settled.status, "ok", "the unrelated job actually ran");
  assert.deepEqual(settled.result, { ok: true, ran: "quick" });
  assert.ok(elapsed < 1000, `unrelated manual run must not wait on the hung job (took ${elapsed}ms)`);
  assert.equal(cron.isJobRunning("hang"), true, "the hung job is still in flight");

  await hung.promise; // let the timeout land so the test leaves nothing pending
});

// ---------------------------------------------------------------------------
// (b) the hung job is timed out and REPORTED, not silently skipped forever
// ---------------------------------------------------------------------------

test("a hung manual run times out, is reported on the job row, and fires onTimeout", { timeout: 10_000 }, async () => {
  const cron = schedulerWith([{ id: "hang", name: "Hanging job", task: "hang", timeoutMs: 150 }]);
  const timeouts = [];
  const started = cron.runJobNow(never, "hang", { source: "manual", onTimeout: (job, ms) => timeouts.push({ id: job.id, ms }) });
  const run = await started.promise;

  assert.equal(run.status, "timed-out");
  assert.equal(run.timeoutMs, 150);
  assert.match(run.error, /timed out after 150ms/);
  assert.deepEqual(timeouts, [{ id: "hang", ms: 150 }]);

  // Visible in the /cron listing, which is what the dashboard renders.
  const job = cron.listJobs().find((j) => j.id === "hang");
  assert.equal(job.lastRunStatus, "timed-out");
  assert.equal(job.lastRunSource, "manual");
  assert.ok(job.lastTimedOutAt, "the job row carries when it last timed out");
  assert.equal(cron.isJobRunning("hang"), false, "the in-flight slot is released on timeout");

  // And retrievable as a run record the client can poll.
  const record = cron.getRun(run.runId);
  assert.equal(record.status, "timed-out");
  assert.equal(record.jobId, "hang");
});

// ---------------------------------------------------------------------------
// same-job overlap protection is KEPT (the hazard the guard exists for)
// ---------------------------------------------------------------------------

test("a second manual run of the SAME in-flight job is refused, not run concurrently", { timeout: 10_000 }, async () => {
  const cron = schedulerWith([{ id: "hang", name: "Hanging job", task: "hang", timeoutMs: 300 }]);
  let invocations = 0;
  const handler = () => { invocations += 1; return never(); };

  const first = cron.runJobNow(handler, "hang", { source: "manual" });
  const second = cron.runJobNow(handler, "hang", { source: "manual" });

  assert.equal(first.started, true);
  assert.equal(second.started, false, "the same job must not run twice concurrently");
  assert.equal(second.reason, "already-running");
  assert.ok(second.running?.startedAt, "the refusal says since when it has been running");
  assert.equal(invocations, 1, "the handler was invoked exactly once");

  await first.promise;
});

test("the tick skips a job a manual run already has in flight, and leaves it due", { timeout: 10_000 }, async () => {
  const cron = schedulerWith([{ id: "hang", name: "Hanging job", task: "hang", timeoutMs: 400, nextRunAt: "2026-01-01T00:00:00.000Z" }]);
  let invocations = 0;
  const handler = () => { invocations += 1; return never(); };
  const manual = cron.runJobNow(handler, "hang", { source: "manual" });

  const results = await cron.runDue(handler, new Date("2026-01-01T00:00:01.000Z"));
  assert.equal(invocations, 1, "the tick must not start a second copy of the running job");
  assert.equal(results.length, 1);
  assert.equal(results[0].result.skipped, true);
  assert.equal(results[0].result.reason, "already-running");
  assert.equal(cron.listJobs()[0].nextRunAt, "2026-01-01T00:00:00.000Z", "the skipped fire stays due, it is not lost");

  await manual.promise;
});

// ---------------------------------------------------------------------------
// manual runs use the SAME dispatch table as the tick (the backlog-triage bug)
// ---------------------------------------------------------------------------

test("a manual run of a non-prompt task runs THAT task, not an agent chat turn", { timeout: 10_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-cron-dispatch-"));
  const runtime = createDurableRuntime({ dataDir });
  let condensed = 0;
  runtime.condenser.condense = async () => { condensed += 1; return { principles: 3 }; };
  runtime.runScheduledPrompt = async () => { throw new Error("manual run must not fall through to runScheduledPrompt"); };
  runtime.cron.addJob({ id: "manual-condense", name: "Condense", enabled: true, task: "condense", intervalMs: 60_000, replace: true });

  const started = runtime.cron.runJobNow((job) => runtime.runJobTask(job), "manual-condense", { source: "manual" });
  const run = await started.promise;
  assert.equal(run.status, "ok");
  assert.equal(condensed, 1, "the real condense handler ran");
  assert.deepEqual(run.result, { principles: 3 });
});

// ---------------------------------------------------------------------------
// a slow tick cannot starve the schedule forever
// ---------------------------------------------------------------------------

// These two pin the budget from both sides. They deliberately avoid asking
// "how many jobs fit inside 100ms of wall clock" — that phrasing made the
// assertion a stopwatch race against the machine, and it failed intermittently
// under full-suite load (three 60ms handlers against a 100ms budget: if the
// first handler's timer is late, the tick stops at one job instead of two and
// the test fails even though the production behaviour is exactly right). Each
// scenario below is separated from its threshold by orders of magnitude, so
// scheduling jitter cannot flip the outcome.
const budgetJobs = () => schedulerWith([
  { id: "a", name: "A", task: "t", nextRunAt: "2026-01-01T00:00:00.000Z" },
  { id: "b", name: "B", task: "t", nextRunAt: "2026-01-01T00:00:00.100Z" },
  { id: "c", name: "C", task: "t", nextRunAt: "2026-01-01T00:00:00.200Z" }
]);
const TICK_NOW = new Date("2026-01-01T00:00:01.000Z");

test("a generous tick budget does not truncate the fire — every due job runs", { timeout: 10_000 }, async () => {
  const cron = budgetJobs();
  const ran = [];
  const results = await cron.runDue(
    async (job) => { ran.push(job.id); return { ok: true }; },
    TICK_NOW,
    { tickBudgetMs: 60_000 }
  );
  assert.deepEqual(ran, ["a", "b", "c"], "the budget must not cut a fire short when there is time left");
  assert.equal(results.length, 3);
});

test("an exhausted tick budget stops starting new jobs and leaves the rest due", { timeout: 10_000 }, async () => {
  const cron = budgetJobs();
  const ran = [];
  // Budget 1ms, handler 50ms: after the first job the budget is spent by a
  // factor of ~50, whatever the machine is doing.
  const results = await cron.runDue(
    async (job) => { ran.push(job.id); await new Promise((r) => setTimeout(r, 50)); return { ok: true }; },
    TICK_NOW,
    { tickBudgetMs: 1 }
  );
  assert.deepEqual(ran, ["a"], "the FIRST job always runs — a lone slow job must still get its turn");
  assert.equal(results.length, 1);
  // Nothing is dropped: the unstarted jobs keep their nextRunAt and are still
  // due on the next tick 10s later.
  const jobs = cron.listJobs();
  assert.equal(jobs.find((j) => j.id === "b").nextRunAt, "2026-01-01T00:00:00.100Z");
  assert.equal(jobs.find((j) => j.id === "c").nextRunAt, "2026-01-01T00:00:00.200Z");
  assert.deepEqual(cron.dueJobs(TICK_NOW).map((j) => j.id), ["b", "c"], "the deferred jobs stay due");
});

// ---------------------------------------------------------------------------
// HTTP round trip: the route answers immediately, always
// ---------------------------------------------------------------------------

async function bootApp(prefix) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, authToken: null });
  const listened = await app.listen();
  return { runtime, app, dataDir, base: listened.url ?? `http://127.0.0.1:${listened.port}` };
}

test("POST /cron/:id/run answers in milliseconds even when the job hangs", { timeout: 20_000 }, async () => {
  const { runtime, app, base } = await bootApp("openagi-cron-route-");
  try {
    runtime.runJobTask = async (job) => (job.id === "hang" ? never() : { ok: true, ran: job.id });
    // Timeout comfortably past the route's 1500ms grace window, so the 202
    // path is what is under test here rather than a race with the timeout.
    runtime.cron.addJob({ id: "hang", name: "Hanging job", enabled: true, task: "hang", intervalMs: 60_000, timeoutMs: 4000, replace: true });
    runtime.cron.addJob({ id: "quick", name: "Quick job", enabled: true, task: "quick", intervalMs: 60_000, replace: true });

    const t0 = Date.now();
    const res = await fetch(`${base}/cron/hang/run`, { method: "POST" });
    const accepted = await res.json();
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 202, "a run that outlives the grace window is ACCEPTED, not held open");
    assert.ok(elapsed < 5000, `the route must answer promptly (took ${elapsed}ms)`);
    assert.equal(accepted.status, "accepted");
    assert.ok(accepted.runId, "the client gets a runId to poll");
    assert.match(accepted.poll, /^\/cron\/runs\//);

    // A manual run of a DIFFERENT job still works while the first hangs.
    const t1 = Date.now();
    const otherRes = await fetch(`${base}/cron/quick/run`, { method: "POST" });
    const other = await otherRes.json();
    assert.ok(Date.now() - t1 < 5000, "cross-job manual runs are not serialized");
    assert.equal(otherRes.status, 200);
    assert.equal(other.status, "ran");
    assert.deepEqual(other.result, { ok: true, ran: "quick" });

    // Re-running the SAME in-flight job is refused with a real answer.
    const dupe = await fetch(`${base}/cron/hang/run`, { method: "POST" });
    assert.equal(dupe.status, 409);
    const dupeBody = await dupe.json();
    assert.equal(dupeBody.status, "already-running");
    assert.ok(dupeBody.startedAt);

    // The hung run is eventually timed out and visible to a poll + the listing.
    let polled = null;
    for (let i = 0; i < 60; i += 1) {
      const r = await fetch(`${base}${accepted.poll}`);
      polled = await r.json();
      if (polled.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(polled.status, "timed-out", "the hung job is reported as timed out, not silently dropped");
    const jobs = await (await fetch(`${base}/cron`)).json();
    const hang = jobs.find((j) => j.id === "hang");
    assert.equal(hang.lastRunStatus, "timed-out", "GET /cron reports the timed-out status");
  } finally {
    await app.close();
  }
});

test("POST /cron/:id/run returns the result inline when the job is fast", { timeout: 20_000 }, async () => {
  const { runtime, app, base } = await bootApp("openagi-cron-route-fast-");
  try {
    runtime.runJobTask = async () => ({ ok: true, cheap: true });
    runtime.cron.addJob({ id: "fast", name: "Fast job", enabled: true, task: "fast", intervalMs: 60_000, replace: true });
    const res = await fetch(`${base}/cron/fast/run`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ran");
    assert.deepEqual(body.result, { ok: true, cheap: true });
    assert.ok(body.runId);
    assert.ok(typeof body.durationMs === "number");
  } finally {
    await app.close();
  }
});

test("POST /cron/:id/run on an unknown job is refused, not accepted", { timeout: 20_000 }, async () => {
  const { app, base } = await bootApp("openagi-cron-route-404-");
  try {
    const res = await fetch(`${base}/cron/nope/run`, { method: "POST" });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, "unknown-job");
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// durability: a manual run leaves the same crash-visible marker the tick does
// ---------------------------------------------------------------------------

test("a manual run persists the running marker and the terminal status", { timeout: 10_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-cron-manual-marker-"));
  const storePath = path.join(dir, "jobs.json");
  const cron = new FileBackedCronScheduler({ storePath });
  cron.addJob({ id: "slow", name: "Slow job", enabled: true, task: "t", intervalMs: 60_000, timeoutMs: 5000 });

  let markerDuringRun = null;
  const started = cron.runJobNow(async () => {
    markerDuringRun = JSON.parse(fs.readFileSync(storePath, "utf8")).running ?? null;
    return { ok: true };
  }, "slow", { source: "manual" });
  await started.promise;

  assert.ok(markerDuringRun, "marker on disk while a manual handler runs");
  assert.equal(markerDuringRun.runningJobId, "slow");
  const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8"));
  assert.equal(onDisk.running ?? null, null, "marker cleared when the manual run ends");
  assert.equal(onDisk.jobs[0].lastRunStatus, "ok", "the terminal status is persisted");
  assert.equal(onDisk.jobs[0].lastRunSource, "manual");
});
