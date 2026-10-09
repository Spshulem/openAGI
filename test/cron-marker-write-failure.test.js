import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileBackedCronScheduler } from "../src/file-backed-cron-scheduler.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-write-failure-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cron = new FileBackedCronScheduler({ storePath: path.join(dir, "jobs.json") });
  cron.addJob({ id: "first", task: "fixture", intervalMs: 1000, nextRunAt: "2026-01-01T00:00:00.000Z" });
  const save = cron.save.bind(cron);
  let failures = 1;
  cron.save = () => {
    if (failures-- > 0) throw Object.assign(new Error("fixture marker write failed"), { code: "ENOSPC" });
    return save();
  };
  return cron;
}

test("failed marker write terminates the run, clears both guards, and permits the next scheduled fire", async (t) => {
  const cron = fixture(t);
  cron.save = FileBackedCronScheduler.prototype.save.bind(cron);
  cron.addJob({ id: "later", task: "fixture", intervalMs: 1000, nextRunAt: "2026-01-01T00:00:00.500Z" });
  // Adding a job also saves: inject the failure specifically at job start.
  const save = FileBackedCronScheduler.prototype.save.bind(cron);
  let fail = true;
  cron.save = () => {
    if (fail) { fail = false; throw new Error("fixture marker write failed"); }
    return save();
  };
  const called = [];
  const handler = async (job) => { called.push(job.id); return { ok: true }; };
  const results = await cron.runDue(handler, new Date("2026-01-01T00:00:01.000Z"));
  assert.equal(results[0].result.failed, true);
  assert.deepEqual(called, ["later"], "do not dispatch without the durable start marker");
  assert.equal(cron.listRunning().length, 0);
  assert.equal(cron._runningById.size, 0);
  assert.equal(cron.running, null);
  const failed = cron.listRuns().find(r => r.jobId === "first");
  assert.equal(failed.status, "failed");
  assert.ok(failed.finishedAt);
  assert.equal(typeof failed.durationMs, "number");
  assert.equal(cron.jobs.get("first").lastRunStatus, "failed");
  assert.equal(JSON.parse(fs.readFileSync(cron.storePath)).running, undefined);
  await cron.runDue(handler, new Date("2026-01-01T00:00:02.000Z"));
  assert.deepEqual(called, ["later", "first", "later"]);
  assert.equal(cron.jobs.get("first").lastRunStatus, "ok");
});

test("manual marker failure returns a terminal record and permits retry after storage recovery", async (t) => {
  const cron = fixture(t);
  let calls = 0;
  const handler = async () => { calls++; return { ok: true }; };
  const first = cron.runJobNow(handler, "first");
  const failed = await first.promise;
  assert.equal(failed.status, "failed");
  assert.ok(failed.finishedAt);
  assert.equal(calls, 0);
  assert.equal(cron.isJobRunning("first"), false);
  assert.equal(cron._runningById.size, 0);
  const retry = cron.runJobNow(handler, "first");
  assert.equal(retry.started, true);
  assert.equal((await retry.promise).status, "ok");
  assert.equal(calls, 1);
});
