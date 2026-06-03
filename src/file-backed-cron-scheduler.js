import path from "node:path";
import { CronScheduler } from "./cron-scheduler.js";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

export class FileBackedCronScheduler extends CronScheduler {
  constructor(options = {}) {
    super();
    this.storePath = options.storePath ?? path.join(resolveDataDir(), "cron", "jobs.json");
    ensureDir(path.dirname(this.storePath));
    if (options.autoLoad !== false) this.load();
  }

  load() {
    const store = readJsonFile(this.storePath, { version: 1, jobs: [] });
    this.jobs = new Map();
    for (const job of store.jobs ?? []) {
      if (!job.id) continue;
      this.jobs.set(job.id, job);
    }
    return this.listJobs();
  }

  addJob(job) {
    const existing = job.id ? this.jobs.get(job.id) : null;
    const result = super.addJob(job);
    if (!existing || job.replace === true) this.save();
    return result;
  }

  updateJob(id, patch) {
    const job = super.updateJob(id, patch);
    this.save();
    return job;
  }

  removeJob(id) {
    const removed = super.removeJob(id);
    if (removed) this.save();
    return removed;
  }

  enableJob(id, enabled) {
    const job = super.enableJob(id, enabled);
    this.save();
    return job;
  }

  async runDue(handler, now = new Date()) {
    const results = await super.runDue(handler, now);
    if (results.length > 0) this.save();
    return results;
  }

  save() {
    writeJsonAtomic(this.storePath, {
      version: 1,
      updatedAt: nowIso(),
      jobs: this.listJobs()
    });
  }
}
