// Operational metadata only. Callers must never pass bodies, headers, tool
// arguments/results, URLs, or arbitrary remote diagnostics here.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const FIELDS = new Set(["requestId", "durationMs", "method", "route", "status", "reason", "subscribers", "provider", "model", "component", "envKey"]);

export function logOperationalEvent(event, fields = {}, level = "info") {
  const threshold = LEVELS[process.env.OPENAGI_LOG_LEVEL] ?? LEVELS.info;
  if ((LEVELS[level] ?? LEVELS.info) < threshold) return;
  const record = { at: new Date().toISOString(), pid: process.pid, component: "daemon", level, event };
  for (const [key, value] of Object.entries(fields)) {
    if (!FIELDS.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) record[key] = value;
    else if (typeof value === "string" && /^[A-Za-z0-9_./: -]{1,200}$/.test(value)) record[key] = value;
  }
  try { process.stderr.write(`[openagi] ${JSON.stringify(record)}\n`); } catch { /* best-effort */ }
}

export function validRequestId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : null;
}
