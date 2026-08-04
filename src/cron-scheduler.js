import { createId, nowIso } from "./utils.js";

// Per-job timeout: one hung handler (a stuck LLM call, a wedged MCP server)
// must not stall every later scheduled job. Each handler invocation in
// runDue() races a timer; on timeout the fire records as failed and
// nextRunAt advances normally. HONEST LIMITATION: Promise.race abandons the
// losing promise — the hung handler keeps running in the background; it is
// NOT cancelled. Acceptable v1 because handlers are in-process async work we
// cannot kill without worker isolation, and the property we need is that the
// schedule keeps moving; the leaked promise is bounded by process lifetime.
export const TIMEOUT_MS = 10 * 60 * 1000;

// Why 10 minutes and not 60s or an hour. The floor is set by the slowest
// LEGITIMATE job: backlog-triage sends maxLlmItems/batchSize = 200/25 = 8
// sequential model batches, and ModelProvider bounds each call at 120s, so a
// worst-case honest pass is ~16 min of wall clock. Rather than raise the
// global ceiling to fit it (which would let every other job hang for 16 min),
// backlog-triage self-limits its LLM phase to 7 min (DEFAULTS.deadlineMs in
// backlog-triage.js) and stops early with a partial report — so 10 min covers
// it with 3 min of slack for the deterministic phase and disk I/O. Jobs that
// genuinely need longer set `timeoutMs` on the job row; it is per-job, not
// global. The ceiling matters because on timeout the handler is ABANDONED,
// not cancelled — a job written to run past it loses its work entirely.
export const TICK_BUDGET_MS = 15 * 60 * 1000;

const TIMED_OUT = Symbol("cron-job-timed-out");

// How many finished run records to keep for polling (/cron/runs/:runId).
const MAX_RUN_RECORDS = 50;

// Env override: OPENAGI_CRON_JOB_TIMEOUT_MS, parsed with Number and only
// honored when finite and > 0; anything else falls back to TIMEOUT_MS.
export function resolveJobTimeoutMs(env = process.env) {
  const raw = env.OPENAGI_CRON_JOB_TIMEOUT_MS;
  if (raw === undefined || raw === null || raw === "") return TIMEOUT_MS;
  const parsed = Number(raw);
  return (Number.isFinite(parsed) && parsed > 0) ? parsed : TIMEOUT_MS;
}

// Wall-clock budget for ONE runDue pass. Per-job timeouts bound a single
// handler; this bounds the whole fire. Without it, 14 due jobs at 10 min each
// is 140 minutes during which AbiRuntime.tick() skips every 10s tick and no
// other scheduled job runs — starvation that logs one line and nothing else.
// Past the budget runDue stops STARTING new jobs (it never interrupts one in
// flight, so the real bound is budget + one job timeout) and the untouched
// jobs stay due for the next tick, 10s later. Nothing is dropped.
export function resolveTickBudgetMs(env = process.env) {
  const raw = env.OPENAGI_CRON_TICK_BUDGET_MS;
  if (raw === undefined || raw === null || raw === "") return TICK_BUDGET_MS;
  const parsed = Number(raw);
  return (Number.isFinite(parsed) && parsed > 0) ? parsed : TICK_BUDGET_MS;
}

// Run records travel over HTTP (GET /cron/runs/:runId). A handler result that
// JSON.stringify cannot render (circular, BigInt) must degrade to a note, not
// blow up the route with a 500.
function jsonSafe(value) {
  if (value === undefined) return null;
  try {
    JSON.stringify(value);
    return value;
  } catch (error) {
    return { unserializable: true, reason: String(error?.message ?? error).slice(0, 200) };
  }
}

export class CronScheduler {
  constructor() {
    this.jobs = new Map();
    // jobId -> run record, for jobs executing RIGHT NOW (tick or manual).
    // This is the same-job overlap guard: one entry per job id, so the same
    // non-idempotent handler can never run twice concurrently, while two
    // DIFFERENT jobs are free to overlap.
    this.inFlight = new Map();
    // runId -> run record, most recent first, capped at MAX_RUN_RECORDS so a
    // long-lived daemon does not grow this without bound.
    this.runs = new Map();
  }

  addJob(job) {
    const id = job.id ?? createId("job");
    const existing = this.jobs.get(id);
    if (existing && job.replace !== true) return existing;

    const normalized = {
      id,
      name: job.name ?? "Scheduled job",
      enabled: job.enabled ?? true,
      task: job.task,
      input: job.input ?? {},
      intervalMs: job.intervalMs ?? null,
      dailyAt: job.dailyAt ?? null,
      // Per-job override of TIMEOUT_MS. null = use the global default.
      timeoutMs: Number.isFinite(job.timeoutMs) && job.timeoutMs > 0 ? job.timeoutMs : null,
      nextRunAt: job.nextRunAt ?? this.computeNextRun(job, new Date()).toISOString(),
      createdAt: job.createdAt ?? nowIso(),
      lastRunAt: null
    };
    this.jobs.set(normalized.id, normalized);
    return normalized;
  }

  listJobs() {
    // enableJob(id, false) deliberately sets nextRunAt = null — a disabled job
    // has no next fire. Sorting that with localeCompare threw, which made the
    // FIRST disable of any job explode: FileBackedCronScheduler.enableJob calls
    // save() -> listJobs(). Order disabled jobs last and keep them listed;
    // hiding them would remove the only way back to enabled.
    return [...this.jobs.values()].sort((a, b) => {
      if (!a.nextRunAt && !b.nextRunAt) return 0;
      if (!a.nextRunAt) return 1;
      if (!b.nextRunAt) return -1;
      return a.nextRunAt.localeCompare(b.nextRunAt);
    });
  }

  dueJobs(now = new Date()) {
    const current = now instanceof Date ? now : new Date(now);
    return this.listJobs().filter((job) => job.enabled && new Date(job.nextRunAt) <= current);
  }

  // ---------------------------------------------------------------------
  // Execution. runDue() (the tick) and runJobNow() (a user pressing "Run
  // now") share ONE code path, so both get the same timeout, the same
  // same-job overlap guard, the same recorded status, and — critically —
  // the same dispatch. They differ only in what advances the schedule.
  // ---------------------------------------------------------------------

  jobTimeoutMs(job, override) {
    if (Number.isFinite(override) && override > 0) return override;
    if (Number.isFinite(job?.timeoutMs) && job.timeoutMs > 0) return job.timeoutMs;
    return resolveJobTimeoutMs();
  }

  isJobRunning(jobId) {
    return this.inFlight.has(jobId);
  }

  runningJob(jobId) {
    return this.inFlight.get(jobId) ?? null;
  }

  listRunning() {
    return [...this.inFlight.values()];
  }

  getRun(runId) {
    return this.runs.get(runId) ?? null;
  }

  listRuns(limit = 20) {
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  _recordRun(run) {
    this.runs.set(run.runId, run);
    // Evict finished records oldest-first; never evict one still running.
    while (this.runs.size > MAX_RUN_RECORDS) {
      const stale = [...this.runs.values()].find((r) => r.status !== "running");
      if (!stale) break;
      this.runs.delete(stale.runId);
    }
    return run;
  }

  // Runs one job to completion (or timeout) with the overlap guard held.
  // Never throws and never rejects: every outcome is a terminal run record.
  async _executeJob(handler, job, options = {}) {
    const timeoutMs = this.jobTimeoutMs(job, options.timeoutMs);
    const source = options.source ?? "cron";
    const run = this._recordRun({
      runId: options.runId ?? createId("cronrun"),
      jobId: job.id,
      jobName: job.name,
      task: job.task,
      source,
      status: "running",
      startedAt: nowIso(),
      finishedAt: null,
      durationMs: null,
      timeoutMs,
      error: null,
      result: null
    });
    const startedMs = Date.now();
    this.inFlight.set(job.id, run);
    // Mid-run marker hook: FileBackedCronScheduler persists a
    // { runningJobId, startedAt } note so a daemon death mid-job is
    // visible on the next boot. No-op on the in-memory scheduler.
    this.noteJobStart?.(job);
    let result;
    let timer = null;
    try {
      const raced = await Promise.race([
        handler(job),
        new Promise((resolve) => {
          // Deliberately ref'd: when the handler hangs, this timer is the
          // only thing that resolves the race, so it must keep the event
          // loop alive until it fires. It is always cleared in finally, so
          // it never outlives the fire.
          timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
        })
      ]);
      if (raced === TIMED_OUT) {
        result = {
          failed: true,
          timedOut: true,
          error: `Job ${job.id} timed out after ${timeoutMs}ms (handler abandoned, not cancelled)`
        };
        run.status = "timed-out";
        run.error = result.error;
        options.onTimeout?.(job, timeoutMs);
      } else {
        result = raced;
        run.status = "ok";
        run.result = jsonSafe(result);
      }
    } catch (error) {
      // A throwing handler used to abort the whole runDue loop, leaving
      // this job due again next tick (hot retry every 10s) and later due
      // jobs unfired. Record the failure and keep the schedule moving.
      result = { failed: true, timedOut: false, error: error?.message ?? String(error) };
      run.status = "failed";
      run.error = result.error;
    } finally {
      if (timer) clearTimeout(timer);
      this.inFlight.delete(job.id);
      this.noteJobEnd?.(job);
    }
    run.finishedAt = nowIso();
    run.durationMs = Date.now() - startedMs;

    // Terminal status on the job row itself — this is what GET /cron returns,
    // so a timed-out job is visible in the listing instead of vanishing.
    job.lastRunStatus = run.status;
    job.lastRunSource = source;
    job.lastRunMs = run.durationMs;
    job.lastRunId = run.runId;
    job.lastError = run.error ? String(run.error).slice(0, 300) : null;
    if (run.status === "timed-out") {
      job.lastTimedOutAt = run.finishedAt;
      job.consecutiveTimeouts = (job.consecutiveTimeouts ?? 0) + 1;
    } else {
      job.consecutiveTimeouts = 0;
    }
    return { run, result };
  }

  async runDue(handler, now = new Date(), options = {}) {
    const budgetMs = options.tickBudgetMs ?? resolveTickBudgetMs();
    const tickStartedMs = Date.now();
    const results = [];
    for (const job of this.dueJobs(now)) {
      // Bounded fire: never pre-empt the first job (a lone slow job must still
      // get its full timeout), but past the budget stop STARTING new ones.
      // Their nextRunAt is untouched, so they are still due on the next tick.
      if (results.length > 0 && Date.now() - tickStartedMs >= budgetMs) {
        options.onBudgetExceeded?.(job, budgetMs);
        break;
      }
      // Same-job overlap guard. A manual "Run now" may already have this exact
      // job in flight; starting a second copy is the non-idempotent hazard the
      // guard exists for. Skip THIS fire without advancing nextRunAt, so the
      // scheduled run is deferred by one tick rather than lost.
      if (this.isJobRunning(job.id)) {
        const running = this.runningJob(job.id);
        results.push({
          job,
          result: { skipped: true, reason: "already-running", since: running?.startedAt ?? null, source: running?.source ?? null }
        });
        continue;
      }
      const { result } = await this._executeJob(handler, job, {
        timeoutMs: options.timeoutMs,
        onTimeout: options.onTimeout,
        source: "cron"
      });
      job.lastRunAt = (now instanceof Date ? now : new Date(now)).toISOString();
      job.nextRunAt = this.computeNextRun(job, new Date(job.lastRunAt)).toISOString();
      results.push({ job, result });
    }
    return results;
  }

  // A user-initiated run. Returns SYNCHRONOUSLY with a decision — started or
  // refused — plus a promise for the eventual run record. The caller (the
  // /cron route) answers the HTTP request from the decision and never has to
  // hold the connection open waiting for the handler.
  //
  // A manual run deliberately does NOT advance nextRunAt: the schedule is the
  // user's, and silently pushing the next fire a week out because someone
  // pressed a button is a worse surprise than an extra run. It does record
  // lastRunAt/lastRunStatus, because it really did run.
  runJobNow(handler, jobOrId, options = {}) {
    const job = typeof jobOrId === "string" ? this.jobs.get(jobOrId) : jobOrId;
    if (!job) return { started: false, reason: "unknown-job", jobId: typeof jobOrId === "string" ? jobOrId : null };
    if (this.isJobRunning(job.id)) {
      const running = this.runningJob(job.id);
      return {
        started: false,
        reason: "already-running",
        jobId: job.id,
        running: { runId: running.runId, startedAt: running.startedAt, source: running.source, timeoutMs: running.timeoutMs }
      };
    }
    const runId = createId("cronrun");
    const promise = this._executeJob(handler, job, {
      runId,
      timeoutMs: options.timeoutMs,
      onTimeout: options.onTimeout,
      source: options.source ?? "manual"
    }).then(({ run }) => {
      job.lastRunAt = nowIso();
      this.save?.();
      return run;
    });
    // _executeJob never rejects, but a broken save() must not surface as an
    // unhandled rejection in the daemon.
    const settled = promise.catch((error) => {
      const run = this.getRun(runId);
      if (run) {
        run.status = run.status === "running" ? "failed" : run.status;
        run.error = run.error ?? String(error?.message ?? error);
      }
      return run;
    });
    return { started: true, jobId: job.id, runId, run: this.getRun(runId), promise: settled };
  }

  updateJob(id, patch) {
    const existing = this.jobs.get(id);
    if (!existing) throw new Error(`Unknown cron job: ${id}`);
    const updated = {
      ...existing,
      ...patch,
      id,
      updatedAt: nowIso()
    };
    if ("nextRunAt" in patch) {
      updated.nextRunAt = patch.nextRunAt;
    } else if ("intervalMs" in patch || "dailyAt" in patch) {
      updated.nextRunAt = this.computeNextRun(updated, new Date()).toISOString();
    }
    this.jobs.set(id, updated);
    return updated;
  }

  removeJob(id) {
    return this.jobs.delete(id);
  }

  enableJob(id, enabled) {
    const existing = this.jobs.get(id);
    if (!existing) throw new Error(`Unknown cron job: ${id}`);
    existing.enabled = Boolean(enabled);
    existing.nextRunAt = existing.enabled ? this.computeNextRun(existing, new Date()).toISOString() : null;
    return existing;
  }

  computeNextRun(job, from) {
    if (job.intervalMs) return new Date(from.getTime() + job.intervalMs);
    if (job.dailyAt) {
      const [hour, minute] = job.dailyAt.split(":").map((part) => Number.parseInt(part, 10));
      const next = new Date(from);
      next.setHours(hour, minute ?? 0, 0, 0);
      if (next <= from) next.setDate(next.getDate() + 1);
      return next;
    }
    return new Date(from.getTime() + 1000 * 60 * 60 * 24);
  }
}

export function createDailyAdaptationReviewJob(input = {}) {
  return {
    id: "daily-adaptation-review",
    name: "Daily Adaptation Review",
    dailyAt: input.dailyAt ?? "08:30",
    task: "daily-adaptation-review",
    input: {
      source: "cron",
      type: "adaptation-review-request",
      domain: "general",
      taskType: "adaptation-review",
      summary: "Review recent pressures, memory candidates, and propagation opportunities.",
      urgency: 0.45,
      impact: 0.75,
      novelty: 0.35,
      repetition: 0.85,
      risk: 0.45,
      goalAlignment: 0.9,
      strategicFit: 0.85,
      confidence: 0.7,
      specificity: 0.65,
      requiresSpecialist: true,
      ...(input.signal ?? {})
    }
  };
}

export const createDailyPersonaResearchJob = createDailyAdaptationReviewJob;
