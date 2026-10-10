// Storage manager: keeps the Mac's data disk (and the SD card) from filling.
//   safe     regenerable things (git temp files, build output in idle agent
//            worktrees, partial downloads, tool temp): deleted on its own,
//            in Auto only, while a volume is below lowGb, until targetFreeGb.
//   archive  big idle ~/Downloads entries: copied to the SD card, checked,
//            then the original becomes a symlink to the copy (Auto only).
//   ask      old Trash, finished worktrees, old installers: one question per
//            rule, its items pinned in a plan and checked again right before
//            anything is deleted.
// The tick reads cached results only (one statfs); scans run on their own
// timer, one at a time, and every delete or move runs in the background.
// Files: <dataDir>/fleet/storage/{state.json, cache.json, journal.jsonl,
// archive.jsonl}.
// Restore an archived item: rm the symlink, ditto the copy back (see
// docs/setup/fleet-supervisor.md, Storage).

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appendJsonLine, ensureDir, readJsonFile, writeJsonAtomic } from "../file-utils.js";
import { clampText, runCommand, shortHash } from "./contracts.js";
import * as source from "./sources/storage.js";

const fsp = fs.promises;
const { GB, AGES, ASK_RULES, SAFE_RULES, TOMBSTONE_PREFIX } = source;
const MB = 2 ** 20;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const KEEP_MS = 30 * DAY;
const FIRST_SCAN_MS = 60_000;
const POLL_MS = 5 * MIN;
const PLAN_MAX_ITEMS = 200;
const KEY_PREFIX = "infra:storage";
// A pinned item that grew more than this is not the one the owner saw.
const GROWTH = 1.25;
// The open-file, process and thread snapshots are read again before acting
// once older than this.
const FRESH_MS = 30_000;
// An automatic delete or move that failed waits this long (doubling, up to
// MAX_BACKOFF_MS) before it is tried again; one skipped waits SKIP_BACKOFF_MS.
const FAIL_BACKOFF_MS = DAY;
const MAX_BACKOFF_MS = 7 * DAY;
const SKIP_BACKOFF_MS = 6 * 60 * MIN;
// Low yield: the last YIELD_WINDOW deletes of a rule freed (by df) under
// YIELD_MIN_SHARE of their du size. pnpm clones and hard links do that.
const YIELD_WINDOW = 5;
const YIELD_MIN_SHARE = 0.1;
const RULE_HOLD_MS = DAY;
const RM_TIMEOUT_MS = 30 * MIN;
const TARGET_MAX_SHARE = 0.5;

const TITLES = {
  // SD trash counts at any age, so not "Old".
  trash: (n, size) => `Trash: ${n} items, ${size}. Delete?`,
  worktrees: (n, size) => `${n} finished worktrees, ${size}, all pushed. Delete?`,
  installers: (n, size) => `${n} old installers in Downloads, ${size}. Delete?`
};

// Rule -> roots its items must sit inside (checked before any delete).
function ruleRoots(rule, paths) {
  switch (rule) {
    case "partial": return [paths.downloads, paths.sdDownloads];
    case "installers": case "archive": return [paths.downloads];
    case "trash": return [paths.trash, paths.sdTrash];
    case "tool-temp": return [paths.rustupTmp, ...paths.derivedData];
    case "build": case "worktrees": return paths.worktreeRoots.map((root) => root.dir);
    default: return [];
  }
}

export function formatBytes(bytes) {
  const gb = Number(bytes) / GB;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(Number(bytes) / MB))} MB`;
}

function emptyState() {
  return { identity: null, volumes: null, volumesAt: null, plans: {}, holds: {}, backoff: {}, ruleHolds: {}, tombstones: [], copying: [], lastScan: null, lastFreed: null, plannedDigest: null, plannedActionId: null };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function no(reason) {
  return { ok: false, reason };
}

// A question for one rule, with a stable dedupeKey: a new plan updates the
// open question in place; meta pins the plan the owner answers.
function askDecision(rule, { title, body, options, meta, reason }) {
  return {
    threadKey: `${KEY_PREFIX}-${rule}`, state: "infra", action: "ask-user", playbook: null, message: null, blockers: [],
    reason, route: null, notBefore: null, targetKey: null, progressMark: null,
    question: {
      dedupeKey: `${KEY_PREFIX}:${rule}`, kind: "storage", threadKey: null,
      title: clampText(title, 100), body: clampText(body, 220), options: options.map((option) => clampText(option, 40)), meta
    }
  };
}

function itemNames(items) {
  const shown = items.slice(0, 3).map((item) => `${path.basename(item.path)} ${formatBytes(item.bytes)}`);
  return `${shown.join(", ")}${items.length > 3 ? ` +${items.length - 3} more` : ""}`;
}

export function storageKey(rule) {
  return `${KEY_PREFIX}:${rule}`;
}

// "Delete 6 (46 GB)": a card shown for another list cannot answer this one.
export function deleteOption(plan) {
  return `Delete ${plan.items.length} (${formatBytes(plan.bytes)})`;
}

function planTotals(items) {
  return {
    digest: shortHash(items.map((item) => `${item.path}\u0000${item.bytes}`).sort().join("\n")),
    bytes: items.reduce((sum, item) => sum + item.bytes, 0)
  };
}

export class StorageManager {
  // deps: run, statfs, isMount, now (ms clock for ages), clock (budget),
  // readThreadUse, ditto(src, dest) for tests.
  constructor({ config, dir, store = null, deps = {}, getMode = () => "observe", busyCwds = () => [], now = () => Date.now() } = {}) {
    this.config = config;
    this.dir = dir;
    this.store = store;
    this.deps = deps ?? {};
    this.getMode = getMode;
    this.busyCwds = () => { try { return busyCwds() ?? []; } catch { return []; } };
    this.now = typeof this.deps.now === "function" ? this.deps.now : now;
    // Real elapsed time (snapshot age); deps.clock in tests.
    this.clock = typeof this.deps.clock === "function" ? this.deps.clock : Date.now;
    this.statePath = path.join(dir, "state.json");
    this.cachePath = path.join(dir, "cache.json");
    this.journalPath = path.join(dir, "journal.jsonl");
    this.archivePath = path.join(dir, "archive.jsonl");
    this.state = this.load();
    this.cache = null;
    this.candidates = null;
    this.queue = Promise.resolve();
    this.scanPending = null;
    this.scanning = false;
    this.busy = null;
    this.timer = null;
    this.stopped = false;
    this.unknown = false;
    // The SD card is mounted but its reading failed: its asks stay as they
    // are and nothing on it is touched.
    this.sdUnknown = false;
    this.lastWriteError = null;
  }

  get settings() {
    return this.config.storage ?? {};
  }

  get paths() {
    return source.storagePaths(this.config);
  }

  get run() {
    return this.deps.run ?? runCommand;
  }

  // ─── timers ─────────────────────────────────────────────────────────────

  start() {
    if (!this.settings.enabled || this.timer) return false;
    this.stopped = false;
    const poll = (ms) => {
      this.timer = setTimeout(() => {
        Promise.resolve(this.scanDue() ? this.requestScan() : null).catch(() => { /* recorded in lastScan */ })
          .finally(() => { if (!this.stopped) poll(Math.min(POLL_MS, this.settings.scanLowMs ?? POLL_MS)); });
      }, ms);
      this.timer.unref?.();
    };
    poll(FIRST_SCAN_MS);
    return true;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // Hourly; every scanLowMs while a volume is low.
  scanDue(now = this.now()) {
    const last = Date.parse(this.state.lastScan?.at ?? "");
    if (!Number.isFinite(last)) return true;
    const low = this.isLow("data") || this.isLow("sd");
    return now - last >= (low ? this.settings.scanLowMs : this.settings.scanMs);
  }

  // One job at a time: scans, cleanup passes and approved deletes.
  // onStopped: an owner's job dropped by stop() still leaves a record.
  enqueue(fn, onStopped = null) {
    const job = this.queue.then(() => {
      if (!this.stopped) return fn();
      onStopped?.();
      return null;
    });
    this.queue = job.catch(() => {});
    return job;
  }

  // Resolves once every queued job is done (tests, shutdown).
  idle() {
    return this.queue;
  }

  // ─── volumes (every tick) ───────────────────────────────────────────────

  // statfs on both volumes. A failed read throws (the tick records it) and
  // leaves the last reading in place: unknown, not empty.
  async refreshVolumes() {
    let rows;
    try {
      rows = await source.readVolumes(this.config, this.deps, { recordedIdentity: this.state.identity?.uuid ?? null });
    } catch (error) {
      this.unknown = true;
      throw error;
    }
    const data = rows.find((row) => row.id === "data");
    if (!data || data.error || !Number.isFinite(data.freeBytes)) {
      this.unknown = true;
      throw new Error(`storage read failed: ${data?.error ?? "no reading"}`);
    }
    const sd = rows.find((row) => row.id === "sd");
    if (sd?.identity?.ok && sd.identity.uuid && !this.state.identity) this.state.identity = { uuid: sd.identity.uuid, at: iso(this.now()) };
    this.unknown = false;
    // Mounted but unreadable (statfs failed, or no marker and no diskutil
    // answer) is unknown, not "not low": the last good SD row stays for its
    // asks and plans, and sdOk() is false so nothing on it is touched.
    this.sdUnknown = Boolean(sd?.mounted && (sd.error || !sd.identity?.uuid));
    const previousSd = this.volume("sd");
    this.state.volumes = rows.map((row) => (row.id === "sd" && this.sdUnknown && previousSd ? previousSd : {
      id: row.id, mount: row.mount, totalBytes: row.totalBytes, freeBytes: row.freeBytes, mounted: row.mounted,
      identityOk: Boolean(row.identity?.ok), identityDetail: row.identity?.detail ?? null, error: row.error ?? null
    }));
    this.state.volumesAt = iso(this.now());
    this.save();
    return this.state.volumes;
  }

  volume(id) {
    return (this.state.volumes ?? []).find((row) => row.id === id) ?? null;
  }

  // The card is the known one, read just now: safe to act on.
  sdOk() {
    return !this.sdUnknown && this.sdSeenOk();
  }

  // The last good reading said so (asks and plans keep it through a
  // failed read).
  sdSeenOk() {
    const sd = this.volume("sd");
    return Boolean(sd?.mounted && sd.identityOk && !sd.error);
  }

  isLow(id) {
    const row = this.volume(id);
    if (!row || !Number.isFinite(row.freeBytes)) return false;
    if (id === "sd") return this.sdSeenOk() && row.freeBytes < this.settings.sdLowGb * GB;
    return row.freeBytes < this.settings.lowGb * GB;
  }

  isCritical() {
    const row = this.volume("data");
    return Number.isFinite(row?.freeBytes) && row.freeBytes < this.settings.criticalGb * GB;
  }

  async freeBytes(id) {
    try { await this.refreshVolumes(); } catch { return null; }
    const row = this.volume(id);
    if (id === "sd" && !this.sdOk()) return null;
    return Number.isFinite(row?.freeBytes) ? row.freeBytes : null;
  }

  // ─── what the tick asks ─────────────────────────────────────────────────

  // Built from the last reading and the stored plans, every tick, so an
  // open question stays open until its condition is really gone.
  decisions() {
    if (!this.settings.enabled) return [];
    const out = [];
    const data = this.volume("data");
    if (this.isCritical()) {
      out.push(askDecision("critical", {
        title: `Disk almost full: ${formatBytes(data.freeBytes)} left`,
        body: "Clean safe stuff now? Temp files, build output in idle worktrees, old partial downloads. Nothing you made.",
        options: ["Clean safe now", "Later"], meta: { rule: "critical" }, reason: `data volume ${formatBytes(data.freeBytes)} free`
      }));
    }
    for (const rule of ASK_RULES) {
      const plan = this.state.plans?.[rule];
      if (!plan?.items?.length || plan.bytes < (this.settings.askMinGb ?? 1) * GB) continue;
      if (![...new Set(plan.items.map((item) => item.volume))].some((id) => this.isLow(id))) continue;
      const where = [...new Set(plan.items.map((item) => (item.volume === "sd" ? "SD" : "Mac")))].join(" + ");
      out.push(askDecision(rule, {
        title: TITLES[rule](plan.items.length, formatBytes(plan.bytes)),
        body: `${where}: ${itemNames(plan.items)}. Each is checked again before delete.`,
        // The count makes a card for another list unable to answer this one.
        options: [deleteOption(plan), "Keep", "Later"],
        meta: { rule, planId: plan.id, digest: plan.digest }, reason: `${rule}: ${plan.items.length} items, ${formatBytes(plan.bytes)}`
      }));
    }
    return out;
  }

  // Small, for the snapshot (state.json is rewritten every tick).
  summary() {
    const round = (bytes) => (Number.isFinite(bytes) ? Math.round((bytes / GB) * 10) / 10 : null);
    return {
      // low and critical use the live thresholds (env overrides), for the page.
      volumes: (this.state.volumes ?? []).map((row) => ({
        id: row.id, freeGb: round(row.freeBytes), totalGb: round(row.totalBytes), mounted: row.mounted, identityOk: row.identityOk,
        low: this.isLow(row.id), critical: row.id === "data" && this.isCritical()
      })),
      unknown: this.unknown,
      lastScanAt: this.state.lastScan?.at ?? null,
      lastScanOk: this.state.lastScan?.ok ?? null,
      scanning: this.scanning,
      lastFreed: this.state.lastFreed ? { gb: round(this.state.lastFreed.bytes), at: this.state.lastFreed.at, what: this.state.lastFreed.what } : null,
      // Open storage questions (an answered one is held, not pending).
      pendingAsks: this.store ? this.store.openQuestions().filter((question) => question.kind === "storage").length : this.decisions().length
    };
  }

  // ─── scan ───────────────────────────────────────────────────────────────

  // forceSafe: the owner's "Clean safe now": the safe pass runs whatever
  // lowGb says (in any mode: it is the owner's own instruction). It always
  // leaves a Doing line; when it could not run, its question opens again
  // (questionId) instead of staying quiet for a day.
  requestScan({ forceSafe = false, questionId = null } = {}) {
    if (this.scanPending && !forceSafe) return this.scanPending;
    const job = this.enqueue(async () => {
      this.scanning = true;
      try {
        const fresh = this.candidates && this.clock() - (this.scannedAt ?? 0) < (this.settings.scanLowMs ?? 15 * MIN);
        const ok = forceSafe && fresh ? true : await this.scanOnce();
        if (!ok) {
          if (forceSafe) this.ownerNotDone(questionId, "Clean safe now", `scan failed (${this.state.lastScan?.error ?? "unknown"})`);
          return;
        }
        const passes = await this.autoPasses({ force: forceSafe });
        if (forceSafe) this.ownerCleanResult(passes, questionId);
      } finally {
        this.scanning = false;
      }
    }, forceSafe ? () => this.ownerNotDone(questionId, "Clean safe now", "the supervisor stopped first") : null);
    const pending = job.finally(() => { if (this.scanPending === pending) this.scanPending = null; });
    if (!forceSafe) this.scanPending = pending;
    return pending;
  }

  // false when the scan failed: plans stay as they were, nothing is deleted.
  async scanOnce() {
    const at = iso(this.now());
    const cache = this.loadCache();
    let result;
    try {
      result = await source.scanStorage(this.config, { ...this.deps, now: this.now }, { cache, budgetMs: this.settings.scanBudgetMs, busyCwds: this.busyCwds() });
    } catch (error) {
      this.state.lastScan = { at, ok: false, error: clampText(error?.message ?? String(error), 200) };
      this.save();
      return false;
    }
    try { writeJsonAtomic(this.cachePath, cache); } catch (error) { this.lastWriteError = error?.message ?? String(error); }
    this.candidates = result.candidates;
    this.scannedAt = this.clock();
    this.state.lastScan = { at, ok: true, complete: result.complete, durationMs: result.durationMs, errors: result.errors.length, error: result.errors[0] ?? null };
    this.rebuildPlans();
    this.save();
    return true;
  }

  held(p, now = this.now()) {
    return Number(this.state.holds?.[p] ?? 0) > now;
  }

  // The rule's question is open: its plan is what the owner sees.
  asking(rule) {
    return Boolean(this.store?.openQuestions().some((question) => question.dedupeKey === storageKey(rule)));
  }

  // One plan per ask rule from the candidates, minus kept items. An
  // unchanged list keeps its plan id. While its question is open the plan
  // is pinned: it only loses items that are no longer candidates (same id),
  // never gains or swaps any, so a Delete acts on what the owner was shown.
  rebuildPlans() {
    const now = this.now();
    this.state.plans ??= {};
    for (const rule of ASK_RULES) {
      // Through a failed SD read its items stay (each is checked before delete).
      const sdItems = this.sdOk() || (this.sdUnknown && this.sdSeenOk());
      const items = (this.candidates ?? [])
        .filter((item) => item.rule === rule && !this.held(item.path, now) && (item.volume !== "sd" || sdItems))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, PLAN_MAX_ITEMS);
      const current = this.state.plans[rule];
      if (current && this.asking(rule)) {
        const still = new Set(items.map((item) => `${item.path}\u0000${item.dev}\u0000${item.ino}`));
        const kept = current.items.filter((item) => still.has(`${item.path}\u0000${item.dev}\u0000${item.ino}`));
        if (!kept.length) { delete this.state.plans[rule]; continue; }
        if (kept.length === current.items.length) continue;
        this.state.plans[rule] = { ...current, ...planTotals(kept), items: kept };
        continue;
      }
      if (!items.length) { delete this.state.plans[rule]; continue; }
      const totals = planTotals(items);
      if (current?.digest === totals.digest) continue;
      this.state.plans[rule] = {
        id: `${rule}-${totals.digest.slice(0, 8)}`, rule, createdAt: iso(now), ...totals,
        items: items.map(({ rule: itemRule, path: p, bytes, volume, dev, ino, seenAt = null, worktree = null, archived = false }) => ({ rule: itemRule, path: p, bytes, volume, dev, ino, seenAt, worktree, archived }))
      };
    }
  }

  // ─── automatic passes ───────────────────────────────────────────────────

  // [{ volume, done, skipped, failed, freed } or { volume, none: why }].
  async autoPasses({ force = false } = {}) {
    await this.cleanTombstones();
    if (await this.freeBytes("data") === null) return [{ volume: "data", none: "could not read free space", error: true }];
    const dataLow = force || this.isLow("data");
    const sdLow = this.isLow("sd") && this.sdOk();
    if (!dataLow && !sdLow) { this.retirePlanned(); return []; }
    if (!force && this.getMode() !== "auto") { this.recordPlanned(); return []; }
    // Auto acts itself: no "would" line.
    if (!force) this.retirePlanned();
    const out = [];
    if (dataLow) out.push(await this.safePass("data", { force }));
    if (sdLow) out.push(await this.safePass("sd", { force }));
    if (!force && this.isLow("data")) out.push(await this.archivePass());
    return out.filter(Boolean);
  }

  // The owner's Clean safe now always leaves a line in Doing.
  ownerCleanResult(passes, questionId) {
    // A pass that ran wrote its own line (finishPass, force).
    if (passes.some((pass) => !pass.none)) return;
    const failed = passes.find((pass) => pass.error);
    if (failed) { this.ownerNotDone(questionId, "Clean safe now", failed.none); return; }
    this.store?.recordAction({
      kind: "storage", playbook: "storage-safe", threadKey: KEY_PREFIX, status: "done",
      reason: clampText(`owner: clean safe now: nothing safe to delete (${passes.map((pass) => pass.none).filter(Boolean).join("; ") || "no candidates"})`, 300)
    });
  }

  // An owner's instruction that could not run: a failed Doing line, and its
  // question back in front of them.
  ownerNotDone(questionId, answer, why, playbook = "storage-safe") {
    this.store?.recordAction({ kind: "storage", playbook, threadKey: KEY_PREFIX, status: "failed", reason: clampText(`owner: ${answer}: not done, ${why}`, 300) });
    // After the answer is recorded (the supervisor closes the question
    // right after the reply), so the reopen is not overwritten.
    if (questionId) setImmediate(() => { try { this.store?.reopenQuestion(questionId, [], { answer, asked: true }); } catch { /* best-effort */ } });
  }

  // Observe and Propose only say what Auto would do (once per change).
  recordPlanned() {
    const low = ["data", "sd"].filter((id) => this.isLow(id));
    const safe = (this.candidates ?? []).filter((item) => SAFE_RULES.has(item.rule) && low.includes(item.volume));
    const moves = low.includes("data") && this.sdOk() ? (this.candidates ?? []).filter((item) => item.rule === "archive" && !item.installer) : [];
    if (!safe.length && !moves.length) { this.retirePlanned(); return; }
    const digest = shortHash([...safe, ...moves].map((item) => item.path).sort().join("\n"));
    if (digest === this.state.plannedDigest) return;
    this.state.plannedDigest = digest;
    const bytes = (list) => formatBytes(list.reduce((sum, item) => sum + item.bytes, 0));
    // The new line replaces the last one (not a pile of open "planned" rows).
    if (this.state.plannedActionId) { try { this.store?.updateAction(this.state.plannedActionId, { status: "stale" }); } catch { /* gone */ } }
    const action = this.store?.recordAction({
      kind: "storage", playbook: "storage-safe", threadKey: KEY_PREFIX, status: "planned",
      reason: clampText(`Auto would delete ${safe.length} safe items (up to ${bytes(safe)})${moves.length ? ` and move ${moves.length} Downloads items (${bytes(moves)}) to the SD card` : ""}`, 300)
    });
    this.state.plannedActionId = action?.id ?? null;
    this.save();
  }

  // Nothing planned any more (the disk recovered, the items went): the last
  // "would" line is closed instead of staying in Doing.
  retirePlanned() {
    if (!this.state.plannedActionId && !this.state.plannedDigest) return;
    if (this.state.plannedActionId) { try { this.store?.updateAction(this.state.plannedActionId, { status: "stale" }); } catch { /* gone */ } }
    this.state.plannedActionId = null;
    this.state.plannedDigest = null;
    this.save();
  }

  // Opens files, processes, and (lazily) the thread catalogs, fresh. null
  // when the open-file or process read failed: then nothing is touched.
  async verifyContext() {
    try {
      const [open, procs] = await Promise.all([source.readOpenPaths(this.config, this.run), source.readProcessNames(this.config, this.run)]);
      return { open, procs, at: this.clock(), idle: new Map(), use: null, useAt: 0 };
    } catch (error) {
      this.journal({ op: "abort", reason: clampText(error?.message ?? String(error), 160) });
      return null;
    }
  }

  // Reads open files and processes again once the snapshot is older than
  // FRESH_MS (force: always). false when the read failed.
  async refreshContext(ctx, { force = false } = {}) {
    if (!force && this.clock() - ctx.at < FRESH_MS) return true;
    try {
      const [open, procs] = await Promise.all([source.readOpenPaths(this.config, this.run), source.readProcessNames(this.config, this.run)]);
      Object.assign(ctx, { open, procs, at: this.clock() });
      return true;
    } catch {
      return false;
    }
  }

  async threadUse(ctx) {
    if (!ctx.use || this.clock() - ctx.useAt >= FRESH_MS) {
      ctx.use = await source.readThreadUse(this.paths, this.deps).catch(() => ({ ok: false }));
      ctx.useAt = this.clock();
    }
    return ctx.use;
  }

  backedOff(p, now = this.now()) {
    return Number(this.state.backoff?.[p]?.until ?? 0) > now;
  }

  // An automatic delete or move that did not happen is not tried again
  // every pass (a big copy that times out, a du that never finishes).
  noteMiss(p, failed) {
    this.state.backoff ??= {};
    const n = (this.state.backoff[p]?.n ?? 0) + 1;
    const wait = failed ? Math.min(FAIL_BACKOFF_MS * 2 ** (n - 1), MAX_BACKOFF_MS) : SKIP_BACKOFF_MS;
    this.state.backoff[p] = { until: this.now() + wait, n };
  }

  // Free space a pass works toward, never more than TARGET_MAX_SHARE of the
  // volume: a 128 GB disk can never reach a 150 GB target, and a pass would
  // delete everything trying.
  targetBytes(volumeId) {
    const want = (volumeId === "data" ? this.settings.targetFreeGb : this.settings.sdLowGb) * GB;
    const total = this.volume(volumeId)?.totalBytes;
    return Number.isFinite(total) && total > 0 ? Math.min(want, total * TARGET_MAX_SHARE) : want;
  }

  ruleHeld(rule, volumeId, now = this.now()) {
    return Number(this.state.ruleHolds?.[`${rule}:${volumeId}`] ?? 0) > now;
  }

  async safePass(volumeId, { force = false } = {}) {
    const now = this.now();
    const items = (this.candidates ?? [])
      // The owner's Clean safe now tries everything again.
      .filter((item) => SAFE_RULES.has(item.rule) && item.volume === volumeId && (force || (!this.backedOff(item.path, now) && !this.ruleHeld(item.rule, volumeId, now))))
      .sort((a, b) => b.bytes - a.bytes);
    if (!items.length) return { volume: volumeId, none: "no safe candidates" };
    const ctx = await this.verifyContext();
    if (!ctx) return { volume: volumeId, none: "could not read open files", error: true };
    const target = this.targetBytes(volumeId);
    const before = await this.freeBytes(volumeId);
    if (before === null) return { volume: volumeId, none: "could not read free space", error: true };
    const tally = { done: 0, skipped: 0, failed: 0 };
    const removed = new Set();
    // rule -> [{ du, gain }] of its last deletes; lowYield: rules stopped.
    const recent = new Map();
    const lowYield = new Set();
    let free = before;
    for (const item of items) {
      if (this.stopped || (!force && this.getMode() !== "auto")) break;
      if (free === null || free >= target) break;
      if (lowYield.has(item.rule)) continue;
      const { outcome, bytes } = await this.verifyAndRemove(item, ctx, "safe", { requireAuto: !force });
      tally[outcome] += 1;
      if (outcome === "done") removed.add(item.path);
      else if (!force) this.noteMiss(item.path, outcome === "failed");
      const after = await this.freeBytes(volumeId);
      if (outcome === "done" && after !== null && free !== null) {
        const window = [...(recent.get(item.rule) ?? []), { du: bytes, gain: Math.max(0, after - free) }].slice(-YIELD_WINDOW);
        recent.set(item.rule, window);
        const du = window.reduce((sum, row) => sum + row.du, 0);
        const gain = window.reduce((sum, row) => sum + row.gain, 0);
        if (window.length >= YIELD_WINDOW && du >= (this.settings.yieldMinBytes ?? GB) && gain < du * YIELD_MIN_SHARE) {
          // Deletes here free next to nothing (shared or cloned files): stop
          // this rule on this volume for a day instead of grinding on.
          lowYield.add(item.rule);
          this.state.ruleHolds ??= {};
          this.state.ruleHolds[`${item.rule}:${volumeId}`] = this.now() + RULE_HOLD_MS;
          this.journal({ op: "low-yield", rule: item.rule, volume: volumeId, du, gain });
        }
      }
      free = after;
    }
    this.dropCandidates(removed);
    const what = `${force ? "owner: clean safe now" : "safe cleanup"}${lowYield.size ? ` (stopped ${[...lowYield].join(", ")}: frees little)` : ""}`;
    return this.finishPass(volumeId, before, tally, what, "storage-safe", { force });
  }

  // requireAuto: an automatic delete, so the live mode is read again right
  // before acting. { outcome: done | skipped | failed, bytes }.
  async verifyAndRemove(item, ctx, why, { requireAuto = false } = {}) {
    const check = await this.verify(item, ctx);
    if (!check.ok) { this.journal({ op: "skip", why, rule: item.rule, path: item.path, reason: check.reason }); return { outcome: "skipped", bytes: 0 }; }
    if (requireAuto && this.getMode() !== "auto") return { outcome: "skipped", bytes: 0 };
    const result = await this.remove(item);
    this.journal({ op: result.ok ? "delete" : "fail", why, rule: item.rule, path: item.path, bytes: check.bytes, detail: result.detail ?? null });
    return { outcome: result.ok ? "done" : "failed", bytes: check.bytes };
  }

  // force: the owner asked, so even a pass that removed nothing is a line.
  async finishPass(volumeId, before, tally, what, playbook, { force = false } = {}) {
    const after = await this.freeBytes(volumeId);
    const freed = after === null ? 0 : Math.max(0, after - before);
    if (!tally.done && !tally.failed && !force) return { volume: volumeId, ...tally, freed };
    if (tally.done) {
      this.state.lastFreed = { bytes: freed, at: iso(this.now()), what: clampText(what, 60) };
      this.save();
    }
    this.store?.recordAction({
      kind: "storage", playbook, threadKey: KEY_PREFIX, status: tally.done || !tally.failed ? "done" : "failed",
      reason: clampText(`${what} on ${volumeId === "sd" ? "SD" : "Mac"}: ${tally.done} removed, ${tally.skipped} skipped, ${tally.failed} failed; ${formatBytes(freed)} freed (df)`, 300)
    });
    return { volume: volumeId, ...tally, freed, recorded: true };
  }

  dropCandidates(paths) {
    if (!paths.size || !this.candidates) return;
    this.candidates = this.candidates.filter((item) => !paths.has(item.path));
  }

  // ─── checks ─────────────────────────────────────────────────────────────

  allowed(item) {
    const p = String(item?.path ?? "");
    if (!path.isAbsolute(p) || p.includes("/../") || p.endsWith("/..")) return false;
    if (item.rule === "git-temp") return /\/objects\/(?:pack\/|[0-9a-f]{2}\/)?tmp_(?:pack|idx|rev|obj)_[^/]+$/.test(p);
    if (item.rule === "build" && !source.isInside(p, item.worktree)) return false;
    return ruleRoots(item.rule, this.paths).some((root) => source.isInside(p, root));
  }

  // worktree: also HEAD's reflog and the top of its build dirs.
  async idleSince(dir, ctx, idleMs, { worktree = false, ...options } = {}) {
    const key = `${dir}\u0000${idleMs}`;
    if (!ctx.idle.has(key)) {
      const now = this.now();
      const walk = await (worktree ? source.worktreeNewest : source.newestMtime)(dir, { stopAfterMs: now - idleMs, ...options });
      ctx.idle.set(key, walk.complete && now - walk.newest >= idleMs);
    }
    return ctx.idle.get(key);
  }

  // Re-checks one pinned item right before it is deleted or moved.
  // { ok, bytes } or { ok: false, reason }.
  async verify(item, ctx) {
    const paths = this.paths;
    const now = this.now();
    if (!this.allowed(item)) return no("outside the cleanup roots");
    if (item.volume === "sd" && !this.sdOk()) return no("SD card not verified");
    let st;
    try { st = await fsp.lstat(item.path); } catch { return no("gone"); }
    if (st.isSymbolicLink()) return no("now a symlink");
    if (st.dev !== item.dev || st.ino !== item.ino) return no("replaced since the scan");
    const scope = item.worktree ?? item.path;
    const inUse = () => {
      if (source.openUnder(ctx.open, scope)) return "in use";
      if (source.busyIn(scope, this.busyCwds())) return "an agent is running there";
      if (source.toolBusy(item, paths, ctx.procs)) return "its tool is running";
      return null;
    };
    const busy = inUse();
    if (busy) return no(busy);
    const age = now - st.mtimeMs;
    switch (item.rule) {
      case "git-temp": if (age < AGES.gitTempMs) return no("too new"); break;
      case "partial":
        if (age < AGES.partialMs) return no("too new");
        if (st.isDirectory() && !(await this.idleSince(item.path, ctx, AGES.partialMs, { skipBuild: false }))) return no("changed recently");
        break;
      case "installers": if (age < AGES.installerMs) return no("too new"); break;
      case "trash":
        if (source.isInside(item.path, paths.trash) && now - st.ctimeMs < AGES.trashMs) return no("trashed recently");
        break;
      case "tool-temp":
        if (paths.derivedData.some((dir) => source.isInside(item.path, dir))
          && !(await this.idleSince(item.path, ctx, AGES.derivedIdleMs, { dirsOnly: true, skipBuild: false, maxDepth: 4 }))) return no("used recently");
        break;
      case "build": {
        if (!(await this.idleSince(item.worktree, ctx, AGES.buildIdleMs, { worktree: true }))) return no("worktree used recently");
        const ignored = await source.gitIgnored(item.worktree, [item.path], this.config, this.run).catch(() => new Set());
        if (!ignored.has(item.path)) return no("not git-ignored");
        break;
      }
      case "worktrees": {
        const use = await this.threadUse(ctx);
        if (!use.ok) return no("thread catalogs unreadable");
        if (source.usedByThread(item.path, use)) return no("a thread uses it");
        const archived = item.archived && use.archived?.has(item.path);
        if (!archived && !(await this.idleSince(item.path, ctx, AGES.worktreeIdleMs, { worktree: true }))) return no("used recently");
        // Archived ones may be recent: nothing may have changed since the scan.
        if (archived && !(await this.unchangedSince(item))) return no("changed since the scan");
        const git = await source.gitState(item.path, this.config, this.run);
        if (git.clean !== true) return no("has uncommitted changes");
        if (git.pushed !== true) return no(git.detail ?? "has unpushed commits");
        break;
      }
      case "archive":
        if (age < AGES.archiveMs) return no("changed recently");
        if (st.isFile() && now - st.atimeMs < AGES.archiveMs) return no("opened recently");
        if (st.isDirectory() && !(await this.idleSince(item.path, ctx, AGES.archiveMs, { skipBuild: false, atime: true }))) return no("changed or opened recently");
        break;
      default: return no("unknown rule");
    }
    let bytes = item.bytes;
    // A worktree is not measured again (an SD worktree's du can take minutes):
    // its idle walk or unchangedSince check covers growth.
    if (item.rule !== "worktrees") {
      try { bytes = await source.sizeOf(item.path, this.config, this.run, { timeoutMs: source.duTimeoutMs(item.path, paths) }); } catch { return no("size unreadable"); }
      if (bytes > Math.max(item.bytes * GROWTH, item.bytes + GB)) return no("grew since the scan");
    }
    // The checks above can take minutes: read open files, processes and
    // threads again right before acting.
    if (!(await this.refreshContext(ctx))) return no("could not read open files");
    const late = inUse();
    if (late) return no(late);
    if (item.rule === "worktrees" && source.usedByThread(item.path, await this.threadUse(ctx))) return no("a thread uses it");
    return { ok: true, bytes };
  }

  // No file under the item is newer than when the scan saw it.
  async unchangedSince(item) {
    const since = Number(item.seenAt);
    if (!Number.isFinite(since)) return false;
    const walk = await source.newestMtime(item.path, { stopAfterMs: since, clock: this.clock });
    return walk.complete && walk.newest <= since;
  }

  // ─── delete and move ────────────────────────────────────────────────────

  // Tombstone first (a rename to a hidden sibling), then rm. The tombstone
  // is recorded, so a crash mid-rm is finished by the next pass.
  async remove(item) {
    const tomb = path.join(path.dirname(item.path), `${TOMBSTONE_PREFIX}${randomUUID().slice(0, 8)}`);
    this.state.tombstones = [...(this.state.tombstones ?? []), tomb];
    this.save();
    // Not saved (a full disk): a crash mid-rm would leave it hidden for good.
    if (this.lastWriteError) {
      this.state.tombstones = this.state.tombstones.filter((entry) => entry !== tomb);
      return { ok: false, detail: clampText(`could not save the delete record: ${this.lastWriteError}`, 160) };
    }
    try {
      await fsp.rename(item.path, tomb);
    } catch (error) {
      this.dropTombstone(tomb);
      return { ok: false, detail: clampText(error?.message ?? String(error), 160) };
    }
    const rm = await this.rmTree(tomb);
    if (!rm.ok) return { ok: false, detail: clampText(`removed from view, rm failed: ${rm.detail}`, 160) };
    this.dropTombstone(tomb);
    return { ok: true };
  }

  // /bin/rm -rf in its own process: killable, and big trees do not flood
  // the daemon's thread pool (the tick's statfs, DNS) or its memory.
  async rmTree(p) {
    let result;
    try {
      result = await this.run(this.config.bins.rm ?? "/bin/rm", ["-rf", "--", p], { timeoutMs: RM_TIMEOUT_MS });
    } catch (error) {
      return { ok: false, detail: error?.message ?? String(error) };
    }
    const gone = await fsp.lstat(p).then(() => false, () => true);
    if (gone) return { ok: true };
    return { ok: false, detail: String(result?.stderr || result?.error || (result?.timedOut ? "timed out" : `exit ${result?.code}`)).slice(0, 120) };
  }

  dropTombstone(tomb) {
    this.state.tombstones = (this.state.tombstones ?? []).filter((entry) => entry !== tomb);
    this.save();
  }

  // The card is read again first (state.json can still trust a card that
  // was swapped while the supervisor was down): nothing on the SD is
  // removed unless the card mounted now is the known one.
  async cleanTombstones() {
    const sdOk = await this.refreshVolumes().then(() => this.sdOk(), () => false);
    const paths = this.paths;
    for (const tomb of [...(this.state.tombstones ?? [])]) {
      if (!path.basename(tomb).startsWith(TOMBSTONE_PREFIX)) { this.dropTombstone(tomb); continue; }
      if (source.volumeOf(tomb, paths) === "sd" && !sdOk) continue;
      if ((await this.rmTree(tomb)).ok) this.dropTombstone(tomb);
    }
    await this.cleanCopies(sdOk);
  }

  // An archive copy cut off by a restart or stop(): a copy whose original
  // is not yet its symlink is removed, after the original is put back if
  // the swap had moved it aside (entry.tomb). A copy whose original already
  // became its symlink is kept (and gets its manifest line if the restart
  // beat it); the moved-aside original is then removed.
  async cleanCopies(sdOk) {
    const paths = this.paths;
    const there = (p) => fsp.lstat(p).then(() => true, () => false);
    for (const entry of [...(this.state.copying ?? [])]) {
      const linked = await fsp.readlink(entry.from).then((to) => to === entry.to, () => false);
      const tomb = entry.tomb && path.basename(entry.tomb).startsWith(TOMBSTONE_PREFIX) && await there(entry.tomb) ? entry.tomb : null;
      if (linked) {
        const listed = await fsp.readFile(this.archivePath, "utf8").then((text) => text.includes(JSON.stringify(entry.to)), () => false);
        if (!listed) { try { appendJsonLine(this.archivePath, { from: entry.from, to: entry.to, bytes: null, entries: null, at: entry.at }); } catch { /* next pass */ } }
        if (tomb) {
          this.state.tombstones = [...(this.state.tombstones ?? []), tomb];
          if ((await this.rmTree(tomb)).ok) this.dropTombstone(tomb);
        }
      } else {
        // The original first: something else at its path, or a failed
        // rename, keeps both it and the copy until the next pass.
        if (tomb && (await there(entry.from) || !(await fsp.rename(tomb, entry.from).then(() => true, () => false)))) continue;
        // The card away or rm failing: try again next pass. A copy whose
        // inode was recorded is removed only if it is still that copy.
        if (source.isInside(entry.to, paths.archiveDir)) {
          if (!sdOk) continue;
          const at = await fsp.lstat(entry.to).catch(() => null);
          if (at && (!Number.isFinite(entry.ino) || at.ino === entry.ino) && !(await this.rmTree(entry.to)).ok) continue;
        }
      }
      this.state.copying = (this.state.copying ?? []).filter((row) => row !== entry);
      this.save();
    }
  }

  async archivePass() {
    if (!this.sdOk()) return null;
    const now = this.now();
    const items = (this.candidates ?? [])
      // An installer is asked about; one the owner kept stays where it is.
      .filter((item) => item.rule === "archive" && item.volume === "data" && !item.installer && !this.backedOff(item.path, now))
      .sort((a, b) => b.bytes - a.bytes);
    if (!items.length) return null;
    const ctx = await this.verifyContext();
    if (!ctx) return null;
    const before = await this.freeBytes("data");
    if (before === null) return null;
    const tally = { done: 0, skipped: 0, failed: 0 };
    const moved = new Set();
    for (const item of items) {
      if (this.stopped || this.getMode() !== "auto") break;
      const free = await this.freeBytes("data");
      if (free === null || free >= this.targetBytes("data")) break;
      const result = await this.archiveItem(item, ctx);
      this.journal({ op: result.ok ? "archive" : result.failed ? "fail" : "skip", rule: "archive", path: item.path, to: result.to ?? null, reason: result.reason ?? null });
      tally[result.ok ? "done" : result.failed ? "failed" : "skipped"] += 1;
      if (result.ok) moved.add(item.path);
      else this.noteMiss(item.path, Boolean(result.failed));
    }
    this.dropCandidates(moved);
    return this.finishPass("data", before, tally, "moved old Downloads to the SD card", "storage-archive");
  }

  // ditto to <sd>/OpenAGI-Archive/Downloads/<name>, check bytes and entry
  // count, then swap the original for a symlink. Any failure removes the
  // partial copy and keeps the original.
  async archiveItem(item, ctx) {
    const check = await this.verify(item, ctx);
    if (!check.ok) return check;
    if (!this.sdOk()) return no("SD card not verified");
    const sdFree = await this.freeBytes("sd");
    if (sdFree === null || sdFree - check.bytes < this.settings.sdReserveGb * GB) return no("SD card would drop below its reserve");
    if (this.getMode() !== "auto") return no("left Auto");
    const paths = this.paths;
    let record = null;
    const fail = async (reason, dest) => {
      if (dest && source.isInside(dest, paths.archiveDir)) await this.rmTree(dest);
      if (record) { this.state.copying = (this.state.copying ?? []).filter((row) => row !== record); this.save(); }
      return { ok: false, failed: true, reason };
    };
    let dest = null;
    try {
      const before = await source.treeTotals(item.path);
      // A relative link to something outside would point elsewhere from the
      // card: such a folder stays where it is.
      if (before.outsideLinks) return no("has a relative link outside it");
      // The card read just before the copy starts: the record's path is on it.
      if (!(await this.refreshVolumes().then(() => this.sdOk(), () => false))) return no("SD card not verified");
      await fsp.mkdir(paths.archiveDir, { recursive: true });
      dest = await uniqueDest(paths.archiveDir, path.basename(item.path));
      // Recorded before the copy: a restart mid-copy leaves no orphan.
      record = { from: item.path, to: dest, at: iso(this.now()) };
      this.state.copying = [...(this.state.copying ?? []), record];
      this.save();
      const copy = await this.copy(item.path, dest, check.bytes, before.entries);
      if (!copy.ok) return fail(`copy failed: ${copy.detail ?? "ditto"}`, dest);
      const after = await source.treeTotals(dest).catch(() => null);
      if (!after || after.bytes !== before.bytes || after.entries !== before.entries) return fail("copy check failed (bytes or file count)", dest);
      // Recovery removes only this copy, not whatever sits at its path later.
      const made = await fsp.lstat(dest).catch(() => null);
      if (made) { record.ino = made.ino; this.save(); }
      // The copy can take a long time: anything written or opened meanwhile
      // keeps the original.
      const again = await source.treeTotals(item.path).catch(() => null);
      if (!again || again.bytes !== before.bytes || again.entries !== before.entries || again.newest !== before.newest) return fail("changed during the copy", dest);
      if (!(await this.refreshContext(ctx, { force: true }))) return fail("could not read open files", dest);
      if (source.openUnder(ctx.open, item.path)) return fail("opened during the copy", dest);
      if (this.getMode() !== "auto") return fail("left Auto", dest);
      // The card is read again: one swapped during the copy must not get the
      // link. The copy may be on that other card, so nothing is removed: the
      // record goes, the original stays.
      if (!(await this.refreshVolumes().then(() => this.sdOk(), () => false))) {
        this.state.copying = (this.state.copying ?? []).filter((row) => row !== record);
        record = null;
        this.save();
        return { ok: false, failed: true, reason: clampText(`SD card not verified after the copy; copy left at ${dest}`, 160) };
      }
      const tomb = path.join(path.dirname(item.path), `${TOMBSTONE_PREFIX}${randomUUID().slice(0, 8)}`);
      // Recorded before the rename: a restart mid-swap puts the original back.
      record.tomb = tomb;
      this.save();
      // Not saved (a full disk): a restart could not find the original.
      if (this.lastWriteError) return fail(`could not save the swap record: ${this.lastWriteError}`, dest);
      try { await fsp.rename(item.path, tomb); } catch (error) { return fail(`could not move the original: ${error?.message ?? error}`, dest); }
      try {
        await fsp.symlink(dest, item.path);
      } catch (error) {
        const back = await fsp.rename(tomb, item.path).then(() => true, () => false);
        // Not back: the record and the copy stay, the next pass retries.
        if (!back) return { ok: false, failed: true, reason: clampText(`could not leave a link or put the original back: ${error?.message ?? error}`, 160) };
        return fail(`could not leave a link: ${error?.message ?? error}`, dest);
      }
      try { appendJsonLine(this.archivePath, { from: item.path, to: dest, bytes: before.bytes, entries: before.entries, at: iso(this.now()) }); } catch { /* the journal has it too */ }
      this.state.tombstones = [...(this.state.tombstones ?? []), tomb];
      this.state.copying = (this.state.copying ?? []).filter((row) => row !== record);
      record = null;
      this.save();
      if ((await this.rmTree(tomb)).ok) this.dropTombstone(tomb);
      return { ok: true, to: dest, bytes: before.bytes };
    } catch (error) {
      return fail(clampText(error?.message ?? String(error), 160), dest);
    }
  }

  async copy(src, dest, bytes, entries = 1) {
    if (this.deps.ditto) return this.deps.ditto(src, dest);
    // About 20 MB/s and 200 new files/s at worst on the card, plus slack.
    const timeoutMs = Math.max(5 * MIN, Math.ceil(bytes / (20 * MB)) * 1000 + Math.ceil(entries / 200) * 1000 + MIN);
    const result = await this.run(this.config.bins.ditto ?? "/usr/bin/ditto", [src, dest], { timeoutMs });
    return { ok: result?.code === 0 && !result.timedOut, detail: clampText(result?.stderr || result?.error || (result?.timedOut ? "timed out" : ""), 120) };
  }

  // ─── the owner's answers ────────────────────────────────────────────────

  // { status: "sent" | "blocked", route: null, detail }. A non-sent result
  // keeps the question open.
  async answer(question, answer) {
    const meta = question?.meta ?? {};
    const reply = (status, detail) => ({ status, route: null, detail });
    if (!this.settings.enabled) return reply("blocked", "Storage manager is off.");
    if (answer === "Later") return reply("sent", "OK. Asking again in 24 h.");
    if (meta.rule === "critical") {
      if (answer !== "Clean safe now") return reply("blocked", "Pick one of the options.");
      this.requestScan({ forceSafe: true, questionId: question.id ?? null }).catch(() => {});
      return reply("sent", "Cleaning safe stuff now, in the background.");
    }
    // The plan is pinned while its question is open (it can only lose
    // items), so its id is the list the owner saw, or a part of it.
    const plan = this.state.plans?.[meta.rule];
    if (!plan || plan.id !== meta.planId) return reply("blocked", "The list changed. Look at the new question.");
    if (answer === "Keep") {
      const until = this.now() + KEEP_MS;
      this.state.holds ??= {};
      for (const item of plan.items) this.state.holds[item.path] = until;
      delete this.state.plans[meta.rule];
      this.save();
      return reply("sent", `Kept ${plan.items.length} items. Not asked again for 30 days.`);
    }
    if (String(answer).startsWith("Delete")) {
      if (answer !== deleteOption(plan)) return reply("blocked", "The list changed. Look at the new question.");
      this.enqueue(() => this.deletePlan(plan, { questionId: question.id ?? null, answer }), () => this.ownerNotDone(question.id ?? null, answer, "the supervisor stopped first")).catch(() => {});
      return reply("sent", `Deleting ${plan.items.length} items in the background. Each is checked again first.`);
    }
    return reply("blocked", "Pick one of the options.");
  }

  // The owner said Delete: only the pinned items, each re-verified now.
  // questionId: a Delete that cannot start asks again.
  async deletePlan(plan, { questionId = null, answer = deleteOption(plan) } = {}) {
    const ctx = await this.verifyContext();
    const label = `owner OK'd ${plan.rule}`;
    if (!ctx) {
      this.ownerNotDone(questionId, answer, "could not read open files; nothing deleted", `storage-${plan.rule}`);
      return null;
    }
    const volumes = [...new Set(plan.items.map((item) => item.volume))];
    const before = {};
    for (const id of volumes) before[id] = await this.freeBytes(id);
    const tally = { done: 0, skipped: 0, failed: 0 };
    const removed = new Set();
    for (const item of plan.items) {
      if (this.stopped) break;
      const { outcome } = await this.verifyAndRemove(item, ctx, "asked");
      tally[outcome] += 1;
      if (outcome === "done") removed.add(item.path);
    }
    let freed = 0;
    for (const id of volumes) {
      const after = await this.freeBytes(id);
      if (after !== null && before[id] !== null) freed += Math.max(0, after - before[id]);
    }
    this.dropCandidates(removed);
    if (this.state.plans?.[plan.rule]?.id === plan.id) delete this.state.plans[plan.rule];
    this.rebuildPlans();
    this.state.lastFreed = { bytes: freed, at: iso(this.now()), what: clampText(label, 60) };
    this.save();
    this.store?.recordAction({
      kind: "storage", playbook: `storage-${plan.rule}`, threadKey: KEY_PREFIX, status: tally.done ? "done" : "failed",
      reason: clampText(`${label}: ${tally.done} deleted, ${tally.skipped} left (changed or in use), ${tally.failed} failed; ${formatBytes(freed)} freed (df)`, 300)
    });
    return { ...tally, freed };
  }

  // ─── files ──────────────────────────────────────────────────────────────

  load() {
    let raw = null;
    try {
      ensureDir(this.dir);
      raw = readJsonFile(this.statePath, null);
    } catch (error) {
      this.lastWriteError = error?.message ?? String(error);
    }
    const state = isObject(raw) ? { ...emptyState(), ...raw } : emptyState();
    if (!isObject(state.plans)) state.plans = {};
    for (const key of ["holds", "backoff", "ruleHolds"]) if (!isObject(state[key])) state[key] = {};
    if (!Array.isArray(state.tombstones)) state.tombstones = [];
    if (!Array.isArray(state.copying)) state.copying = [];
    return state;
  }

  loadCache() {
    if (!this.cache) {
      const raw = (() => { try { return readJsonFile(this.cachePath, null); } catch { return null; } })();
      this.cache = isObject(raw) && isObject(raw.tasks) ? raw : { cursor: 0, tasks: {} };
    }
    return this.cache;
  }

  save() {
    const now = this.now();
    for (const [p, until] of Object.entries(this.state.holds ?? {})) if (Number(until) <= now) delete this.state.holds[p];
    for (const [key, until] of Object.entries(this.state.ruleHolds ?? {})) if (Number(until) <= now) delete this.state.ruleHolds[key];
    // A backoff is kept a while past its end so the next miss doubles it.
    for (const [p, row] of Object.entries(this.state.backoff ?? {})) if (!(Number(row?.until) + MAX_BACKOFF_MS > now)) delete this.state.backoff[p];
    try {
      writeJsonAtomic(this.statePath, this.state);
      this.lastWriteError = null;
    } catch (error) {
      this.lastWriteError = error?.message ?? String(error);
    }
  }

  journal(entry) {
    try { appendJsonLine(this.journalPath, { at: iso(this.now()), ...entry }); } catch (error) { this.lastWriteError = error?.message ?? String(error); }
  }
}

// name, then name-2, name-3 ... (before the extension for a file).
async function uniqueDest(dir, name) {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 1; n < 1000; n += 1) {
    const candidate = path.join(dir, n === 1 ? name : `${stem}-${n}${ext}`);
    try { await fsp.lstat(candidate); } catch { return candidate; }
  }
  throw new Error("no free archive name");
}
