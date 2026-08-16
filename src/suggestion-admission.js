import fs from "node:fs";
import path from "node:path";
import { readJsonFile } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";

export const DEFAULT_MAX_PENDING_SUGGESTIONS = 100;

function configuredLimit(value = process.env.OPENAGI_MAX_PENDING_SUGGESTIONS) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.trunc(parsed)
    : DEFAULT_MAX_PENDING_SUGGESTIONS;
}

// Admission backpressure, not cleanup: no existing row is changed. Once the
// unread queue reaches a human-reviewable ceiling, producers pause instead of
// spending more model tokens on cards that cannot realistically be seen.
export function suggestionAdmissionStatus({ dataDir, limit } = {}) {
  const root = dataDir ?? resolveDataDir();
  const ceiling = configuredLimit(limit);
  let pending = 0;
  for (const dir of [path.join(root, "proactive", "suggestions"), path.join(root, "skills-suggested")]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const row = readJsonFile(path.join(dir, name), null);
      if (row && (row.status ?? "pending") === "pending") pending += 1;
      if (pending >= ceiling) return { allowed: false, pending, limit: ceiling };
    }
  }
  return { allowed: true, pending, limit: ceiling };
}

// The early admission check avoids unnecessary model work. This second check
// belongs at the synchronous persistence boundary: several async miners can
// all start while the queue is at 99, but JavaScript cannot interleave inside
// this check+write callback, so only the first one is admitted at 100.
export function withSuggestionAdmission({ dataDir, limit, write } = {}) {
  if (typeof write !== "function") throw new Error("withSuggestionAdmission requires a synchronous write callback");
  const admission = suggestionAdmissionStatus({ dataDir, limit });
  if (!admission.allowed) return { ...admission, written: false, value: null };
  return { ...admission, written: true, value: write() };
}
