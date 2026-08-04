// Retention for the ambient-observation store.
//
// observation-store.js has always carried the line "Retention: caller
// (autopilot job) prunes old rows by date" — and no such caller existed. The
// only thing that ever reached ObservationStore.prune() was an HTTP route
// nobody hits, whose defaults (framesOlderThanDays = 7) would have deleted
// three weeks of frame OCR that the pattern miner still reads. So the store
// grew without bound: on the install this was found on, 1.26 GiB.
//
// This module is the retention policy itself, kept OUT of observation-store.js
// on purpose: the store is a dumb typed accessor over SQLite, and deletion
// policy — cutoffs, dry runs, disk reclamation, refusing to act — is the part
// that needs to be independently testable and independently reviewable before
// it is ever pointed at a user's live capture history.
//
// Three things matter here and each has a test:
//   1. It deletes ONLY rows past their cutoff, and reports exactly what it did.
//   2. It has a dry run, so the counts can be inspected before anything dies.
//   3. It gives the disk back. A SQLite DELETE only moves pages onto the
//      freelist — the file stays 1.2 GB. Without an explicit vacuum the user
//      runs the prune, sees no change in Finder, and reasonably concludes the
//      feature is broken.

import fs from "node:fs";
import path from "node:path";

// Frame OCR is the bulk of the corpus (652 MB of 1.26 GiB on the install this
// was found on) and the least reusable: a screenshot's text is worth a lot for
// a week and almost nothing after a month. Activity titles and transcripts are
// tiny by comparison and carry the long-horizon signal, so they live longer.
//
// The floor on the frame number is NOT arbitrary: pattern-miner.js runs with
// DEFAULT_LOOKBACK_DAYS = 28, so anything below 28 would silently delete rows
// the nightly miner is about to read and quietly degrade skill discovery. 30
// leaves two days of slack for a missed run.
export const DEFAULT_FRAME_RETENTION_DAYS = 30;
export const DEFAULT_TEXT_RETENTION_DAYS = 90;

// Whole-file VACUUM rewrites the database into a fresh file and then swaps it,
// so it needs room for a second copy. Refuse rather than risk filling the
// volume out from under an always-on daemon.
const VACUUM_DISK_HEADROOM = 1.25;
const VACUUM_DISK_SLACK_BYTES = 64 * 1024 * 1024;

// Don't rewrite a multi-gigabyte file to win back a few megabytes. Either
// threshold being met is enough — a small store with a huge proportional hole
// is worth compacting, and so is a big store with a big absolute one.
const DEFAULT_MIN_FREE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MIN_FREE_RATIO = 0.15;

// One incremental_vacuum step reclaims at most this many pages, so a scheduled
// reclaim on an INCREMENTAL store is bounded work that a job timeout can
// interrupt without corrupting anything.
const INCREMENTAL_VACUUM_PAGES = 20_000;

function isoDaysBefore(now, days) {
  return new Date(now.getTime() - days * 86400 * 1000).toISOString();
}

function positiveDays(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  // Anything that isn't a finite positive number falls back to the default.
  // "0" and "-5" MUST NOT be read as "delete everything" — a typo in an env
  // var is not consent to wipe a year of capture history.
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function resolveRetentionPolicy(env = process.env) {
  const source = env ?? {};
  return {
    frameRetentionDays: positiveDays(source.OPENAGI_OBSERVATION_FRAME_RETENTION_DAYS, DEFAULT_FRAME_RETENTION_DAYS),
    textRetentionDays: positiveDays(source.OPENAGI_OBSERVATION_TEXT_RETENTION_DAYS, DEFAULT_TEXT_RETENTION_DAYS)
  };
}

function fileBytes(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function defaultFreeDiskBytes(dir) {
  try {
    const stats = fs.statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    // Unknown free space is not a reason to refuse — it's a reason not to
    // pretend we checked. Returning null makes the caller skip the gate.
    return null;
  }
}

function pragmaNumber(db, name, key) {
  try {
    const row = db.prepare(`PRAGMA ${name}`).get();
    const value = row?.[key ?? name];
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

// A read-only snapshot of what the store costs on disk. Sync, cheap, and safe
// to call from a status route.
export function observationStoreFootprint(store) {
  const dbPath = store?.dbPath ?? null;
  if (!store?.db) {
    return {
      mode: "fallback-jsonl",
      bytes: store?.fallbackPath ? fileBytes(store.fallbackPath) : 0,
      pageCount: null,
      pageSize: null,
      freePages: null,
      freeBytes: null,
      autoVacuum: null
    };
  }
  const pageCount = pragmaNumber(store.db, "page_count");
  const pageSize = pragmaNumber(store.db, "page_size");
  const freePages = pragmaNumber(store.db, "freelist_count");
  return {
    mode: "sqlite",
    bytes: fileBytes(dbPath),
    pageCount,
    pageSize,
    freePages,
    freeBytes: (freePages != null && pageSize != null) ? freePages * pageSize : null,
    // 0 = NONE, 1 = FULL, 2 = INCREMENTAL.
    autoVacuum: pragmaNumber(store.db, "auto_vacuum")
  };
}

function countRows(db, sql, ...params) {
  return db.prepare(sql).get(...params)?.n ?? 0;
}

// Text rows carry their own `at`, and it is the same timestamp as the row they
// describe, so both cutoffs are expressible in one predicate. Frame OCR dies on
// the frame cutoff; activity titles and transcripts die on the text cutoff.
const TEXT_CUTOFF_PREDICATE = "((kind = 'frame' AND at < ?) OR (kind <> 'frame' AND at < ?))";

/**
 * Delete observation rows past their retention cutoff.
 *
 * @param {object} store   an ObservationStore
 * @param {object} options
 *   - dryRun   report what WOULD go, delete nothing
 *   - now      clock injection (Date)
 *   - policy   { frameRetentionDays, textRetentionDays }, else resolved from env
 *   - reclaim  "auto" (default) | "none" | "full" | "incremental"
 *   - logger   fn(line) — deletion is logged with counts, always
 */
export async function pruneObservations(store, options = {}) {
  await store.ready;
  const startedMs = Date.now();
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const policy = options.policy ?? resolveRetentionPolicy(options.env ?? process.env);
  const dryRun = options.dryRun === true;
  const logger = typeof options.logger === "function" ? options.logger : null;
  const cutoffs = {
    frames: isoDaysBefore(now, policy.frameRetentionDays),
    text: isoDaysBefore(now, policy.textRetentionDays)
  };

  // The JSONL fallback (Node < 22.5, no node:sqlite) is an append-only log with
  // no delete path. Say so instead of returning a zero that reads like success.
  if (store.fallback || !store.db) {
    return {
      mode: "fallback-jsonl",
      applied: false,
      dryRun,
      cutoffs,
      policy,
      deleted: { frames: 0, activity: 0, texts: 0 },
      reclaim: null,
      durationMs: Date.now() - startedMs,
      reason: "observation store is on the JSONL fallback (node:sqlite unavailable) — retention is not implemented for it"
    };
  }

  const db = store.db;
  const counted = {
    frames: countRows(db, "SELECT COUNT(*) AS n FROM frames WHERE captured_at < ?", cutoffs.frames),
    activity: countRows(db, "SELECT COUNT(*) AS n FROM activity WHERE at < ?", cutoffs.text),
    texts: countRows(db, `SELECT COUNT(*) AS n FROM texts WHERE ${TEXT_CUTOFF_PREDICATE}`, cutoffs.frames, cutoffs.text)
  };

  if (dryRun) {
    const preview = {
      mode: "sqlite",
      applied: false,
      dryRun: true,
      cutoffs,
      policy,
      deleted: counted,
      reclaim: null,
      durationMs: Date.now() - startedMs,
      footprint: observationStoreFootprint(store)
    };
    logger?.(`observation prune (dry run): frames=${counted.frames} activity=${counted.activity} texts=${counted.texts} cutoffFrames=${cutoffs.frames} cutoffText=${cutoffs.text}`);
    return preview;
  }

  // One transaction: a crash mid-prune must not leave frames deleted with their
  // OCR text still in the FTS index (search would return rows whose frame is
  // gone, which is exactly the "it deleted my data but search still shows it"
  // report that destroys trust in a retention feature).
  let deleted = { frames: 0, activity: 0, texts: 0 };
  db.exec("BEGIN");
  try {
    deleted.frames = db.prepare("DELETE FROM frames WHERE captured_at < ?").run(cutoffs.frames).changes;
    deleted.activity = db.prepare("DELETE FROM activity WHERE at < ?").run(cutoffs.text).changes;
    deleted.texts = db.prepare(`DELETE FROM texts WHERE ${TEXT_CUTOFF_PREDICATE}`).run(cutoffs.frames, cutoffs.text).changes;
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  logger?.(`observation prune: frames=${deleted.frames} activity=${deleted.activity} texts=${deleted.texts} cutoffFrames=${cutoffs.frames} cutoffText=${cutoffs.text}`);

  // VACUUM cannot run inside a transaction, so reclaim is strictly after the
  // COMMIT above. "none" is for tests and for callers that want to schedule the
  // reclaim separately.
  const reclaimMode = options.reclaim ?? "auto";
  let reclaim = null;
  if (reclaimMode !== "none") {
    reclaim = await reclaimObservationSpace(store, {
      mode: reclaimMode,
      logger,
      freeDiskBytes: options.freeDiskBytes
    });
  }

  return {
    mode: "sqlite",
    applied: true,
    dryRun: false,
    cutoffs,
    policy,
    deleted,
    reclaim,
    durationMs: Date.now() - startedMs,
    footprint: observationStoreFootprint(store)
  };
}

/**
 * Return freed pages to the filesystem.
 *
 * mode:
 *   "auto"        pick by the store's auto_vacuum setting (default)
 *   "full"        whole-file VACUUM, and convert the store to INCREMENTAL
 *   "incremental" bounded PRAGMA incremental_vacuum
 *   "none"        no-op
 *
 * Refuses — loudly, with a reason — rather than doing something expensive for
 * no benefit or without the disk headroom to do it safely.
 */
export async function reclaimObservationSpace(store, options = {}) {
  await store.ready;
  const logger = typeof options.logger === "function" ? options.logger : null;
  if (store.fallback || !store.db) {
    return { applied: false, strategy: "none", reason: "observation store is on the JSONL fallback — nothing to vacuum", bytesBefore: 0, bytesAfter: 0 };
  }

  const db = store.db;
  const before = observationStoreFootprint(store);
  const bytesBefore = before.bytes;
  const requested = options.mode ?? "auto";
  if (requested === "none") {
    return { applied: false, strategy: "none", reason: "reclaim disabled by caller", bytesBefore, bytesAfter: bytesBefore };
  }

  // A store already converted to INCREMENTAL never needs another whole-file
  // rewrite: freed pages are reclaimable in bounded steps.
  const strategy = requested === "auto"
    ? (before.autoVacuum === 2 ? "incremental-vacuum" : "full-vacuum")
    : (requested === "incremental" ? "incremental-vacuum" : "full-vacuum");

  const freeBytes = before.freeBytes ?? 0;
  const freeRatio = bytesBefore > 0 ? freeBytes / bytesBefore : 0;
  const minFreeBytes = Number.isFinite(options.minFreeBytes) ? options.minFreeBytes : DEFAULT_MIN_FREE_BYTES;
  const minFreeRatio = Number.isFinite(options.minFreeRatio) ? options.minFreeRatio : DEFAULT_MIN_FREE_RATIO;

  if ((before.freePages ?? 0) <= 0) {
    return { applied: false, strategy, reason: "no free pages to reclaim", bytesBefore, bytesAfter: bytesBefore, freeBytes, footprint: before };
  }
  if (freeBytes < minFreeBytes && freeRatio < minFreeRatio) {
    return {
      applied: false,
      strategy,
      reason: `free space ${freeBytes} bytes (${(freeRatio * 100).toFixed(1)}%) is below the reclaim threshold (${minFreeBytes} bytes or ${(minFreeRatio * 100).toFixed(0)}%)`,
      bytesBefore,
      bytesAfter: bytesBefore,
      freeBytes,
      footprint: before
    };
  }

  if (strategy === "incremental-vacuum") {
    try {
      db.prepare(`PRAGMA incremental_vacuum(${INCREMENTAL_VACUUM_PAGES})`).all();
    } catch (error) {
      return { applied: false, strategy, reason: `incremental_vacuum failed: ${error?.message ?? error}`, bytesBefore, bytesAfter: fileBytes(store.dbPath) };
    }
    const bytesAfter = fileBytes(store.dbPath);
    logger?.(`observation reclaim (incremental): ${bytesBefore} -> ${bytesAfter} bytes`);
    return { applied: true, strategy, bytesBefore, bytesAfter, reclaimedBytes: bytesBefore - bytesAfter, footprint: observationStoreFootprint(store) };
  }

  // Whole-file rewrite. Needs room for a second copy of the database.
  const dir = path.dirname(store.dbPath);
  const probe = typeof options.freeDiskBytes === "function" ? options.freeDiskBytes : () => defaultFreeDiskBytes(dir);
  const available = probe(dir);
  const needed = Math.ceil(bytesBefore * VACUUM_DISK_HEADROOM) + VACUUM_DISK_SLACK_BYTES;
  if (available != null && available < needed) {
    return {
      applied: false,
      strategy,
      reason: `not enough free disk for a whole-file VACUUM: need ~${needed} bytes, ${available} available`,
      bytesBefore,
      bytesAfter: bytesBefore,
      freeBytes,
      footprint: before
    };
  }

  try {
    // Setting auto_vacuum then vacuuming is what converts the file, and the
    // same VACUUM is the one that gives the pages back — one rewrite, both
    // effects. Every later reclaim on this store is then a bounded
    // incremental_vacuum instead of another whole-file rewrite.
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    db.exec("VACUUM");
  } catch (error) {
    return { applied: false, strategy, reason: `VACUUM failed: ${error?.message ?? error}`, bytesBefore, bytesAfter: fileBytes(store.dbPath) };
  }
  const bytesAfter = fileBytes(store.dbPath);
  logger?.(`observation reclaim (full vacuum): ${bytesBefore} -> ${bytesAfter} bytes`);
  return { applied: true, strategy, bytesBefore, bytesAfter, reclaimedBytes: bytesBefore - bytesAfter, footprint: observationStoreFootprint(store) };
}

/**
 * Delete EVERY captured observation and give the disk back. This is the
 * "delete all my capture history" action, not a retention pass: there is no
 * cutoff and no dry run, and the vacuum is unconditional — a user who asked
 * for their screen history to be erased should not be told it's below a
 * threshold worth compacting.
 */
export async function wipeObservations(store, options = {}) {
  await store.ready;
  const logger = typeof options.logger === "function" ? options.logger : null;

  if (store.fallback || !store.db) {
    const bytesBefore = fileBytes(store.fallbackPath);
    try {
      fs.writeFileSync(store.fallbackPath, "", { mode: 0o600 });
    } catch (error) {
      return { applied: false, mode: "fallback-jsonl", reason: `could not truncate the fallback log: ${error?.message ?? error}`, bytesBefore, bytesAfter: fileBytes(store.fallbackPath) };
    }
    logger?.(`observation wipe (fallback jsonl): ${bytesBefore} -> 0 bytes`);
    return { applied: true, mode: "fallback-jsonl", deleted: { frames: 0, activity: 0, texts: 0 }, bytesBefore, bytesAfter: fileBytes(store.fallbackPath) };
  }

  const db = store.db;
  const bytesBefore = fileBytes(store.dbPath);
  const deleted = { frames: 0, activity: 0, texts: 0 };
  db.exec("BEGIN");
  try {
    deleted.frames = db.prepare("DELETE FROM frames").run().changes;
    deleted.activity = db.prepare("DELETE FROM activity").run().changes;
    deleted.texts = db.prepare("DELETE FROM texts").run().changes;
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  let vacuumError = null;
  try {
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    db.exec("VACUUM");
  } catch (error) {
    vacuumError = error?.message ?? String(error);
  }
  const bytesAfter = fileBytes(store.dbPath);
  logger?.(`observation wipe: frames=${deleted.frames} activity=${deleted.activity} texts=${deleted.texts} ${bytesBefore} -> ${bytesAfter} bytes`);
  return {
    applied: true,
    mode: "sqlite",
    deleted,
    bytesBefore,
    bytesAfter,
    vacuumError,
    footprint: observationStoreFootprint(store)
  };
}
