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

const TITLES = {
  trash: (n, size) => `Old Trash: ${n} items, ${size}. Delete?`,
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
  return { identity: null, volumes: null, volumesAt: null, plans: {}, holds: {}, tombstones: [], lastScan: null, lastFreed: null, plannedDigest: null };
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
  enqueue(fn) {
    const job = this.queue.then(() => (this.stopped ? null : fn()));
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
    this.state.volumes = rows.map((row) => ({
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

  sdOk() {
    const sd = this.volume("sd");
    return Boolean(sd?.mounted && sd.identityOk && !sd.error);
  }

  isLow(id) {
    const row = this.volume(id);
    if (!row || !Number.isFinite(row.freeBytes)) return false;
    if (id === "sd") return this.sdOk() && row.freeBytes < this.settings.sdLowGb * GB;
    return row.freeBytes < this.settings.lowGb * GB;
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
    if (Number.isFinite(data?.freeBytes) && data.freeBytes < this.settings.criticalGb * GB) {
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
        options: [`Delete ${formatBytes(plan.bytes)}`, "Keep", "Later"],
        meta: { rule, planId: plan.id, digest: plan.digest }, reason: `${rule}: ${plan.items.length} items, ${formatBytes(plan.bytes)}`
      }));
    }
    return out;
  }

  // Small, for the snapshot (state.json is rewritten every tick).
  summary() {
    const round = (bytes) => (Number.isFinite(bytes) ? Math.round((bytes / GB) * 10) / 10 : null);
    return {
      volumes: (this.state.volumes ?? []).map((row) => ({ id: row.id, freeGb: round(row.freeBytes), totalGb: round(row.totalBytes), mounted: row.mounted, identityOk: row.identityOk })),
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
  // lowGb says (in any mode: it is the owner's own instruction).
  requestScan({ forceSafe = false } = {}) {
    if (this.scanPending && !forceSafe) return this.scanPending;
    const job = this.enqueue(async () => {
      this.scanning = true;
      try {
        const fresh = this.candidates && Date.now() - (this.scannedAt ?? 0) < (this.settings.scanLowMs ?? 15 * MIN);
        const ok = forceSafe && fresh ? true : await this.scanOnce();
        if (ok) await this.autoPasses({ force: forceSafe });
      } finally {
        this.scanning = false;
      }
    });
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
    this.scannedAt = Date.now();
    this.state.lastScan = { at, ok: true, complete: result.complete, durationMs: result.durationMs, errors: result.errors.length, error: result.errors[0] ?? null };
    this.rebuildPlans();
    this.save();
    return true;
  }

  held(p, now = this.now()) {
    return Number(this.state.holds?.[p] ?? 0) > now;
  }

  // One plan per ask rule from the candidates, minus kept items. An
  // unchanged list keeps its plan id.
  rebuildPlans() {
    const now = this.now();
    this.state.plans ??= {};
    for (const rule of ASK_RULES) {
      const items = (this.candidates ?? [])
        .filter((item) => item.rule === rule && !this.held(item.path, now) && (item.volume !== "sd" || this.sdOk()))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, PLAN_MAX_ITEMS);
      if (!items.length) { delete this.state.plans[rule]; continue; }
      const digest = shortHash(items.map((item) => `${item.path}\u0000${item.bytes}`).sort().join("\n"));
      if (this.state.plans[rule]?.digest === digest) continue;
      this.state.plans[rule] = {
        id: `${rule}-${digest.slice(0, 8)}`, rule, digest, createdAt: iso(now),
        bytes: items.reduce((sum, item) => sum + item.bytes, 0),
        items: items.map(({ rule: itemRule, path: p, bytes, volume, dev, ino, worktree = null, archived = false }) => ({ rule: itemRule, path: p, bytes, volume, dev, ino, worktree, archived }))
      };
    }
  }

  // ─── automatic passes ───────────────────────────────────────────────────

  async autoPasses({ force = false } = {}) {
    await this.cleanTombstones();
    if (await this.freeBytes("data") === null) return;
    const dataLow = force || this.isLow("data");
    const sdLow = this.isLow("sd");
    if (!dataLow && !sdLow) return;
    if (!force && this.getMode() !== "auto") { this.recordPlanned(); return; }
    if (dataLow) await this.safePass("data", { force });
    if (sdLow) await this.safePass("sd", { force });
    if (!force && this.isLow("data")) await this.archivePass();
  }

  // Observe and Propose only say what Auto would do (once per change).
  recordPlanned() {
    const low = ["data", "sd"].filter((id) => this.isLow(id));
    const safe = (this.candidates ?? []).filter((item) => SAFE_RULES.has(item.rule) && low.includes(item.volume));
    const moves = low.includes("data") && this.sdOk() ? (this.candidates ?? []).filter((item) => item.rule === "archive" && !item.installer) : [];
    if (!safe.length && !moves.length) return;
    const digest = shortHash([...safe, ...moves].map((item) => item.path).sort().join("\n"));
    if (digest === this.state.plannedDigest) return;
    this.state.plannedDigest = digest;
    this.save();
    const bytes = (list) => formatBytes(list.reduce((sum, item) => sum + item.bytes, 0));
    this.store?.recordAction({
      kind: "storage", playbook: "storage-safe", threadKey: KEY_PREFIX, status: "planned",
      reason: clampText(`Auto would delete ${safe.length} safe items (up to ${bytes(safe)})${moves.length ? ` and move ${moves.length} Downloads items (${bytes(moves)}) to the SD card` : ""}`, 300)
    });
  }

  // Opens files, processes, and (lazily) the thread catalogs, fresh. null
  // when the open-file or process read failed: then nothing is touched.
  async verifyContext() {
    try {
      const [open, procs] = await Promise.all([source.readOpenPaths(this.config, this.run), source.readProcessNames(this.config, this.run)]);
      return { open, procs, idle: new Map(), use: null };
    } catch (error) {
      this.journal({ op: "abort", reason: clampText(error?.message ?? String(error), 160) });
      return null;
    }
  }

  async safePass(volumeId, { force = false } = {}) {
    const items = (this.candidates ?? []).filter((item) => SAFE_RULES.has(item.rule) && item.volume === volumeId).sort((a, b) => b.bytes - a.bytes);
    if (!items.length) return null;
    const ctx = await this.verifyContext();
    if (!ctx) return null;
    const target = (volumeId === "data" ? this.settings.targetFreeGb : this.settings.sdLowGb) * GB;
    const before = await this.freeBytes(volumeId);
    if (before === null) return null;
    const tally = { done: 0, skipped: 0, failed: 0 };
    const removed = new Set();
    for (const item of items) {
      if (this.stopped || (!force && this.getMode() !== "auto")) break;
      const free = await this.freeBytes(volumeId);
      if (free === null || free >= target) break;
      const outcome = await this.verifyAndRemove(item, ctx, "safe", { requireAuto: !force });
      tally[outcome] += 1;
      if (outcome === "done") removed.add(item.path);
    }
    this.dropCandidates(removed);
    return this.finishPass(volumeId, before, tally, force ? "owner: clean safe now" : "safe cleanup", "storage-safe");
  }

  // requireAuto: an automatic delete, so the live mode is read again right
  // before acting.
  async verifyAndRemove(item, ctx, why, { requireAuto = false } = {}) {
    const check = await this.verify(item, ctx);
    if (!check.ok) { this.journal({ op: "skip", why, rule: item.rule, path: item.path, reason: check.reason }); return "skipped"; }
    if (requireAuto && this.getMode() !== "auto") return "skipped";
    const result = await this.remove(item);
    this.journal({ op: result.ok ? "delete" : "fail", why, rule: item.rule, path: item.path, bytes: check.bytes, detail: result.detail ?? null });
    return result.ok ? "done" : "failed";
  }

  async finishPass(volumeId, before, tally, what, playbook) {
    const after = await this.freeBytes(volumeId);
    const freed = after === null ? 0 : Math.max(0, after - before);
    if (!tally.done && !tally.failed) return { ...tally, freed };
    this.state.lastFreed = { bytes: freed, at: iso(this.now()), what: clampText(what, 60) };
    this.save();
    this.store?.recordAction({
      kind: "storage", playbook, threadKey: KEY_PREFIX, status: tally.done ? "done" : "failed",
      reason: clampText(`${what} on ${volumeId === "sd" ? "SD" : "Mac"}: ${tally.done} removed, ${tally.skipped} skipped, ${tally.failed} failed; ${formatBytes(freed)} freed (df)`, 300)
    });
    return { ...tally, freed };
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

  async idleSince(dir, ctx, idleMs, options = {}) {
    const key = `${dir}\u0000${idleMs}`;
    if (!ctx.idle.has(key)) {
      const now = this.now();
      const walk = await source.newestMtime(dir, { stopAfterMs: now - idleMs, ...options });
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
    if (source.openUnder(ctx.open, scope)) return no("in use");
    if (source.busyIn(scope, this.busyCwds())) return no("an agent is running there");
    if (source.toolBusy(item, paths, ctx.procs)) return no("its tool is running");
    const age = now - st.mtimeMs;
    switch (item.rule) {
      case "git-temp": if (age < AGES.gitTempMs) return no("too new"); break;
      case "partial": if (age < AGES.partialMs) return no("too new"); break;
      case "installers": if (age < AGES.installerMs) return no("too new"); break;
      case "trash":
        if (source.isInside(item.path, paths.trash) && now - st.ctimeMs < AGES.trashMs) return no("trashed recently");
        break;
      case "tool-temp":
        if (paths.derivedData.some((dir) => source.isInside(item.path, dir))
          && !(await this.idleSince(item.path, ctx, AGES.derivedIdleMs, { dirsOnly: true, skipBuild: false, maxDepth: 4 }))) return no("used recently");
        break;
      case "build": {
        if (!(await this.idleSince(item.worktree, ctx, AGES.buildIdleMs))) return no("worktree used recently");
        const ignored = await source.gitIgnored(item.worktree, [item.path], this.config, this.run).catch(() => new Set());
        if (!ignored.has(item.path)) return no("not git-ignored");
        break;
      }
      case "worktrees": {
        ctx.use ??= await source.readThreadUse(paths, this.deps).catch(() => ({ ok: false }));
        if (!ctx.use.ok) return no("thread catalogs unreadable");
        if (source.usedByThread(item.path, ctx.use)) return no("a thread uses it");
        const archived = item.archived && ctx.use.archived.has(item.path);
        if (!archived && !(await this.idleSince(item.path, ctx, AGES.worktreeIdleMs))) return no("used recently");
        const git = await source.gitState(item.path, this.config, this.run);
        if (git.clean !== true) return no("has uncommitted changes");
        if (git.pushed !== true) return no("has unpushed commits");
        break;
      }
      case "archive":
        if (age < AGES.archiveMs) return no("changed recently");
        if (st.isFile() && now - st.atimeMs < AGES.archiveMs) return no("opened recently");
        if (st.isDirectory() && !(await this.idleSince(item.path, ctx, AGES.archiveMs, { skipBuild: false }))) return no("changed recently");
        break;
      default: return no("unknown rule");
    }
    let bytes;
    try { bytes = await source.sizeOf(item.path, this.config, this.run); } catch { return no("size unreadable"); }
    if (bytes > Math.max(item.bytes * GROWTH, item.bytes + GB)) return no("grew since the scan");
    return { ok: true, bytes };
  }

  // ─── delete and move ────────────────────────────────────────────────────

  // Tombstone first (a rename to a hidden sibling), then rm. The tombstone
  // is recorded, so a crash mid-rm is finished by the next pass.
  async remove(item) {
    const tomb = path.join(path.dirname(item.path), `${TOMBSTONE_PREFIX}${randomUUID().slice(0, 8)}`);
    this.state.tombstones = [...(this.state.tombstones ?? []), tomb];
    this.save();
    try {
      await fsp.rename(item.path, tomb);
    } catch (error) {
      this.dropTombstone(tomb);
      return { ok: false, detail: clampText(error?.message ?? String(error), 160) };
    }
    try {
      await fsp.rm(tomb, { recursive: true, force: true });
    } catch (error) {
      return { ok: false, detail: clampText(`removed from view, rm failed: ${error?.message ?? error}`, 160) };
    }
    this.dropTombstone(tomb);
    return { ok: true };
  }

  dropTombstone(tomb) {
    this.state.tombstones = (this.state.tombstones ?? []).filter((entry) => entry !== tomb);
    this.save();
  }

  async cleanTombstones() {
    for (const tomb of [...(this.state.tombstones ?? [])]) {
      if (!path.basename(tomb).startsWith(TOMBSTONE_PREFIX)) { this.dropTombstone(tomb); continue; }
      try { await fsp.rm(tomb, { recursive: true, force: true }); this.dropTombstone(tomb); } catch { /* next pass */ }
    }
  }

  async archivePass() {
    if (!this.sdOk()) return null;
    const items = (this.candidates ?? [])
      .filter((item) => item.rule === "archive" && item.volume === "data" && (!item.installer || this.held(item.path)))
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
      if (free === null || free >= this.settings.targetFreeGb * GB) break;
      const result = await this.archiveItem(item, ctx);
      this.journal({ op: result.ok ? "archive" : result.failed ? "fail" : "skip", rule: "archive", path: item.path, to: result.to ?? null, reason: result.reason ?? null });
      tally[result.ok ? "done" : result.failed ? "failed" : "skipped"] += 1;
      if (result.ok) moved.add(item.path);
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
    const fail = async (reason, dest) => {
      if (dest && source.isInside(dest, paths.archiveDir)) await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
      return { ok: false, failed: true, reason };
    };
    let dest = null;
    try {
      await fsp.mkdir(paths.archiveDir, { recursive: true });
      dest = await uniqueDest(paths.archiveDir, path.basename(item.path));
      const before = await source.treeTotals(item.path);
      const copy = await this.copy(item.path, dest, check.bytes);
      if (!copy.ok) return fail(`copy failed: ${copy.detail ?? "ditto"}`, dest);
      const after = await source.treeTotals(dest).catch(() => null);
      if (!after || after.bytes !== before.bytes || after.entries !== before.entries) return fail("copy check failed (bytes or file count)", dest);
      const tomb = path.join(path.dirname(item.path), `${TOMBSTONE_PREFIX}${randomUUID().slice(0, 8)}`);
      try { await fsp.rename(item.path, tomb); } catch (error) { return fail(`could not move the original: ${error?.message ?? error}`, dest); }
      try {
        await fsp.symlink(dest, item.path);
      } catch (error) {
        await fsp.rename(tomb, item.path).catch(() => {});
        return fail(`could not leave a link: ${error?.message ?? error}`, dest);
      }
      try { appendJsonLine(this.archivePath, { from: item.path, to: dest, bytes: before.bytes, entries: before.entries, at: iso(this.now()) }); } catch { /* the journal has it too */ }
      this.state.tombstones = [...(this.state.tombstones ?? []), tomb];
      this.save();
      await fsp.rm(tomb, { recursive: true, force: true }).then(() => this.dropTombstone(tomb)).catch(() => {});
      return { ok: true, to: dest, bytes: before.bytes };
    } catch (error) {
      return fail(clampText(error?.message ?? String(error), 160), dest);
    }
  }

  async copy(src, dest, bytes) {
    if (this.deps.ditto) return this.deps.ditto(src, dest);
    // About 20 MB/s at worst on the card, plus slack.
    const timeoutMs = Math.max(5 * MIN, Math.ceil(bytes / (20 * MB)) * 1000 + MIN);
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
      this.requestScan({ forceSafe: true }).catch(() => {});
      return reply("sent", "Cleaning safe stuff now, in the background.");
    }
    const plan = this.state.plans?.[meta.rule];
    if (!plan || plan.id !== meta.planId || plan.digest !== meta.digest) return reply("blocked", "The list changed. Look at the new question.");
    if (answer === "Keep") {
      const until = this.now() + KEEP_MS;
      this.state.holds ??= {};
      for (const item of plan.items) this.state.holds[item.path] = until;
      delete this.state.plans[meta.rule];
      this.save();
      return reply("sent", `Kept ${plan.items.length} items. Not asked again for 30 days.`);
    }
    if (String(answer).startsWith("Delete")) {
      this.enqueue(() => this.deletePlan(plan)).catch(() => {});
      return reply("sent", `Deleting ${plan.items.length} items in the background. Each is checked again first.`);
    }
    return reply("blocked", "Pick one of the options.");
  }

  // The owner said Delete: only the pinned items, each re-verified now.
  async deletePlan(plan) {
    const ctx = await this.verifyContext();
    const label = `owner OK'd ${plan.rule}`;
    if (!ctx) {
      this.store?.recordAction({ kind: "storage", playbook: `storage-${plan.rule}`, threadKey: KEY_PREFIX, status: "failed", reason: `${label}: could not read open files; nothing deleted` });
      return null;
    }
    const volumes = [...new Set(plan.items.map((item) => item.volume))];
    const before = {};
    for (const id of volumes) before[id] = await this.freeBytes(id);
    const tally = { done: 0, skipped: 0, failed: 0 };
    const removed = new Set();
    for (const item of plan.items) {
      if (this.stopped) break;
      const outcome = await this.verifyAndRemove(item, ctx, "asked");
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
    if (!isObject(state.holds)) state.holds = {};
    if (!Array.isArray(state.tombstones)) state.tombstones = [];
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
