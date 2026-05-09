// D5 — Introspector. Periodically (or on-demand) produces a structural
// audit of the runtime: specialist tree health, memory tier saturation,
// schedule load, budget burn, channel readiness. Drives the Health
// dashboard tab and the weekly autopilot review prompt.

export class Introspector {
  constructor(options = {}) {
    this.runtime = options.runtime;
  }

  audit() {
    const r = this.runtime;
    const specialists = r.propagation?.list?.({ includeRetired: true }) ?? [];
    const active = specialists.filter((s) => s.status !== "retired");
    const retired = specialists.filter((s) => s.status === "retired");
    const dormant = active.filter((s) => {
      const last = s.lastActivatedAt ? new Date(s.lastActivatedAt).getTime() : 0;
      return Date.now() - last > 14 * 86400 * 1000;
    });
    const lowQuality = active.filter((s) => (s.outcomeSamples ?? 0) >= 5 && (s.meanOutcomeQuality ?? 1) < 0.4);

    const memSnap = r.memory.snapshot();
    const memLimits = r.memory.limits ?? { short: 100, medium: 500, long: 1000 };
    const memSaturation = {
      short: memSnap.short.length / memLimits.short,
      medium: memSnap.medium.length / memLimits.medium,
      long: memSnap.long.length / memLimits.long
    };

    const cron = r.cron?.listJobs?.() ?? [];
    const enabledCron = cron.filter((j) => j.enabled);
    const upcoming = cron
      .filter((j) => j.enabled && j.nextRunAt)
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
      .slice(0, 5)
      .map((j) => ({ id: j.id, name: j.name, task: j.task, nextRunAt: j.nextRunAt }));

    const budget = r.budget?.status?.() ?? null;
    const outcomeAgg7 = r.outcomes?.aggregate?.(7) ?? null;
    const outcomeAgg30 = r.outcomes?.aggregate?.(30) ?? null;

    const channels = r.channels?.status?.() ?? null;
    const mcp = (r.mcp?.listServers?.() ?? []).map((s) => ({ name: s.name, connected: s.connected, tools: (s.tools ?? []).length }));

    const findings = [];
    if (memSaturation.short > 0.85) findings.push({ severity: "warn", area: "memory", note: "short tier > 85% — older items will start dropping." });
    if (memSaturation.long > 0.85) findings.push({ severity: "warn", area: "memory", note: "long tier > 85% — consider raising limit or curating principles." });
    if (dormant.length > 0) findings.push({ severity: "info", area: "specialists", note: `${dormant.length} specialist(s) dormant >14d — retirement-sweep will handle at 30d.` });
    if (lowQuality.length > 0) findings.push({ severity: "warn", area: "specialists", note: `${lowQuality.length} specialist(s) under-performing (<0.4 mean quality).` });
    if (budget && budget.spentUsd / Math.max(budget.dailyUsdLimit, 0.0001) > 0.7) findings.push({ severity: "warn", area: "budget", note: `today's spend > 70% of daily cap.` });
    if (outcomeAgg7 && outcomeAgg7.avgQuality !== null && outcomeAgg7.avgQuality < 0.45) findings.push({ severity: "warn", area: "outcomes", note: `7-day avg outcome quality is ${outcomeAgg7.avgQuality}.` });
    if (channels && channels.sms?.outboundConfigured === false) findings.push({ severity: "info", area: "channels", note: "Twilio outbound not configured." });

    // Stale today-bucket tasks. If a task has been in 'today' >3 days
    // pending, it almost certainly belongs in this_week or someday now.
    const tasks = r.tasks?.list?.({ queue: "user", bucket: "today", status: "pending", limit: 200 }) ?? [];
    const staleCutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const stale = tasks.filter((t) => Date.parse(t.createdAt ?? "") < staleCutoff);
    if (stale.length > 0) {
      findings.push({
        severity: "info",
        area: "tasks",
        note: `${stale.length} task${stale.length === 1 ? "" : "s"} stuck in today >3d — consider moving to this_week or someday.`
      });
    }
    const overdue = (r.tasks?.list?.({ status: "pending", limit: 200 }) ?? [])
      .filter((t) => t.dueDate && Date.parse(t.dueDate) < Date.now() - 24 * 60 * 60 * 1000);
    if (overdue.length > 0) {
      findings.push({
        severity: "warn",
        area: "tasks",
        note: `${overdue.length} task${overdue.length === 1 ? "" : "s"} >1d past dueDate.`
      });
    }

    return {
      at: new Date().toISOString(),
      specialists: { active: active.length, retired: retired.length, dormant: dormant.length, lowQuality: lowQuality.length, total: specialists.length },
      memory: {
        counts: { short: memSnap.short.length, medium: memSnap.medium.length, long: memSnap.long.length },
        saturation: memSaturation,
        principles: memSnap.long.filter((m) => m.kind === "principle").length
      },
      cron: { total: cron.length, enabled: enabledCron.length, upcoming },
      budget,
      outcomes: { last7Days: outcomeAgg7, last30Days: outcomeAgg30 },
      channels,
      mcp,
      findings
    };
  }
}
