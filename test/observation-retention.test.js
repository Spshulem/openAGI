// test/observation-retention.test.js
//
// Retention for the ambient-observation store was designed, documented, and
// never wired: observation-store.js has prune(), its file header says "caller
// (autopilot job) prunes old rows by date", and no such job exists. The only
// caller is an HTTP route nobody hits. On the machine this was found on the
// store had reached 1.26 GiB (321,228 pages x 4 KiB, freelist 0) holding
// 227,795 frame-OCR rows / 652 MB of raw text.
//
// These tests pin the three things that were missing:
//   1. a scheduled caller, on a retention cadence (daily, off-peak),
//   2. a prune that reports counts, previews as a dry run, and is idempotent,
//   3. a reclaim that actually shrinks the FILE — a SQLite DELETE only moves
//      pages onto the freelist, so without a merge + vacuum the user sees the
//      same 1.2 GB and reasonably concludes the fix did nothing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObservationStore } from "../src/observation-store.js";
import { createDurableRuntime } from "../src/index.js";
import {
  DEFAULT_FRAME_RETENTION_DAYS,
  DEFAULT_TEXT_RETENTION_DAYS,
  observationStoreFootprint,
  pruneObservations,
  reclaimObservationSpace,
  resolveRetentionPolicy,
  wipeObservations
} from "../src/observation-retention.js";

// The SQLite path is what has the disk-growth problem; skip cleanly on a Node
// without node:sqlite (< 22.5), matching the store's own fallback.
let hasSqlite = true;
try { await import("node:sqlite"); } catch { hasSqlite = false; }

const NOW = new Date("2026-08-04T12:00:00.000Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400 * 1000).toISOString();

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A synthetic store with rows deliberately straddling BOTH cutoffs.
async function seedStore(dir, { padBytes = 0 } = {}) {
  const store = new ObservationStore({ dir });
  const pad = padBytes > 0 ? " " + "lorem ipsum dolor sit amet ".repeat(Math.ceil(padBytes / 27)) : "";
  await store.record([
    // --- frames: cutoff is DEFAULT_FRAME_RETENTION_DAYS (30) ---
    { kind: "frame", frameId: "f-fresh-1", at: daysAgo(1), app: "Safari", window: "Roadmap", ocrText: "keepme fresh roadmap" + pad },
    { kind: "frame", frameId: "f-fresh-29", at: daysAgo(29), app: "Safari", window: "Roadmap", ocrText: "keepme just inside frame cutoff" + pad },
    { kind: "frame", frameId: "f-old-31", at: daysAgo(31), app: "Safari", window: "Roadmap", ocrText: "dropme just outside frame cutoff" + pad },
    { kind: "frame", frameId: "f-old-60", at: daysAgo(60), app: "Safari", window: "Roadmap", ocrText: "dropme long past frame cutoff" + pad },
    // --- activity: cutoff is DEFAULT_TEXT_RETENTION_DAYS (90) ---
    { kind: "activity", at: daysAgo(2), app: "Terminal", window: "keepme recent shell", event: "focus" },
    { kind: "activity", at: daysAgo(45), app: "Terminal", window: "keepme mid shell", event: "focus" },
    { kind: "activity", at: daysAgo(89), app: "Terminal", window: "keepme just inside text cutoff", event: "focus" },
    { kind: "activity", at: daysAgo(91), app: "Terminal", window: "dropme just outside text cutoff", event: "focus" },
    { kind: "activity", at: daysAgo(200), app: "Terminal", window: "dropme ancient shell", event: "focus" },
    // --- transcripts: long-form text, also on the 90-day text cutoff ---
    { kind: "transcript", ref: "t-recent", at: daysAgo(10), app: "BuildBetter", text: "keepme recent call transcript" },
    { kind: "transcript", ref: "t-ancient", at: daysAgo(120), app: "BuildBetter", text: "dropme ancient call transcript" }
  ], { sourceMachineId: "mac-A" });
  await store.ready;
  return store;
}

// createDurableRuntime opens several SQLite stores asynchronously (observations
// and sessionIndex both expose a `ready` promise). Deleting the data dir while
// those opens are still in flight throws "unable to open database file" AFTER
// the test has ended, which node:test reports as an unhandledRejection and
// fails the whole FILE even though every assertion passed. Settle them first.
async function settleRuntime(runtime) {
  const pending = [];
  for (const value of Object.values(runtime)) {
    if (value && typeof value === "object" && typeof value.ready?.then === "function") pending.push(value.ready);
  }
  await Promise.allSettled(pending);
}

function counts(store) {
  return {
    activity: store.db.prepare("SELECT COUNT(*) AS n FROM activity").get().n,
    frames: store.db.prepare("SELECT COUNT(*) AS n FROM frames").get().n,
    texts: store.db.prepare("SELECT COUNT(*) AS n FROM texts").get().n
  };
}

test("retention defaults keep everything the deepest consumer still reads", { skip: !hasSqlite }, () => {
  // pattern-miner.js DEFAULT_LOOKBACK_DAYS = 28. A frame-OCR retention below
  // that would silently delete rows the nightly miner is about to read.
  assert.ok(DEFAULT_FRAME_RETENTION_DAYS >= 28, "frame retention must cover the 28-day miner lookback");
  assert.ok(DEFAULT_TEXT_RETENTION_DAYS >= DEFAULT_FRAME_RETENTION_DAYS);
  const policy = resolveRetentionPolicy({});
  assert.equal(policy.frameRetentionDays, DEFAULT_FRAME_RETENTION_DAYS);
  assert.equal(policy.textRetentionDays, DEFAULT_TEXT_RETENTION_DAYS);
  // Env-tunable, and refuses nonsense rather than silently deleting everything.
  assert.equal(resolveRetentionPolicy({ OPENAGI_OBSERVATION_FRAME_RETENTION_DAYS: "45" }).frameRetentionDays, 45);
  assert.equal(resolveRetentionPolicy({ OPENAGI_OBSERVATION_FRAME_RETENTION_DAYS: "0" }).frameRetentionDays, DEFAULT_FRAME_RETENTION_DAYS);
  assert.equal(resolveRetentionPolicy({ OPENAGI_OBSERVATION_FRAME_RETENTION_DAYS: "-5" }).frameRetentionDays, DEFAULT_FRAME_RETENTION_DAYS);
  assert.equal(resolveRetentionPolicy({ OPENAGI_OBSERVATION_TEXT_RETENTION_DAYS: "abc" }).textRetentionDays, DEFAULT_TEXT_RETENTION_DAYS);
});

test("dry run reports what WOULD be deleted and touches nothing", { skip: !hasSqlite }, async () => {
  const dir = tempDir("obs-dryrun-");
  const store = await seedStore(dir);
  const before = counts(store);

  const preview = await pruneObservations(store, { dryRun: true, now: NOW });

  assert.equal(preview.dryRun, true);
  assert.equal(preview.applied, false);
  assert.equal(preview.deleted.frames, 2, "f-old-31 + f-old-60");
  assert.equal(preview.deleted.activity, 2, "the 91d + 200d activity rows");
  // 5, not 4: record() inserts one texts row per activity row that has a
  // window, so BOTH out-of-window activity rows (91d, 200d) contribute a title.
  // 2 frame OCR + 2 activity titles + 1 transcript. The seed puts exactly 5
  // "dropme" rows in `texts` and the assertion below requires all 5 to go, so
  // the old expectation of 4 contradicted the rest of this file.
  assert.equal(preview.deleted.texts, 5, "2 frame OCR + 2 activity titles + 1 transcript");
  assert.equal(preview.cutoffs.frames, daysAgo(DEFAULT_FRAME_RETENTION_DAYS));
  assert.equal(preview.cutoffs.text, daysAgo(DEFAULT_TEXT_RETENTION_DAYS));
  assert.deepEqual(counts(store), before, "a dry run must not delete a single row");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("prune deletes exactly the rows outside the cutoffs and reports counts", { skip: !hasSqlite }, async () => {
  const dir = tempDir("obs-prune-");
  const store = await seedStore(dir);

  const logged = [];
  const result = await pruneObservations(store, { now: NOW, logger: (line) => logged.push(line) });

  assert.equal(result.applied, true);
  assert.equal(result.deleted.frames, 2);
  assert.equal(result.deleted.activity, 2);
  assert.equal(result.deleted.texts, 5);

  const frameUids = store.db.prepare("SELECT frame_uid FROM frames ORDER BY frame_uid").all().map((r) => r.frame_uid);
  assert.deepEqual(frameUids, ["f-fresh-1", "f-fresh-29"], "only frames inside the 30-day cutoff survive");

  const windows = store.db.prepare("SELECT window FROM activity ORDER BY at").all().map((r) => r.window);
  assert.deepEqual(windows, ["keepme just inside text cutoff", "keepme mid shell", "keepme recent shell"]);

  const remaining = store.db.prepare("SELECT kind, ref, text FROM texts").all();
  assert.equal(remaining.filter((r) => /dropme/.test(r.text)).length, 0, "no row past its cutoff survived");
  assert.ok(remaining.some((r) => r.kind === "transcript" && r.ref === "t-recent"), "in-window transcript kept");
  assert.ok(!remaining.some((r) => r.ref === "t-ancient"), "out-of-window transcript dropped");
  // The searchable index must agree with the tables, not just the row counts.
  const hits = await store.search({ query: "dropme", limit: 50 });
  assert.equal(hits.length, 0, "FTS must not still return deleted text");

  assert.ok(
    logged.some((l) => /observation prune/.test(l) && /frames=2/.test(l) && /activity=2/.test(l) && /texts=5/.test(l)),
    `deletion must be logged with counts; got ${JSON.stringify(logged)}`
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test("prune is idempotent — a second pass deletes nothing", { skip: !hasSqlite }, async () => {
  const dir = tempDir("obs-idem-");
  const store = await seedStore(dir);
  await pruneObservations(store, { now: NOW });
  const afterFirst = counts(store);

  const second = await pruneObservations(store, { now: NOW });
  assert.equal(second.deleted.frames, 0);
  assert.equal(second.deleted.activity, 0);
  assert.equal(second.deleted.texts, 0);
  assert.deepEqual(counts(store), afterFirst);

  const third = await pruneObservations(store, { dryRun: true, now: NOW });
  assert.equal(third.deleted.texts, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("reclaim actually shrinks the file on disk, and converts to incremental vacuum", { skip: !hasSqlite }, async () => {
  const dir = tempDir("obs-reclaim-");
  // ~24 MB of OCR text so the delete leaves a freelist worth vacuuming.
  const store = await seedStore(dir, { padBytes: 3_000_000 });
  const bulk = [];
  for (let i = 0; i < 40; i += 1) {
    bulk.push({
      kind: "frame",
      frameId: `bulk-${i}`,
      at: daysAgo(31 + (i % 30)),
      app: "Safari",
      window: `Bulk ${i}`,
      ocrText: `dropme bulk ${i} ` + "the quick brown fox jumps over the lazy dog ".repeat(12_000)
    });
  }
  await store.record(bulk, { sourceMachineId: "mac-A" });

  const beforeBytes = fs.statSync(store.dbPath).size;
  const beforeFootprint = observationStoreFootprint(store);
  assert.equal(beforeFootprint.autoVacuum, 0, "a legacy store starts with auto_vacuum = NONE");

  const pruned = await pruneObservations(store, { now: NOW, reclaim: "none" });
  assert.ok(pruned.deleted.frames >= 42);
  const afterDeleteBytes = fs.statSync(store.dbPath).size;

  const reclaimed = await reclaimObservationSpace(store, { mode: "full", minFreeBytes: 0, minFreeRatio: 0 });
  const afterBytes = fs.statSync(store.dbPath).size;

  console.log(
    `[reclaim] before=${beforeBytes}B  after DELETE (no vacuum)=${afterDeleteBytes}B  after reclaim=${afterBytes}B`
  );

  assert.ok(
    afterDeleteBytes >= beforeBytes * 0.95,
    `DELETE alone must NOT shrink the file — that is the whole trap. before=${beforeBytes} afterDelete=${afterDeleteBytes}`
  );
  assert.ok(
    afterBytes < beforeBytes * 0.6,
    `reclaim must return the pages to the filesystem. before=${beforeBytes} after=${afterBytes}`
  );
  assert.equal(reclaimed.applied, true);
  assert.equal(reclaimed.bytesBefore, afterDeleteBytes);
  assert.equal(reclaimed.bytesAfter, afterBytes);

  // After the one-time conversion the store is in INCREMENTAL mode, so every
  // later reclaim is a bounded PRAGMA incremental_vacuum(N) — never another
  // whole-file rewrite that a job timeout could interrupt.
  assert.equal(observationStoreFootprint(store).autoVacuum, 2);
  const second = await reclaimObservationSpace(store, { mode: "auto" });
  assert.equal(second.strategy, "incremental-vacuum");
  assert.ok(fs.statSync(store.dbPath).size <= afterBytes);

  // The data that was inside the cutoffs is still searchable afterwards.
  const keep = await store.search({ query: "keepme", limit: 50 });
  assert.ok(keep.length > 0, "reclaim must not damage the surviving index");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("reclaim refuses a whole-file vacuum when there is nothing worth reclaiming", { skip: !hasSqlite }, async () => {
  const dir = tempDir("obs-noreclaim-");
  const store = await seedStore(dir);
  const bytesBefore = fs.statSync(store.dbPath).size;

  const res = await reclaimObservationSpace(store, { mode: "auto" });
  assert.equal(res.applied, false);
  assert.match(res.reason, /below the reclaim threshold|no free pages/i);
  assert.equal(fs.statSync(store.dbPath).size, bytesBefore);
  assert.equal(observationStoreFootprint(store).autoVacuum, 0, "a no-op pass must not convert the file either");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("reclaim refuses a whole-file vacuum without headroom on disk", { skip: !hasSqlite }, async () => {
  const dir = tempDir("obs-nodisk-");
  const store = await seedStore(dir, { padBytes: 200_000 });
  await pruneObservations(store, { now: NOW, reclaim: "none" });
  const bytesBefore = fs.statSync(store.dbPath).size;

  // VACUUM writes a full second copy before swapping. Pretend the volume is
  // nearly full; the honest answer is to skip and say why, not to try it.
  const res = await reclaimObservationSpace(store, {
    mode: "full",
    minFreeBytes: 0,
    minFreeRatio: 0,
    freeDiskBytes: () => 1024
  });
  assert.equal(res.applied, false);
  assert.match(res.reason, /disk/i);
  assert.equal(fs.statSync(store.dbPath).size, bytesBefore);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("wipe removes every captured row and gives the disk back", { skip: !hasSqlite }, async () => {
  const dir = tempDir("obs-wipe-");
  const store = await seedStore(dir, { padBytes: 2_000_000 });
  const bytesBefore = fs.statSync(store.dbPath).size;
  assert.ok(bytesBefore > 1_000_000, "premise: there is something to reclaim");

  const logged = [];
  const res = await wipeObservations(store, { logger: (l) => logged.push(l) });
  const bytesAfter = fs.statSync(store.dbPath).size;
  console.log(`[wipe] before=${bytesBefore}B  after=${bytesAfter}B`);

  assert.deepEqual(counts(store), { activity: 0, frames: 0, texts: 0 });
  assert.equal(res.deleted.frames, 4);
  assert.equal(res.deleted.activity, 5);
  // 11 = 4 frame OCR + 5 activity titles + 2 transcripts. Every seeded row
  // except the frame/activity rows themselves lands in `texts`.
  assert.equal(res.deleted.texts, 11);
  assert.ok(bytesAfter < bytesBefore / 4, `wipe must shrink the file: ${bytesBefore} -> ${bytesAfter}`);
  assert.equal(res.bytesAfter, bytesAfter);
  assert.ok(logged.some((l) => /observation wipe/.test(l)));

  const hits = await store.search({ query: "keepme", limit: 50 });
  assert.equal(hits.length, 0, "nothing survives a wipe");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("the JSONL fallback store reports honestly instead of pretending to prune", { skip: !hasSqlite }, async () => {
  const dir = tempDir("obs-fallback-");
  const store = new ObservationStore({ dir });
  await store.ready;
  store.fallback = true;
  store.db = null;
  const res = await pruneObservations(store, { now: NOW });
  assert.equal(res.applied, false);
  assert.equal(res.mode, "fallback-jsonl");
  assert.match(res.reason, /fallback/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The actual bug: nothing ever called prune().
// ---------------------------------------------------------------------------

test("the runtime registers a daily off-peak observation-retention job", { skip: !hasSqlite }, async () => {
  const dataDir = tempDir("obs-cron-");
  const runtime = createDurableRuntime({ dataDir, autoConnectMcp: false });
  const job = runtime.cron.listJobs().find((j) => j.id === "observation-retention");

  assert.ok(job, "no scheduled caller for observation retention — the store grows without bound");
  assert.equal(job.enabled, true);
  assert.equal(job.task, "observation-retention");
  assert.ok(job.dailyAt, "retention housekeeping is a daily cadence, not an interval pulse");
  const [hour] = job.dailyAt.split(":").map(Number);
  assert.ok(hour >= 1 && hour <= 6, `expected an off-peak hour, got ${job.dailyAt}`);

  // Must not share a tick with any other scheduled job.
  const clashes = runtime.cron.listJobs().filter((j) => j.id !== job.id && j.dailyAt === job.dailyAt);
  assert.deepEqual(clashes.map((j) => j.id), [], `observation-retention shares ${job.dailyAt} with another job`);

  await settleRuntime(runtime);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("the scheduled job actually prunes when it fires", { skip: !hasSqlite }, async () => {
  const dataDir = tempDir("obs-cronrun-");
  const observations = await seedStore(path.join(dataDir, "observations"));
  const runtime = createDurableRuntime({ dataDir, autoConnectMcp: false, observations });

  runtime.cron.updateJob("observation-retention", { nextRunAt: new Date(NOW.getTime() - 1000).toISOString() });
  for (const j of runtime.cron.listJobs()) {
    if (j.id !== "observation-retention") runtime.cron.enableJob(j.id, false);
  }

  const results = await runtime._tickOnce(NOW);
  const fired = results.find((r) => r.job.id === "observation-retention");
  assert.ok(fired, "the tick dispatcher has no handler for the observation-retention task");
  assert.equal(fired.result.applied, true);
  assert.equal(fired.result.deleted.frames, 2);
  assert.equal(counts(observations).frames, 2);

  await settleRuntime(runtime);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
