import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeJsonAtomic, readJsonFile } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";

// Story 3: closes the "self-improving" loop. Reads the proactive-observer's
// resolved suggestions (accepted / rejected / dismissed) and produces:
//   - a short preference summary string the observer prepends to its
//     system prompt before each pass
//   - category multipliers the pattern-miner can use to weight clusters
//     toward shapes the user has historically accepted
//   - mute preferences (user-set, persisted) the observer obeys absolutely
//
// All file-backed under .openagi/preferences.json so the user can hand-edit
// or delete. Reads are cheap (one JSON load) so the observer can do them on
// every pass without overhead.

const DEFAULT_WINDOW_DAYS = 30;
const MIN_SAMPLES_FOR_SIGNAL = 3;

export class SuggestionFeedback {
  constructor({ runtime, dataDir, windowDays = DEFAULT_WINDOW_DAYS } = {}) {
    this.runtime = runtime;
    this.dataDir = dataDir ?? resolveDataDir();
    this.windowDays = windowDays;
    this.prefsPath = path.join(this.dataDir, "preferences.json");
    ensureDir(path.dirname(this.prefsPath));
  }

  /// Read user-set mute preferences. {muted: ["skill", "automation"], ...}
  readPreferences() {
    return readJsonFile(this.prefsPath, { muted: [] });
  }

  /// Persist a new mute / unmute. Idempotent. Returns the new prefs.
  setMuted(category, muted) {
    const prefs = this.readPreferences();
    const set = new Set(prefs.muted ?? []);
    if (muted) set.add(category); else set.delete(category);
    prefs.muted = [...set];
    writeJsonAtomic(this.prefsPath, prefs);
    return prefs;
  }

  /// Walk every resolved proactive-suggestion in the window and bucket by
  /// category. Returns: { byCategory: { skill: {accepted, rejected, dismissed},
  /// task: {...}, mcp: {...} }, totals: {...}, windowDays }
  computeStats() {
    const list = this.runtime?.proactiveObserver?.list?.({ status: null }) ?? [];
    const cutoff = Date.now() - this.windowDays * 24 * 3600 * 1000;
    const byCategory = {};
    let total = 0;
    for (const s of list) {
      const proposedAt = s.proposedAt ? Date.parse(s.proposedAt) : 0;
      if (proposedAt < cutoff) continue;
      // Only resolved suggestions teach us anything — pending ones aren't
      // votes yet.
      if (!s.status || s.status === "pending") continue;
      const cat = s.category ?? "other";
      if (!byCategory[cat]) byCategory[cat] = { accepted: 0, rejected: 0, dismissed: 0 };
      if (s.status === "accepted") byCategory[cat].accepted += 1;
      else if (s.status === "rejected") byCategory[cat].rejected += 1;
      else if (s.status === "dismissed") byCategory[cat].dismissed += 1;
      total += 1;
    }
    return { byCategory, total, windowDays: this.windowDays };
  }

  /// Compact, human-readable summary the observer's LLM call can use as
  /// guidance. Returns null when there aren't enough samples to teach
  /// anything (avoids over-fitting on the first few interactions).
  preferenceSummary() {
    const stats = this.computeStats();
    if (stats.total < MIN_SAMPLES_FOR_SIGNAL) return null;
    const lines = [];
    for (const [cat, counts] of Object.entries(stats.byCategory)) {
      const seen = counts.accepted + counts.rejected + counts.dismissed;
      if (seen < MIN_SAMPLES_FOR_SIGNAL) continue;
      const acceptRate = counts.accepted / seen;
      const verdict = acceptRate >= 0.6
        ? "high signal — propose more"
        : acceptRate <= 0.3
          ? "low signal — propose only when strongly indicated"
          : "mixed";
      lines.push(`- ${cat}: ${counts.accepted}/${seen} accepted (${verdict})`);
    }
    if (lines.length === 0) return null;
    const prefs = this.readPreferences();
    const mutedNote = (prefs.muted ?? []).length > 0
      ? `\nUser has muted these categories — do NOT propose them: ${prefs.muted.join(", ")}.`
      : "";
    return [
      `Recent preference signal (last ${stats.windowDays} days, n=${stats.total}):`,
      ...lines,
      "Prefer proposing categories with higher accept-rate when the activity could plausibly fit multiple shapes." + mutedNote
    ].join("\n");
  }

  /// Multipliers (0..2) per category that the pattern-miner can apply to
  /// cluster scores. 1.0 = neutral. Higher = boost; lower = dampen.
  categoryMultipliers() {
    const stats = this.computeStats();
    const out = {};
    for (const [cat, counts] of Object.entries(stats.byCategory)) {
      const seen = counts.accepted + counts.rejected + counts.dismissed;
      if (seen < MIN_SAMPLES_FOR_SIGNAL) { out[cat] = 1.0; continue; }
      const acceptRate = counts.accepted / seen;
      // Map [0.0, 1.0] accept-rate to [0.4, 1.6] multiplier with a soft
      // floor so we don't completely erase categories.
      out[cat] = Math.max(0.4, Math.min(1.6, 0.4 + acceptRate * 1.2));
    }
    // Hard-zero muted categories.
    const prefs = this.readPreferences();
    for (const muted of prefs.muted ?? []) out[muted] = 0;
    return out;
  }

  /// True when the user has explicitly muted this category — observer
  /// can check this BEFORE asking the LLM (no need to spend a turn on
  /// something we'll discard).
  isMuted(category) {
    const prefs = this.readPreferences();
    return (prefs.muted ?? []).includes(category);
  }
}
