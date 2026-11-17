import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "../file-utils.js";
import { resolveDataDir } from "../data-dir.js";

// Grounded grades of the generalist's work per topic cluster (cluster ids
// come from the optional local scoring service). Kept as daily buckets of
// count and score sum for KEEP_DAYS, read over WINDOW_DAYS. Each graded
// outcome is counted once: a regrade replaces its earlier contribution.
// Holds ids and numbers only. Nothing is read or written until first use.

const DAY_MS = 86_400_000;
export const WINDOW_DAYS = 30;
export const KEEP_DAYS = 35;
const FILE = "cluster-stats.json";

function dayOf(at) {
  const ms = at instanceof Date ? at.getTime() : Date.parse(at ?? "");
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

function emptyState() {
  return { version: 1, clusters: {}, entries: {} };
}

export class ClusterStats {
  constructor({ dir, now = Date.now } = {}) {
    this.dir = dir ?? path.join(resolveDataDir(), "learning");
    this.file = path.join(this.dir, FILE);
    this.now = typeof now === "function" ? now : Date.now;
    this.state = null;
  }

  _load() {
    if (this.state) return this.state;
    const raw = readJsonFile(this.file, null);
    const state = emptyState();
    if (raw && typeof raw === "object") {
      for (const [cluster, days] of Object.entries(raw.clusters ?? {})) {
        if (!days || typeof days !== "object") continue;
        for (const [day, bucket] of Object.entries(days)) {
          const n = Number(bucket?.n);
          const sum = Number(bucket?.sum);
          if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(sum)) continue;
          (state.clusters[cluster] ??= {})[day] = { n, sum };
        }
      }
      for (const [id, entry] of Object.entries(raw.entries ?? {})) {
        if (entry && typeof entry.cluster === "string" && typeof entry.day === "string" && Number.isFinite(entry.score)) {
          state.entries[id] = { cluster: entry.cluster, day: entry.day, score: entry.score };
        }
      }
    }
    this.state = state;
    return state;
  }

  _cutoff(days) {
    return new Date(this.now() - days * DAY_MS).toISOString().slice(0, 10);
  }

  _prune() {
    const state = this._load();
    const cutoff = this._cutoff(KEEP_DAYS);
    for (const [cluster, days] of Object.entries(state.clusters)) {
      for (const day of Object.keys(days)) if (day < cutoff) delete days[day];
      if (Object.keys(days).length === 0) delete state.clusters[cluster];
    }
    for (const [id, entry] of Object.entries(state.entries)) if (entry.day < cutoff) delete state.entries[id];
  }

  _save() {
    this._prune();
    writeJsonAtomic(this.file, this.state);
  }

  _subtract(entry) {
    const bucket = this.state.clusters[entry.cluster]?.[entry.day];
    if (!bucket) return;
    bucket.n -= 1;
    bucket.sum -= entry.score;
    if (bucket.n <= 0) delete this.state.clusters[entry.cluster][entry.day];
  }

  /**
   * Count one grounded score for a cluster on the day of `at`. With an id
   * (the outcome's), a later call for the same id replaces this one.
   */
  record(clusterId, score, at, id = null) {
    if (clusterId === null || clusterId === undefined || !Number.isFinite(score)) return false;
    const day = dayOf(at ?? new Date(this.now()));
    if (!day) return false;
    const state = this._load();
    const cluster = String(clusterId);
    if (id && state.entries[id]) this._subtract(state.entries[id]);
    const days = (state.clusters[cluster] ??= {});
    const bucket = (days[day] ??= { n: 0, sum: 0 });
    bucket.n += 1;
    bucket.sum += score;
    if (id) state.entries[id] = { cluster, day, score };
    this._save();
    return true;
  }

  /** Withdraw an outcome's earlier contribution (its grade no longer counts). */
  remove(id) {
    const state = this._load();
    const entry = id ? state.entries[id] : null;
    if (!entry) return false;
    this._subtract(entry);
    delete state.entries[id];
    this._save();
    return true;
  }

  _sum(filter) {
    const state = this._load();
    const cutoff = this._cutoff(WINDOW_DAYS);
    let n = 0;
    let sum = 0;
    for (const [cluster, days] of Object.entries(state.clusters)) {
      if (!filter(cluster)) continue;
      for (const [day, bucket] of Object.entries(days)) {
        if (day < cutoff) continue;
        n += bucket.n;
        sum += bucket.sum;
      }
    }
    return { n, mean: n > 0 ? sum / n : null };
  }

  /** { n, mean } for one cluster over the last WINDOW_DAYS; mean null when n is 0. */
  stats(clusterId) {
    const cluster = String(clusterId);
    return this._sum((key) => key === cluster);
  }

  /** { n, mean } over every cluster for the last WINDOW_DAYS. */
  overall() {
    return this._sum(() => true);
  }
}
