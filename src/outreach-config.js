// src/outreach-config.js
import path from "node:path";
import { readJsonFile } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";

export const OUTREACH_DEFAULTS = {
  enabled: true,
  destination: "mac",
  cadenceHours: 3,
  quietHours: { start: "22:00", end: "08:00" },
  stalledDays: 3,
  liveTypes: ["stalled-task", "pending-action", "clarification"],
  digestTypes: ["draft", "suggestion"]
};

function minutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map((n) => parseInt(n, 10));
  return (h % 24) * 60 + (m || 0);
}

// File overrides defaults; env overrides file. Returns a config plus an
// inQuietHours(date) helper that correctly handles an overnight window.
export function normalizeOutreachConfig(fileCfg = {}, env = process.env) {
  const merged = { ...OUTREACH_DEFAULTS, ...fileCfg };
  merged.quietHours = { ...OUTREACH_DEFAULTS.quietHours, ...(fileCfg.quietHours ?? {}) };
  if (env.OPENAGI_OUTREACH_CADENCE_HOURS) merged.cadenceHours = Number(env.OPENAGI_OUTREACH_CADENCE_HOURS);
  if (env.OPENAGI_OUTREACH_STALLED_DAYS) merged.stalledDays = Number(env.OPENAGI_OUTREACH_STALLED_DAYS);
  if (env.OPENAGI_OUTREACH_DISABLED === "1") merged.enabled = false;

  merged.inQuietHours = (date = new Date()) => {
    const now = date.getHours() * 60 + date.getMinutes();
    const start = minutes(merged.quietHours.start);
    const end = minutes(merged.quietHours.end);
    return start <= end ? (now >= start && now < end) : (now >= start || now < end);
  };
  return merged;
}

export function loadOutreachConfig(dataDir = resolveDataDir(), env = process.env) {
  const file = readJsonFile(path.join(dataDir, "outreach.json"), {});
  return normalizeOutreachConfig(file, env);
}
