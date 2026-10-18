// Read local metadata only. No model, provider probe, private content, cleanup
// or permission changes. Unavailable collectors remain unknown, never healthy.
export function collectRuntimeProblems(runtime, now) {
  const problems = [];
  const checks = {};
  const read = (name, fn) => {
    try { const value = fn(); checks[name] = value == null ? "unknown" : "measured"; return value; }
    catch { checks[name] = "unknown"; return null; }
  };
  const add = (metric, remedy, problem, nextAction, acceptance, measured) => problems.push({
    id: "runtime:" + metric, metric: "runtime:" + metric, area: "sources", source: "runtime",
    remedy, rootCause: problem, proposedFix: nextAction, nextAction, acceptance,
    confidence: 1, minutesSavedPerDay: 0, eventsPerDay: 1, score: 1,
    evidence: { actionIds: [], feedbackIds: [], measured },
  });
  const configured = read("provider", () => runtime?.agentHost?.modelProvider?.isConfigured?.());
  if (configured === false) add("provider-setup", "setup", "The reply provider is not configured.",
    "Configure a supported provider through setup. Keep credentials out of prompts, skills and issue reports.",
    "An owner-requested provider turn succeeds.", { configured: false });
  const jobs = read("cron", () => runtime?.cron?.listJobs?.());
  if (Array.isArray(jobs)) {
    const failed = jobs.filter(j => j.enabled && j.lastError).length;
    const overdue = jobs.filter(j => j.enabled && j.nextRunAt && Date.parse(j.nextRunAt) < now - 5 * 60_000).length;
    if (failed || overdue) add("cron-attention", "clarification", "Scheduled work has failures or overdue runs; the cause is not established.",
      "Inspect one affected job locally. Is it waiting on credentials, a service, or a reproducible scheduler failure? Do not restart or complete it automatically.",
      "The affected job completes successfully and its next run is fresh.", { failed, overdue });
  }
  const quality = read("memory", () => runtime?.memory?.qualityStats?.());
  const snapshot = read("memoryCapacity", () => runtime?.memory?.snapshot?.());
  const mediumLimit = runtime?.memory?.limits?.medium;
  if (quality?.active >= 50 && quality.recallCoverage < 0.2 && Number.isFinite(mediumLimit) && mediumLimit > 0 && snapshot?.medium?.length >= mediumLimit) {
    add("memory-pressure", "skill", "Working memory is full and most stored memories have not been recalled; this alone does not prove a code defect.",
      "Propose a reusable workflow that retrieves relevant existing context before storing repeated observations. Review its instructions through create_skill; do not delete memories or raise retention limits automatically.",
      "Representative retrieval finds the needed context without adding redundant evidence.", { active: quality.active, recalled: quality.recalled, medium: snapshot.medium.length });
  }
  const budget = read("budget", () => runtime?.budget?.status?.());
  if (Number.isFinite(budget?.dailyUsdLimit) && budget.dailyUsdLimit > 0 && budget.spentUsd >= budget.dailyUsdLimit) {
    add("budget-exhausted", "setup", "The configured daily provider budget is exhausted.",
      "Wait for the budget window to reset, or review the configured limit yourself. A prompt or code repair cannot authorize more spending.",
      "An owner-requested turn succeeds within the configured budget.", { exhausted: true });
  }
  const status = read("imessage", () => runtime?.imessagePoller?.status?.());
  if (status?.enabled && (status.lastError || status.permissionError || status.requiresFullDiskAccess)) add("imessage-read", "setup", "The enabled message reader reports an error; send readiness is unverified.",
    "Inspect local read and relay readiness and required permissions. Do not grant permissions or send a test message automatically.",
    "An authorized read succeeds and relay freshness advances; sending remains separately authorized.", { hasError: true });
  return { checks, problems };
}
