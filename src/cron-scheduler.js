import { createId, nowIso } from "./utils.js";

export class CronScheduler {
  constructor() {
    this.jobs = new Map();
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
      nextRunAt: job.nextRunAt ?? this.computeNextRun(job, new Date()).toISOString(),
      createdAt: job.createdAt ?? nowIso(),
      lastRunAt: null
    };
    this.jobs.set(normalized.id, normalized);
    return normalized;
  }

  listJobs() {
    return [...this.jobs.values()].sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
  }

  dueJobs(now = new Date()) {
    const current = now instanceof Date ? now : new Date(now);
    return this.listJobs().filter((job) => job.enabled && new Date(job.nextRunAt) <= current);
  }

  async runDue(handler, now = new Date()) {
    const results = [];
    for (const job of this.dueJobs(now)) {
      const result = await handler(job);
      job.lastRunAt = (now instanceof Date ? now : new Date(now)).toISOString();
      job.nextRunAt = this.computeNextRun(job, new Date(job.lastRunAt)).toISOString();
      results.push({ job, result });
    }
    return results;
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
