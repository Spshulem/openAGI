import crypto from "node:crypto";

export const MOBILE_SUMMARY_MAX_TASKS = 20;
export const MOBILE_SUMMARY_MAX_ACTIONS = 5;

// A home-screen widget redraws on a budget measured in single-digit seconds
// per hour. Everything it can render is assembled here, once, so a refresh is
// one request and — when nothing moved — one 304 with no body at all.
export function buildMobileSummary(runtime, { now = new Date(), taskLimit = MOBILE_SUMMARY_MAX_TASKS } = {}) {
  const limit = Math.max(1, Math.min(MOBILE_SUMMARY_MAX_TASKS, Number.isFinite(taskLimit) ? taskLimit : MOBILE_SUMMARY_MAX_TASKS));
  const openStatuses = new Set(["pending", "in_progress", "blocked"]);
  const all = runtime.tasks?.list ? runtime.tasks.list({ queue: "user" }) : [];
  const open = all.filter((t) => openStatuses.has(t.status));
  const today = open.filter((t) => t.bucket === "today");
  const nowMs = now.getTime();
  const isOverdue = (t) => Boolean(t.dueDate) && new Date(t.dueDate).getTime() < nowMs;

  const ordered = [...today].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)
    || String(a.createdAt).localeCompare(String(b.createdAt)));

  const actions = (runtime.pendingActions?.list?.({ status: "pending" }) ?? []);

  return {
    generatedAt: now.toISOString(),
    today: ordered.slice(0, limit).map((t) => ({
      id: t.id,
      title: t.title,
      bucket: t.bucket,
      status: t.status,
      priority: t.priority ?? 0,
      dueDate: t.dueDate ?? null,
      overdue: isOverdue(t)
    })),
    counts: {
      today: today.length,
      this_week: open.filter((t) => t.bucket === "this_week").length,
      overdue: open.filter(isOverdue).length,
      pendingActions: actions.length
    },
    pendingActions: actions.slice(0, MOBILE_SUMMARY_MAX_ACTIONS).map((a) => ({
      id: a.id,
      summary: typeof a.summary === "string" && a.summary
        ? a.summary
        : a.toolName ? `Run ${a.toolName}` : "Pending action",
      createdAt: a.createdAt ?? null
    })),
    brief: { headline: headlineFor(today.length, open.filter(isOverdue).length, actions.length) }
  };
}

function headlineFor(todayCount, overdueCount, actionCount) {
  const parts = [];
  parts.push(todayCount === 1 ? "1 thing today" : `${todayCount} things today`);
  if (overdueCount > 0) parts.push(overdueCount === 1 ? "1 overdue" : `${overdueCount} overdue`);
  if (actionCount > 0) parts.push(actionCount === 1 ? "1 waiting on you" : `${actionCount} waiting on you`);
  return parts.join(", ");
}

// generatedAt is deliberately excluded: a daemon where nothing happened must
// keep answering 304, or the ETag buys the widget nothing.
export function summaryETag(payload) {
  const { generatedAt, ...stable } = payload;
  return `"${crypto.createHash("sha256").update(JSON.stringify(stable)).digest("base64url").slice(0, 27)}"`;
}
