import path from "node:path";
import { appendJsonLine, ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

// Outcome → scrutiny weight fitter (B2). For each panel judge, compute the
// correlation between each scrutiny dimension and the outcome qualityScore,
// then propose a small nudge to the dimension's weight.
//
// Bounded by:
//   - minSamples (default 50): no fit unless we have enough resolved outcomes
//   - maxDeltaPerCycle (default 0.05): no weight moves more than ±5% per run
//   - warmupCycles (default 4): proposals are saved to pending-changes for the
//     first N runs and require manual application; after that, auto-apply.
//
// Judge signal (from D3) can be added via addJudgeSignal({judge, deltas, note}):
//   the deltas are averaged with the correlation deltas in the next run.

const DEFAULT_MIN_SAMPLES = 50;
const DEFAULT_MAX_DELTA = 0.05;
const DEFAULT_WARMUP = 4;
const DIMENSIONS = ["environment", "company", "evidence", "memory", "uncertainty"];

export class ScrutinyFitter {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.dir = options.dir ?? path.join(resolveDataDir(), "scrutiny");
    this.statePath = path.join(this.dir, "fitter-state.json");
    this.pendingPath = path.join(this.dir, "pending-changes.json");
    this.weightsPath = path.join(this.dir, "weights.json");
    this.historyPath = path.join(this.dir, "weight-history.jsonl");
    this.minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES;
    this.maxDeltaPerCycle = options.maxDeltaPerCycle ?? DEFAULT_MAX_DELTA;
    this.warmupCycles = options.warmupCycles ?? DEFAULT_WARMUP;
    ensureDir(this.dir);
    this.state = readJsonFile(this.statePath, { version: 1, cycles: 0, lastRunAt: null, judgeSignals: [] });
    this.pending = readJsonFile(this.pendingPath, { version: 1, proposals: [] });
    // Judge weights are constructed from hardcoded defaults every boot;
    // without this restore, every fitted adjustment would silently vanish
    // on daemon restart and calibration could never accumulate.
    this.restoredWeightsAt = this.restoreWeights();
  }

  status() {
    return {
      cycles: this.state.cycles,
      warmupCycles: this.warmupCycles,
      autoApply: this.state.cycles >= this.warmupCycles,
      lastRunAt: this.state.lastRunAt,
      pendingProposals: this.pending.proposals.length,
      pendingJudgeSignals: this.state.judgeSignals.length,
      restoredWeightsAt: this.restoredWeightsAt
    };
  }

  /**
   * Load the last-applied weights from disk into the live judges. Called at
   * construction (after the panel exists on the runtime). Judges present in
   * the file but absent from the panel (or vice versa) are skipped, so an
   * older weights file degrades gracefully. Returns the file's appliedAt
   * timestamp when something was restored, else null.
   */
  restoreWeights() {
    // Never let a corrupt/truncated weights.json (manual edit, partial write,
    // disk error) abort daemon startup — fall back to the in-code defaults.
    try {
      const judges = this.runtime?.scrutiny?.judges;
      if (!judges) return null;
      const saved = readJsonFile(this.weightsPath, null);
      if (!saved || typeof saved !== "object" || !saved.judges || typeof saved.judges !== "object") return null;
      let restored = false;
      for (const [name, weights] of Object.entries(saved.judges)) {
        const judge = judges[name];
        if (!judge || typeof weights !== "object" || weights === null) continue;
        const sane = DIMENSIONS.every((dim) => typeof weights[dim] === "number" && Number.isFinite(weights[dim]));
        if (!sane) continue;
        judge.weights = { ...weights };
        restored = true;
      }
      return restored ? (saved.appliedAt ?? null) : null;
    } catch {
      return null; // malformed → keep default weights, don't crash boot
    }
  }

  /**
   * Apply proposal weights to the live judges AND persist: weights.json so
   * the calibration survives restarts, plus an append-only audit line per
   * judge in weight-history.jsonl ("why did my agent's judgment change").
   */
  _applyAndPersist(proposals, { source, cycle, at = nowIso() } = {}) {
    const judges = this.runtime?.scrutiny?.judges ?? {};
    const applied = {};
    for (const [judgeName, proposal] of Object.entries(proposals)) {
      const judge = judges[judgeName];
      if (!judge) continue;
      judge.weights = { ...proposal.to };
      applied[judgeName] = { ...proposal.to };
      appendJsonLine(this.historyPath, {
        at,
        source,
        cycle,
        judge: judgeName,
        from: proposal.from,
        to: proposal.to
      });
    }
    if (Object.keys(applied).length > 0) {
      writeJsonAtomic(this.weightsPath, { version: 1, appliedAt: at, source, cycle, judges: applied });
    }
    return applied;
  }

  addJudgeSignal({ judge, deltas, note = null, source = "llm-judge" }) {
    if (!judge || !deltas) return null;
    const entry = { judge, deltas, note, source, at: nowIso() };
    this.state.judgeSignals.push(entry);
    this.persistState();
    return entry;
  }

  /**
   * Run a fit cycle. Reads resolved outcomes since the last run, computes
   * proposed deltas per judge per dimension, applies (or stages) them.
   */
  fit({ now = new Date(), windowDays = 8 } = {}) {
    if (!this.runtime?.outcomes) throw new Error("ScrutinyFitter requires runtime.outcomes");
    if (!this.runtime?.scrutiny?.judges) {
      return { skipped: true, reason: "scrutiny is not a panel; nothing to fit" };
    }

    const outcomes = this.runtime.outcomes
      .recent(5000)
      .filter((o) => o.resolved && typeof o.qualityScore === "number" && o.scrutinyDimensions);
    if (outcomes.length < this.minSamples) {
      return { skipped: true, reason: `${outcomes.length} resolved outcomes, need ${this.minSamples}` };
    }

    const proposals = {};
    for (const judgeName of Object.keys(this.runtime.scrutiny.judges)) {
      const judge = this.runtime.scrutiny.judges[judgeName];
      const correlationDeltas = computeCorrelationDeltas(outcomes, this.maxDeltaPerCycle);
      const judgeSignal = aggregateJudgeSignals(this.state.judgeSignals, judgeName, this.maxDeltaPerCycle);
      const merged = mergeDeltas(correlationDeltas, judgeSignal);
      const proposed = applyDeltas(judge.weights, merged, this.maxDeltaPerCycle);
      proposals[judgeName] = { from: { ...judge.weights }, to: proposed, deltas: merged };
    }

    this.state.cycles += 1;
    this.state.lastRunAt = (now instanceof Date ? now : new Date(now)).toISOString();

    const autoApply = this.state.cycles > this.warmupCycles;
    if (autoApply) {
      this._applyAndPersist(proposals, { source: "auto-fit", cycle: this.state.cycles, at: this.state.lastRunAt });
    } else {
      this.pending.proposals.push({
        cycle: this.state.cycles,
        at: this.state.lastRunAt,
        proposals,
        applied: false
      });
      this.persistPending();
    }

    // Drained signals are kept in the audit log but no longer affect future cycles.
    this.state.judgeSignals = [];
    this.persistState();

    return {
      cycle: this.state.cycles,
      autoApplied: autoApply,
      sampleCount: outcomes.length,
      proposals
    };
  }

  /**
   * Manually apply a pending proposal (e.g. via UI/CLI during warmup).
   */
  applyPending(cycle) {
    const entry = this.pending.proposals.find((p) => p.cycle === cycle);
    if (!entry || entry.applied) return null;
    entry.appliedAt = nowIso();
    this._applyAndPersist(entry.proposals, { source: "manual-apply", cycle: entry.cycle, at: entry.appliedAt });
    entry.applied = true;
    this.persistPending();
    return entry;
  }

  persistState() { writeJsonAtomic(this.statePath, this.state); }
  persistPending() { writeJsonAtomic(this.pendingPath, this.pending); }
}

function computeCorrelationDeltas(outcomes, maxDelta) {
  // For each dimension, compute Pearson correlation between dimension value
  // and qualityScore. Nudge proportional to correlation, capped at ±maxDelta.
  const deltas = {};
  for (const dim of DIMENSIONS) {
    const xs = [];
    const ys = [];
    for (const o of outcomes) {
      const x = o.scrutinyDimensions?.[dim];
      const y = o.qualityScore;
      if (typeof x !== "number" || typeof y !== "number") continue;
      xs.push(x);
      ys.push(y);
    }
    if (xs.length < 10) {
      deltas[dim] = 0;
      continue;
    }
    const r = pearson(xs, ys);
    deltas[dim] = clampDelta(r * maxDelta, maxDelta);
  }
  return deltas;
}

function aggregateJudgeSignals(signals, judgeName, maxDelta) {
  const filtered = signals.filter((s) => s.judge === judgeName || s.judge === "all");
  if (filtered.length === 0) return null;
  const avg = {};
  for (const dim of DIMENSIONS) avg[dim] = 0;
  for (const s of filtered) {
    for (const dim of DIMENSIONS) avg[dim] += (s.deltas[dim] ?? 0);
  }
  for (const dim of DIMENSIONS) avg[dim] = clampDelta(avg[dim] / filtered.length, maxDelta);
  return avg;
}

function mergeDeltas(correlationDeltas, judgeSignal) {
  if (!judgeSignal) return correlationDeltas;
  const merged = {};
  for (const dim of DIMENSIONS) {
    merged[dim] = ((correlationDeltas[dim] ?? 0) + (judgeSignal[dim] ?? 0)) / 2;
  }
  return merged;
}

function applyDeltas(weights, deltas, maxDelta) {
  const next = {};
  let total = 0;
  for (const dim of DIMENSIONS) {
    const w = weights[dim] ?? 0;
    const delta = clampDelta(deltas[dim] ?? 0, maxDelta);
    next[dim] = Math.max(0.02, w + delta);
    total += next[dim];
  }
  // Renormalise to keep the weight vector roughly summing to 1.
  if (total > 0) {
    for (const dim of DIMENSIONS) next[dim] = next[dim] / total;
  }
  return next;
}

function clampDelta(value, maxDelta) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-maxDelta, Math.min(maxDelta, value));
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n === 0) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const denom = Math.sqrt(dx) * Math.sqrt(dy);
  return denom === 0 ? 0 : num / denom;
}
