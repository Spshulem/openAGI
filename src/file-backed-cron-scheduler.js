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
    // { runningJobId, startedAt } while a job handler is executing; persisted
    // into the store so a mid-run daemon death leaves a visible marker.
    this.running = null;
    // jobId -> marker. A manual "Run now" can overlap a tick job (different
    // jobs are allowed to run concurrently), so the marker cannot be a single
    // slot that whichever job finishes first clears. The persisted `running`
    // field keeps its original single-object shape — the OLDEST live job — so
    // consumeInterruption() and the on-disk format are unchanged.
    this._runningById = new Map();
    // Marker found on disk at load time (previous process died mid-job).
    // Consumed once at boot via consumeInterruption().
    this._interrupted = null;
    if (options.autoLoad !== false) this.load();
  }

  load() {
    const store = readJsonFile(this.storePath, { version: 1, jobs: [] });
    this.jobs = new Map();
    for (const job of store.jobs ?? []) {
      if (!job.id) continue;
      this.jobs.set(job.id, job);
    }
    // A persisted running marker means the previous process died while this
    // job's handler was executing. Stash it for consumeInterruption().
    this._interrupted = store.running ?? null;
    this.running = null;
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

  async runDue(handler, now = new Date(), options = {}) {
    const results = await super.runDue(handler, now, options);
    if (results.length > 0) this.save();
    return results;
  }

  // runDue() hooks (see CronScheduler.runDue): persist the mid-run marker
  // while a handler executes so a daemon death mid-job is visible next boot.
  noteJobStart(job) {
    this._runningById.set(job.id, { runningJobId: job.id, startedAt: nowIso() });
    this.running = this._oldestRunning();
    this.save();
  }

  // No disk write here (was a full-file rewrite on every job, tripling I/O
  // per tick): the in-memory clear is always flushed by whichever comes
  // next — the following job's noteJobStart(), runDue's own tick-closing
  // save(), or runJobNow's save() — before a crash could observe the gap.
  noteJobEnd(job) {
    if (job?.id) this._runningById.delete(job.id);
    else this._runningById.clear();
    this.running = this._oldestRunning();
  }

  _oldestRunning() {
    let oldest = null;
    for (const marker of this._runningById.values()) {
      if (!oldest || marker.startedAt < oldest.startedAt) oldest = marker;
    }
    return oldest;
  }

  // Boot note: return the marker left by a process that died mid-job (or
  // null after a clean shutdown), clearing it from memory and disk. The
  // hosted interface calls this once at boot and emits "cron-interrupted".
  consumeInterruption() {
    const marker = this._interrupted;
    this._interrupted = null;
    if (!marker) return null;
    this.save();
    const job = marker.runningJobId ? this.jobs.get(marker.runningJobId) : null;
    return { ...marker, jobName: job?.name ?? (marker.runningJobId ?? "unknown") };
  }

  save() {
    writeJsonAtomic(this.storePath, {
      version: 1,
      updatedAt: nowIso(),
      jobs: this.listJobs(),
      ...(this.running ? { running: this.running } : {})
    });
  }
}
