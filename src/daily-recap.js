// "What did I get done today?" — the synthesizer the system was missing.
// Pulls completed tasks, skill runs, agent actions, activity stats,
// suggestion themes, and unblocked work from their respective stores,
// produces both a structured JSON shape (for tools) and a markdown
// rendering (for chat replies + memory writes).
//
// Story 7: the user-visible recap. Stories 8-12 each enrich a section
// of the output — goals, dependencies, retros — but this module ships
// useful on its own with what we already have.

const HOURS_DECIMAL_PLACES = 1;

/// Build the recap. `date` is a Date object identifying which day to
/// summarize; defaults to "now". Timezone defaults to the system's
/// local zone (so "today" matches the user's wall clock).
export function computeDailyRecap(runtime, { date = new Date(), timezone } = {}) {
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { startISO, endISO, label } = localDayBounds(date, tz);

  const completedTasks = pullCompletedTasks(runtime, startISO, endISO);
  const skillRuns = pullSkillRuns(runtime, startISO, endISO);
  const approvedActions = pullApprovedActions(runtime, startISO, endISO);
  const computerActions = pullComputerActions(runtime, startISO, endISO);
  const activity = pullActivity(runtime, startISO, endISO);
  const themes = pullThemes(runtime, startISO, endISO);
  const sessions = pullSessions(runtime, startISO, endISO);
  const unblocked = pullUnblocked(runtime, startISO, endISO);

  // Story 11: bucket completed tasks by parent goal so the recap can
  // say "you moved 4 tasks forward on OpenAGI v0.2 today" instead of
  // listing them flat. tasksByGoal: { goalId: {goal, tasks[]} | "_unassigned"}
  const tasksByGoal = groupCompletedByGoal(runtime, completedTasks);
  return {
    date: label,
    dateISO: startISO.slice(0, 10),
    timezone: tz,
    range: { from: startISO, to: endISO },
    completedTasks,
    tasksByGoal,
    skillRuns,
    approvedActions,
    computerActions,
    activity,
    themes,
    sessions,
    unblocked,
    counts: {
      completedTasks: completedTasks.length,
      skillRuns: skillRuns.length,
      approvedActions: approvedActions.length,
      computerActions: computerActions.length,
      sessions: sessions.length
    }
  };
}

/// Markdown rendering for chat / memory / notification. Compact and
/// scannable; sections collapse to nothing when empty rather than
/// printing "0 completed."
export function renderDailyRecapMarkdown(recap) {
  const lines = [`## What you got done — ${recap.date}`];

  const c = recap.counts;
  const headline = [
    c.completedTasks > 0 ? `${c.completedTasks} task${c.completedTasks === 1 ? "" : "s"}` : null,
    c.skillRuns > 0 ? `${c.skillRuns} skill run${c.skillRuns === 1 ? "" : "s"}` : null,
    c.approvedActions > 0 ? `${c.approvedActions} agent action${c.approvedActions === 1 ? "" : "s"} approved` : null,
    recap.activity?.hoursTracked ? `${recap.activity.hoursTracked}h tracked` : null
  ].filter(Boolean).join(" · ");
  if (headline) lines.push("**" + headline + "**");

  if (recap.completedTasks.length > 0) {
    lines.push("\n### ✅ Completed");
    // Story 11: render goal-grouped if any tasks have a parent goal,
    // otherwise fall back to the flat list (less noise for users
    // without goals set up).
    const goalGroups = recap.tasksByGoal ?? {};
    const hasGoalGrouping = Object.keys(goalGroups).some((k) => k !== "_unassigned" && goalGroups[k]?.tasks?.length > 0);
    if (hasGoalGrouping) {
      for (const [goalId, group] of Object.entries(goalGroups)) {
        if (!group?.tasks?.length) continue;
        const heading = goalId === "_unassigned"
          ? "_no goal_"
          : `**${group.goal?.title ?? "(goal)"}**${group.progress ? ` _(${group.progress.percent}%)_` : ""}`;
        lines.push(`\n_${heading}_`);
        for (const t of group.tasks.slice(0, 8)) {
          const queue = t.queue === "agent" ? " _(agent queue)_" : "";
          lines.push(`- ${t.title}${queue}`);
        }
      }
    } else {
      for (const t of recap.completedTasks.slice(0, 10)) {
        const queue = t.queue === "agent" ? " _(agent queue)_" : "";
        lines.push(`- ${t.title}${queue}`);
      }
      if (recap.completedTasks.length > 10) lines.push(`- … and ${recap.completedTasks.length - 10} more`);
    }
  }

  if (recap.skillRuns.length > 0) {
    lines.push("\n### ✨ Skills run");
    for (const s of recap.skillRuns.slice(0, 6)) {
      const q = typeof s.qualityScore === "number" ? ` (quality ${s.qualityScore.toFixed(2)})` : "";
      lines.push(`- ${s.skill}${q}`);
    }
  }

  if (recap.approvedActions.length > 0) {
    lines.push("\n### 🤖 Agent actions");
    for (const a of recap.approvedActions.slice(0, 8)) {
      lines.push(`- ${a.summary || a.toolName}`);
    }
  }

  if (recap.activity?.topApps?.length > 0) {
    lines.push("\n### ⏱ Time");
    lines.push(`Active ${recap.activity.hoursTracked}h. Top apps: ${recap.activity.topApps.slice(0, 5).map((a) => `**${a.app}** (${a.hours}h)`).join(" · ")}.`);
  }

  if (recap.themes?.length > 0) {
    lines.push("\n### 🧵 Themes");
    for (const theme of recap.themes.slice(0, 5)) {
      lines.push(`- ${theme}`);
    }
  }

  if (recap.unblocked.length > 0) {
    lines.push("\n### 🔓 Unblocked");
    for (const u of recap.unblocked.slice(0, 5)) {
      lines.push(`- ${u.title}`);
    }
  }

  if (lines.length === 1) {
    lines.push("\n_Nothing logged today. Completed tasks, skill runs, and approved agent actions all show up here once you start using the system._");
  }

  return lines.join("\n");
}

// ─── source pulls ───────────────────────────────────────────────────

function groupCompletedByGoal(runtime, completedTasks) {
  // Story 11. Buckets keyed by goalId with {goal, tasks[], progress?}.
  // Unassigned tasks land in "_unassigned". When no goals exist at all,
  // returns {} so the caller's hasGoalGrouping check falls through to
  // the flat-list rendering.
  if (!runtime?.tasks?.getGoal) return {};
  const out = {};
  for (const t of completedTasks) {
    const key = t.parentGoalId ?? "_unassigned";
    if (!out[key]) {
      out[key] = { tasks: [] };
      if (key !== "_unassigned") {
        out[key].goal = runtime.tasks.getGoal(key);
        if (runtime.tasks.goalProgress) {
          out[key].progress = runtime.tasks.goalProgress(key);
        }
      }
    }
    out[key].tasks.push(t);
  }
  return out;
}

function pullCompletedTasks(runtime, startISO, endISO) {
  if (!runtime?.tasks?.list) return [];
  const all = runtime.tasks.list({ status: "completed", limit: 500 });
  return all.filter((t) => {
    const at = t.updatedAt ?? t.completedAt ?? t.createdAt ?? null;
    return at && at >= startISO && at < endISO;
  }).map((t) => ({
    id: t.id,
    title: t.title,
    queue: t.queue,
    bucket: t.bucket,
    completedAt: t.updatedAt ?? t.completedAt ?? null,
    completedVia: t.completedVia ?? null,
    parentGoalId: t.parentGoalId ?? null
  }));
}

function pullSkillRuns(runtime, startISO, endISO) {
  if (!runtime?.outcomes?.recent) return [];
  const all = runtime.outcomes.recent(300, "skill-run");
  return all.filter((o) => o.at >= startISO && o.at < endISO).map((o) => ({
    id: o.id,
    skill: o.metadata?.skill ?? o.refId ?? null,
    qualityScore: o.qualityScore,
    sourceSuggestionId: o.metadata?.sourceSuggestionId ?? null,
    at: o.at
  }));
}

function pullApprovedActions(runtime, startISO, endISO) {
  if (!runtime?.pendingActions?.list) return [];
  const all = runtime.pendingActions.list({ status: "approved" });
  return all.filter((a) => {
    const at = a.decidedAt ?? a.createdAt ?? null;
    return at && at >= startISO && at < endISO;
  }).map((a) => ({
    id: a.id,
    toolName: a.toolName,
    summary: a.summary,
    decidedAt: a.decidedAt
  }));
}

function pullComputerActions(runtime, startISO, endISO) {
  if (!runtime?.computerUseLog?.listActions) return [];
  const all = runtime.computerUseLog.listActions({ limit: 500 });
  return all.filter((a) => a.createdAt >= startISO && a.createdAt < endISO).map((a) => ({
    id: a.id,
    kind: a.kind,
    reasoning: a.reasoning,
    at: a.createdAt
  }));
}

function pullActivity(runtime, startISO, endISO) {
  if (!runtime?.observations?.search) return { topApps: [], hoursTracked: 0 };
  // Observations are recorded synchronously by the Mac app via the daemon;
  // calling search() is async but cheap when bounded by date. We tolerate
  // it being async-but-not-awaited here because the recap is computed
  // best-effort — observation search may settle after the JSON returns.
  // For now, return a synchronous slice from in-memory state if available.
  const cached = runtime.observations._recentCache ?? null;
  if (!cached) return { topApps: [], hoursTracked: 0, note: "observation store unavailable for synchronous read" };
  const todayRows = cached.filter((r) => r.at >= startISO && r.at < endISO);
  return summarizeActivity(todayRows);
}

function summarizeActivity(rows) {
  // Group by app, sum focus duration (next-event-time minus this event time).
  const byApp = new Map();
  const sorted = [...rows].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (!r.app) continue;
    const next = sorted[i + 1];
    const start = Date.parse(r.at);
    const end = next ? Date.parse(next.at) : start + 60_000;
    const seconds = Math.min(15 * 60, Math.max(0, Math.floor((end - start) / 1000))); // cap each window at 15min
    byApp.set(r.app, (byApp.get(r.app) || 0) + seconds);
  }
  const topApps = [...byApp.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([app, seconds]) => ({ app, hours: Number((seconds / 3600).toFixed(HOURS_DECIMAL_PLACES)) }));
  const totalSeconds = topApps.reduce((sum, a) => sum + a.hours * 3600, 0);
  return { topApps, hoursTracked: Number((totalSeconds / 3600).toFixed(HOURS_DECIMAL_PLACES)) };
}

function pullThemes(runtime, startISO, endISO) {
  // Themes come from today's resolved+pending proactive suggestions —
  // each title is a one-line "what the observer thought was salient."
  // Mid-horizon observer (Story 10) will add multi-day themes here.
  if (!runtime?.proactiveObserver?.list) return [];
  const all = runtime.proactiveObserver.list({ status: null }) ?? [];
  const today = all.filter((s) => s.proposedAt >= startISO && s.proposedAt < endISO);
  return [...new Set(today.map((s) => s.title).filter(Boolean))].slice(0, 8);
}

function pullSessions(runtime, startISO, endISO) {
  const list = runtime?.agentHost?.store?.listSessions?.() ?? [];
  return list.filter((s) => {
    const at = s.lastActivityAt ?? s.lastMessageAt ?? s.updatedAt ?? null;
    return at && at >= startISO && at < endISO;
  }).map((s) => ({
    id: s.id,
    lastMessage: s.lastMessage ?? null,
    channel: s.channel ?? null,
    lastActivityAt: s.lastActivityAt ?? s.lastMessageAt ?? null
  }));
}

function pullUnblocked(runtime, startISO, endISO) {
  // Story 12 will fill this from a task-unblocked event log. For now an
  // empty array — the section just doesn't render when there's nothing.
  return [];
}

// ─── day boundaries (timezone-aware) ───────────────────────────────────

function localDayBounds(date, tz) {
  // Build start-of-day in the user's timezone, return ISO bounds + a
  // human label like "Tuesday, May 13".
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year").value;
  const month = parts.find((p) => p.type === "month").value;
  const day = parts.find((p) => p.type === "day").value;
  // Start = local midnight; we approximate by parsing the "YYYY-MM-DD"
  // as UTC then adjusting by the zone offset for that moment.
  const startLocal = new Date(`${year}-${month}-${day}T00:00:00`);
  const offsetMin = startLocal.getTimezoneOffset();
  const startUtc = new Date(startLocal.getTime() - offsetMin * 60_000);
  const endUtc = new Date(startUtc.getTime() + 86_400_000);
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "long", month: "long", day: "numeric"
  }).format(startUtc);
  return { startISO: startUtc.toISOString(), endISO: endUtc.toISOString(), label };
}
