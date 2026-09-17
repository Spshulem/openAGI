// D5 — Introspector. On-demand structural audit of the runtime: specialist
// tree health, memory tier saturation, schedule load, budget burn, channel
// readiness. Surfaced via GET /audit (the Health dashboard tab) and the
// get_audit agent tool (tool-registry.js). Nothing schedules it: no cron
// job runs the audit, and the weekly harsh-review prompt does not
// reference it.

export class Introspector {
  constructor(options = {}) {
    this.runtime = options.runtime;
  }

  audit() {
    const r = this.runtime;
    const now = Date.now();
    const specialists = r.propagation?.list?.({ includeRetired: true }) ?? [];
    const active = specialists.filter((s) => s.status !== "retired");
    const retired = specialists.filter((s) => s.status === "retired");
    const dormant = active.filter((s) => {
      const last = s.lastActivatedAt ? new Date(s.lastActivatedAt).getTime() : 0;
      return now - last > 14 * 86400 * 1000;
    });
    const lowQuality = active.filter((s) => (s.outcomeSamples ?? 0) >= 5 && (s.meanOutcomeQuality ?? 1) < 0.4);

    const memSnap = r.memory.snapshot();
    const memLimits = r.memory.limits ?? { short: 100, medium: 500, long: 1000 };
    const memSaturation = {
      short: memSnap.short.length / memLimits.short,
      medium: memSnap.medium.length / memLimits.medium,
      long: memSnap.long.length / memLimits.long
    };
    const memQuality = r.memory.qualityStats?.() ?? null;

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
    const observations = observationFreshness(r.observations, now);

    const findings = [];
    if (memSaturation.short > 0.85) findings.push({ severity: "warn", area: "memory", note: "short tier > 85% — older items will start dropping." });
    if (memSaturation.medium > 0.85) findings.push({ severity: "warn", area: "memory", note: "medium tier > 85% — fresh working memories are under eviction pressure." });
    if (memSaturation.long > 0.85) findings.push({ severity: "warn", area: "memory", note: "long tier > 85% — consider raising limit or curating principles." });
    if (memQuality?.active >= 50 && memQuality.recallCoverage < 0.2) {
      findings.push({ severity: "info", area: "memory", note: `Only ${Math.round(memQuality.recallCoverage * 100)}% of active memories have been recalled — improve retrieval or retire low-value rows.` });
    }
    if (memQuality?.duplicateRows > 0) {
      findings.push({ severity: "warn", area: "memory", note: `${memQuality.duplicateRows} exact duplicate memory row(s) remain active.` });
    }
    if (dormant.length > 0) findings.push({ severity: "info", area: "specialists", note: `${dormant.length} specialist(s) dormant >14d — retirement-sweep will handle at 30d.` });
    if (lowQuality.length > 0) findings.push({ severity: "warn", area: "specialists", note: `${lowQuality.length} specialist(s) under-performing (<0.4 mean quality).` });
    if (budget && budget.spentUsd / Math.max(budget.dailyUsdLimit, 0.0001) > 0.7) findings.push({ severity: "warn", area: "budget", note: `today's spend > 70% of daily cap.` });
    if (outcomeAgg7 && outcomeAgg7.avgQuality !== null && outcomeAgg7.avgQuality < 0.45) findings.push({ severity: "warn", area: "outcomes", note: `7-day avg outcome quality is ${outcomeAgg7.avgQuality}.` });
    if (outcomeAgg30?.resolved >= 50 && (outcomeAgg30.userSignalCoverage ?? 0) < 0.05) {
      findings.push({
        severity: "info",
        area: "outcomes",
        note: `Only ${Math.round((outcomeAgg30.userSignalCoverage ?? 0) * 100)}% of recent outcomes have user feedback — quality scores are mostly inferred until rating/follow-up hooks are used.`
      });
    }
    if (observations?.latestAgeMinutes != null && observations.latestAgeMinutes > 30) {
      findings.push({ severity: "warn", area: "observations", note: `latest screen/activity observation is ${formatAge(observations.latestAgeMinutes)} old — capture may be paused, permission-blocked, or pointed at another daemon.` });
    } else if (observations && observations.latestAt === null) {
      findings.push({ severity: "info", area: "observations", note: "no screen/activity observations have been recorded yet." });
    }

    // Stale today-bucket tasks. If a task has been in 'today' >3 days
    // pending, it almost certainly belongs in this_week or someday now.
    const tasks = r.tasks?.list?.({ queue: "user", bucket: "today", status: "pending", limit: 200 }) ?? [];
    const staleCutoff = now - 3 * 24 * 60 * 60 * 1000;
    const stale = tasks.filter((t) => Date.parse(t.createdAt ?? "") < staleCutoff);
    if (stale.length > 0) {
      findings.push({
        severity: "info",
        area: "tasks",
        note: `${stale.length} task${stale.length === 1 ? "" : "s"} stuck in today >3d — consider moving to this_week or someday.`
      });
    }
    const overdue = (r.tasks?.list?.({ status: "pending", limit: 200 }) ?? [])
      .filter((t) => t.dueDate && Date.parse(t.dueDate) < now - 24 * 60 * 60 * 1000);
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
        principles: memSnap.long.filter((m) => m.kind === "principle" && !m.metadata?.supersededBy).length,
        quality: memQuality
      },
      cron: { total: cron.length, enabled: enabledCron.length, upcoming },
      budget,
      outcomes: { last7Days: outcomeAgg7, last30Days: outcomeAgg30 },
      observations,
      channels,
      mcp,
      findings
    };
  }
}

function observationFreshness(observations, now) {
  const db = observations?.db;
  if (!db?.prepare) return null;
  try {
    const row = db.prepare(`
      SELECT MAX(at) AS latestAt FROM (
        SELECT MAX(at) AS at FROM activity
        UNION ALL
        SELECT MAX(captured_at) AS at FROM frames
      )
    `).get();
    const latestAt = typeof row?.latestAt === "string" && row.latestAt ? row.latestAt : null;
    const latestMs = Date.parse(latestAt ?? "");
    return {
      latestAt,
      latestAgeMinutes: Number.isFinite(latestMs) ? Math.max(0, Math.round((now - latestMs) / 60000)) : null
    };
  } catch {
    return null;
  }
}

function formatAge(minutes) {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
