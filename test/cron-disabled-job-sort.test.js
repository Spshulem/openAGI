// test/cron-disabled-job-sort.test.js
//
// CronScheduler.enableJob(id, false) sets nextRunAt = null ("a disabled job has
// no next fire"), and listJobs() sorts with `a.nextRunAt.localeCompare(...)`.
// Those two have always disagreed: the first disable makes every later
// listJobs() throw
//
//   TypeError: Cannot read properties of null (reading 'localeCompare')
//
// On the in-memory scheduler that breaks GET /cron and runtime.status() (which
// embeds cron.listJobs(), so /health 500s too). On the file-backed scheduler it
// is worse and immediate: enableJob() -> save() -> listJobs(), so the disable
// call itself throws — after super.enableJob() has already mutated the job in
// memory. The user presses "disable", gets an error, and the job is left
// disabled-but-unpersisted until something else saves.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CronScheduler } from "../src/cron-scheduler.js";
import { FileBackedCronScheduler } from "../src/file-backed-cron-scheduler.js";

test("listJobs() survives a disabled job (nextRunAt = null) and sorts it last", () => {
  const cron = new CronScheduler();
  cron.addJob({ id: "early", name: "Early", task: "prompt", dailyAt: "01:00" });
  cron.addJob({ id: "late", name: "Late", task: "prompt", dailyAt: "23:00" });
  cron.addJob({ id: "off", name: "Off", task: "prompt", dailyAt: "02:00" });

  cron.enableJob("off", false);

  const ids = cron.listJobs().map((j) => j.id);
  assert.equal(ids.length, 3, "a disabled job must still be listed — it is how the user re-enables it");
  assert.equal(ids[ids.length - 1], "off", "a job with no next fire sorts last, not first");
  // Two disabled jobs must not throw against each other either.
  cron.enableJob("late", false);
  assert.equal(cron.listJobs().length, 3);
  // And the schedule still only fires what is enabled.
  assert.deepEqual(cron.dueJobs(new Date("2030-01-01T12:00:00.000Z")).map((j) => j.id), ["early"]);
});

test("the file-backed scheduler can disable a job and persist it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-disable-"));
  const storePath = path.join(dir, "jobs.json");
  const cron = new FileBackedCronScheduler({ storePath });
  cron.addJob({ id: "keeper", name: "Keeper", task: "prompt", dailyAt: "01:00" });
  cron.addJob({ id: "victim", name: "Victim", task: "prompt", dailyAt: "02:00" });

  // This is the exact call POST /cron/:id/enable makes.
  cron.enableJob("victim", false);

  const persisted = JSON.parse(fs.readFileSync(storePath, "utf8"));
  assert.equal(persisted.jobs.length, 2);
  const victim = persisted.jobs.find((j) => j.id === "victim");
  assert.equal(victim.enabled, false, "the disable must reach disk, not die in save()");
  assert.equal(victim.nextRunAt, null);

  // A fresh scheduler over the same file must load it back without throwing.
  const reloaded = new FileBackedCronScheduler({ storePath });
  assert.equal(reloaded.listJobs().find((j) => j.id === "victim").enabled, false);

  fs.rmSync(dir, { recursive: true, force: true });
});
