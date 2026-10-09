// Local storage, read-only: free space on the Mac's data volume and the SD
// card, and a time-boxed scan for things the storage manager (../storage.js)
// may clean, move or ask about. Never follows a symlink (lstat only), never
// writes anything but its own cache, and runs every binary by absolute path
// with a timeout (the daemon's PATH is /usr/bin:/bin:/usr/sbin:/sbin).

import fs from "node:fs";
import path from "node:path";
import { openReadOnlyDb, runCommand } from "../contracts.js";

const fsp = fs.promises;
export const GB = 2 ** 30;
const MB = 2 ** 20;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const BUILD_DIRS = new Set(["node_modules", ".next", ".turbo", "target"]);
export const SAFE_RULES = new Set(["git-temp", "build", "partial", "tool-temp"]);
export const ASK_RULES = ["trash", "worktrees", "installers"];
export const TOMBSTONE_PREFIX = ".fleet-deleting-";
const GIT_TEMP = /^tmp_(pack|idx|rev|obj)_/;
const PARTIAL = /\.(part|crdownload|download)$/i;
const INSTALLER = /\.(dmg|pkg|iso|zip)$/i;
// Rule ages.
export const AGES = Object.freeze({
  gitTempMs: 2 * HOUR, buildIdleMs: 14 * DAY, partialMs: 7 * DAY, derivedIdleMs: 14 * DAY,
  trashMs: 30 * DAY, worktreeIdleMs: 30 * DAY, installerMs: 30 * DAY, archiveMs: 30 * DAY
});
export const ARCHIVE_MIN_BYTES = 100 * MB;
// A worktree's scan result (idle walk, sizes, git) is reused this long.
export const WORKTREE_TTL_MS = 6 * HOUR;
const WALK_MAX_ENTRIES = 200_000;
const BUILD_WALK_DEPTH = 4;
const GIT_TIMEOUT_MS = 30_000;
const DU_TIMEOUT_MS = 90_000;
const RUSTUP_PROCS = new Set(["rustup", "cargo", "rustc"]);
const XCODE_PROCS = new Set(["xcodebuild", "XCBBuildService", "Xcode"]);

// Every path the manager may touch, from the config (tests point home and
// the SD at temp dirs).
export function storagePaths(config) {
  const home = config.paths.home;
  const sd = config.storage.sdMount;
  const uid = config.storage.uid ?? process.getuid?.() ?? 501;
  return {
    home, sd, data: config.storage.dataMount,
    downloads: path.join(home, "Downloads"),
    sdDownloads: path.join(sd, "Downloads"),
    trash: path.join(home, ".Trash"),
    sdTrash: path.join(sd, ".Trashes", String(uid)),
    archiveDir: path.join(sd, "OpenAGI-Archive", "Downloads"),
    rustupTmp: path.join(home, ".rustup", "tmp"),
    derivedData: [path.join(home, "Library", "Developer", "Xcode", "DerivedData"), path.join(sd, "codex-derived-data")],
    repoRoots: [path.join(home, "conductor", "repos")],
    // depth: how far below the root each worktree sits. A dir there with no
    // .git is looked into once more (codex-worktrees/<id>/<repo>).
    worktreeRoots: [
      { dir: path.join(home, "Dev", "bbapp", ".conductor"), depth: 1 },
      { dir: path.join(home, "Dev", "bbapp", ".worktrees"), depth: 1 },
      { dir: path.join(home, "Dev", "bbapp-worktrees"), depth: 1 },
      { dir: path.join(home, "Dev", "worktrees"), depth: 1 },
      { dir: path.join(home, "conductor", "workspaces"), depth: 2 },
      { dir: path.join(sd, "codex-worktrees"), depth: 1 }
    ],
    marker: path.join(sd, ".codex-xtra-volume-identity"),
    conductorDb: config.paths.conductorDb,
    codexDb: path.join(config.paths.codexHome, "state_5.sqlite")
  };
}

export function isInside(p, root) {
  return typeof p === "string" && typeof root === "string" && p.length > root.length && p.startsWith(`${root.replace(/\/+$/, "")}/`);
}

export function volumeOf(p, paths) {
  return p === paths.sd || isInside(p, paths.sd) ? "sd" : "data";
}

// ─── volumes ─────────────────────────────────────────────────────────────

// A mount point sits on another device than its parent dir. An SD card that
// is not mounted can leave an empty /Volumes/Xtra on the data disk.
async function defaultIsMount(mount) {
  const [self, parent] = await Promise.all([fsp.stat(mount), fsp.stat(path.dirname(mount))]);
  return self.dev !== parent.dev;
}

async function statfsOrDf(mount, deps, config) {
  if (deps.statfs) return deps.statfs(mount);
  if (typeof fsp.statfs === "function") return fsp.statfs(mount);
  const result = await (deps.run ?? runCommand)(config.bins.df ?? "/bin/df", ["-k", mount], { timeoutMs: 10_000 });
  const row = String(result?.stdout ?? "").trim().split("\n").at(-1)?.trim().split(/\s+/) ?? [];
  const total = Number(row[1]);
  const avail = Number(row[3]);
  if (!Number.isFinite(total) || !Number.isFinite(avail)) throw new Error(`df failed for ${mount}`);
  return { bsize: 1024, blocks: total, bavail: avail };
}

function parseMarker(text) {
  const match = /^volume_uuid=([0-9A-Fa-f-]{8,})\s*$/m.exec(String(text ?? ""));
  return match ? match[1].toUpperCase() : null;
}

// The SD's identity: the marker file's volume_uuid, else diskutil's
// VolumeUUID. ok only when it matches the one recorded the first time.
async function readIdentity(mount, paths, config, deps, recorded) {
  let uuid = null;
  try { uuid = parseMarker(await fsp.readFile(paths.marker, "utf8")); } catch { /* no marker */ }
  if (!uuid) {
    const result = await (deps.run ?? runCommand)(config.bins.diskutil ?? "/usr/sbin/diskutil", ["info", "-plist", mount], { timeoutMs: 15_000 });
    const match = /<key>VolumeUUID<\/key>\s*<string>([^<]+)<\/string>/.exec(String(result?.stdout ?? ""));
    uuid = match ? match[1].trim().toUpperCase() : null;
  }
  if (!uuid) return { ok: false, uuid: null, detail: "no identity marker or VolumeUUID" };
  if (recorded && recorded !== uuid) return { ok: false, uuid, detail: "a different card is mounted" };
  return { ok: true, uuid, detail: recorded ? null : "first seen" };
}

// [{ id, mount, totalBytes, freeBytes, mounted, identity: { ok, uuid, detail }, error }]
export async function readVolumes(config, deps = {}, { recordedIdentity = null } = {}) {
  const paths = storagePaths(config);
  const isMount = deps.isMount ?? defaultIsMount;
  const out = [];
  for (const [id, mount] of [["data", paths.data], ["sd", paths.sd]]) {
    const row = { id, mount, totalBytes: null, freeBytes: null, mounted: id === "data", identity: { ok: id === "data", uuid: null, detail: null }, error: null };
    try {
      if (id === "sd") row.mounted = await isMount(mount).catch(() => false);
      if (row.mounted) {
        const stats = await statfsOrDf(mount, deps, config);
        row.totalBytes = Number(stats.blocks) * Number(stats.bsize);
        row.freeBytes = Number(stats.bavail) * Number(stats.bsize);
        if (!Number.isFinite(row.freeBytes)) throw new Error("no free space figure");
      }
      if (id === "sd") row.identity = row.mounted ? await readIdentity(mount, paths, config, deps, recordedIdentity) : { ok: false, uuid: null, detail: "not mounted" };
    } catch (error) {
      row.error = String(error?.message ?? error).slice(0, 200);
      if (id === "sd") row.identity = { ok: false, uuid: null, detail: "unreadable" };
    }
    out.push(row);
  }
  return out;
}

// ─── in-use and process snapshots ────────────────────────────────────────

// Every open file and process cwd, sorted for prefix lookups. A failed or
// empty read throws: unknown is never "nothing open".
export async function readOpenPaths(config, run = runCommand) {
  const result = await run(config.bins.lsof, ["-n", "-P", "-w", "-Fn"], { timeoutMs: 60_000, maxBytes: 64 * MB });
  const text = String(result?.stdout ?? "");
  if (!result || result.timedOut || result.error || !text.includes("\nn/")) throw new Error(`lsof failed${result?.timedOut ? " (timed out)" : ""}`);
  const names = new Set();
  for (const line of text.split("\n")) if (line.startsWith("n/")) names.add(line.slice(1).replace(/ \(.*\)$/, ""));
  return [...names].sort();
}

function lowerBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// True when p, or anything inside it, is open or a process cwd. No
// snapshot (a failed read) counts as open.
export function openUnder(sorted, p) {
  if (!Array.isArray(sorted)) return true;
  const target = p.replace(/\/+$/, "");
  const prefix = `${target}/`;
  return sorted[lowerBound(sorted, target)] === target || String(sorted[lowerBound(sorted, prefix)] ?? "").startsWith(prefix);
}

// Basenames of every running process.
export async function readProcessNames(config, run = runCommand) {
  const result = await run(config.bins.ps, ["-axo", "comm="], { timeoutMs: 10_000 });
  if (!result || result.error || result.timedOut || result.code !== 0) throw new Error("ps failed");
  return new Set(String(result.stdout ?? "").split("\n").map((line) => path.basename(line.trim())).filter(Boolean));
}

export function toolBusy(item, paths, procs) {
  if (!procs) return true;
  const any = (names) => [...names].some((name) => procs.has(name));
  if (isInside(item.path, paths.rustupTmp)) return any(RUSTUP_PROCS);
  if (paths.derivedData.some((dir) => isInside(item.path, dir))) return any(XCODE_PROCS);
  return false;
}

// ─── thread use (Conductor and Codex catalogs, read-only) ────────────────

function real(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

// { ok, archived: Set, active: [paths], codex: [cwds] }. ok false when a
// catalog exists but could not be read: then no worktree counts as unused.
export async function readThreadUse(paths, deps = {}) {
  if (deps.readThreadUse) return deps.readThreadUse(paths);
  const out = { ok: true, archived: new Set(), active: [], codex: [] };
  if (fs.existsSync(paths.conductorDb)) {
    const db = await openReadOnlyDb(paths.conductorDb);
    if (!db) return { ...out, ok: false };
    try {
      const rows = db.prepare(`SELECT w.workspace_path, w.directory_name, w.state, r.root_path FROM workspaces w LEFT JOIN repos r ON r.id = w.repository_id`).all();
      for (const row of rows) {
        const dir = row.workspace_path || (row.root_path && row.directory_name ? path.join(row.root_path, ".conductor", row.directory_name) : null);
        if (!dir) continue;
        if (row.state === "archived") out.archived.add(dir);
        else out.active.push(dir);
      }
    } catch {
      return { ...out, ok: false };
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  }
  if (fs.existsSync(paths.codexDb)) {
    const db = await openReadOnlyDb(paths.codexDb);
    if (!db) return { ...out, ok: false };
    try {
      const columns = new Set(db.prepare("PRAGMA table_info(threads)").all().map((row) => row.name));
      const where = columns.has("archived") ? " WHERE COALESCE(archived, 0) = 0" : "";
      for (const row of db.prepare(`SELECT cwd FROM threads${where}`).all()) if (row.cwd) out.codex.push(String(row.cwd));
    } catch {
      return { ...out, ok: false };
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  }
  return out;
}

// An unarchived Conductor workspace or Codex thread sits in (or above) dir.
export function usedByThread(dir, use) {
  if (!use?.ok) return true;
  const target = real(dir);
  const hits = (p) => {
    const r = real(p);
    return [p, r].some((x) => x === dir || x === target || isInside(x, dir) || isInside(x, target) || isInside(dir, x) || isInside(target, x));
  };
  return use.active.some(hits) || use.codex.some(hits);
}

export function busyIn(dir, busyCwds = []) {
  return busyCwds.some((cwd) => cwd === dir || isInside(cwd, dir) || isInside(dir, cwd));
}

// ─── sizes and walks ─────────────────────────────────────────────────────

// Allocated bytes: du for a dir (one filesystem, links not followed), the
// file's blocks otherwise. Clones and hard links make this an upper bound.
export async function sizeOf(p, config, run = runCommand) {
  const st = await fsp.lstat(p);
  if (!st.isDirectory()) return Math.max(Number(st.blocks ?? 0) * 512, 0);
  const result = await run(config.bins.du, ["-skx", p], { timeoutMs: DU_TIMEOUT_MS });
  const kb = Number(/^(\d+)/.exec(String(result?.stdout ?? "").trim())?.[1]);
  if (!Number.isFinite(kb) || result?.timedOut) throw new Error(`du failed for ${path.basename(p)}`);
  return kb * 1024;
}

// Newest mtime under root, skipping .git and build dirs. Stops early once a
// file newer than stopAfterMs shows up. complete false: unknown, not idle;
// timedOut: the scan ran out of time (its task result is not kept).
export async function newestMtime(root, { stopAfterMs = Infinity, deadline = Infinity, clock = Date.now, skipBuild = true, dirsOnly = false, maxDepth = Infinity } = {}) {
  const stack = [[root, 0]];
  let newest = 0;
  let seen = 0;
  while (stack.length) {
    if (clock() > deadline) return { newest, complete: false, timedOut: true };
    if (seen > WALK_MAX_ENTRIES) return { newest, complete: false };
    const [dir, depth] = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return { newest, complete: false }; }
    seen += entries.length;
    const stat = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || (skipBuild && BUILD_DIRS.has(entry.name))) continue;
        if (dirsOnly) stat.push(full);
        if (depth + 1 < maxDepth) stack.push([full, depth + 1]);
      } else if (!dirsOnly) stat.push(full);
    }
    for (let i = 0; i < stat.length; i += 256) {
      const rows = await Promise.all(stat.slice(i, i + 256).map((file) => fsp.lstat(file).catch(() => null)));
      for (const row of rows) if (row && row.mtimeMs > newest) newest = row.mtimeMs;
    }
    if (newest > stopAfterMs) return { newest, complete: false, recent: true };
  }
  return { newest, complete: true };
}

// Totals for a copy check: regular-file bytes and entry count.
export async function treeTotals(root) {
  const st = await fsp.lstat(root);
  if (!st.isDirectory()) return { bytes: st.isFile() ? st.size : 0, entries: 1 };
  let bytes = 0;
  let entries = 1;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      entries += 1;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) bytes += (await fsp.lstat(full)).size;
    }
  }
  return { bytes, entries };
}

// ─── git ─────────────────────────────────────────────────────────────────

function git(config, run, dir, args) {
  return run(config.bins.git, ["--no-optional-locks", "-C", dir, ...args], { timeoutMs: GIT_TIMEOUT_MS });
}

// The repo's shared git dir: .git itself, or what a linked worktree's .git
// file points at (its commondir).
export async function commonGitDir(dir) {
  const dotGit = path.join(dir, ".git");
  let st;
  try { st = await fsp.lstat(dotGit); } catch { return null; }
  if (st.isDirectory()) return dotGit;
  if (!st.isFile()) return null;
  const match = /^gitdir:\s*(.+)$/m.exec(await fsp.readFile(dotGit, "utf8").catch(() => ""));
  if (!match) return null;
  const gitdir = path.resolve(dir, match[1].trim());
  const common = (await fsp.readFile(path.join(gitdir, "commondir"), "utf8").catch(() => "")).trim();
  return common ? path.resolve(gitdir, common) : gitdir;
}

// { clean, pushed } for a worktree; null fields when git could not tell.
export async function gitState(dir, config, run = runCommand) {
  const status = await git(config, run, dir, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  const clean = status?.code === 0 && !status.timedOut ? String(status.stdout ?? "").trim() === "" : null;
  let pushed = null;
  const upstream = await git(config, run, dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstream?.code === 0 && String(upstream.stdout ?? "").trim()) {
    const ahead = await git(config, run, dir, ["rev-list", "--count", "@{u}..HEAD"]);
    const count = Number(String(ahead?.stdout ?? "").trim());
    if (ahead?.code === 0 && Number.isFinite(count)) pushed = count === 0;
  } else {
    for (const base of ["origin/main", "origin/master"]) {
      const merged = await git(config, run, dir, ["merge-base", "--is-ancestor", "HEAD", base]);
      if (merged?.code === 0) { pushed = true; break; }
      if (merged?.code === 1) { pushed = false; break; }
    }
  }
  return { clean, pushed };
}

// The subset of paths (inside dir) git ignores.
export async function gitIgnored(dir, paths, config, run = runCommand) {
  if (!paths.length) return new Set();
  const result = await git(config, run, dir, ["check-ignore", "--", ...paths.map((p) => path.relative(dir, p))]);
  if (!result || result.timedOut || ![0, 1].includes(result.code)) throw new Error("git check-ignore failed");
  return new Set(String(result.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean).map((rel) => path.join(dir, rel)));
}

// ─── enumeration ─────────────────────────────────────────────────────────

async function childDirs(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
  // Dirent types come from lstat: a symlinked dir is never a directory here.
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(TOMBSTONE_PREFIX)).map((entry) => path.join(dir, entry.name));
}

async function isRealDir(p) {
  try { return (await fsp.lstat(p)).isDirectory(); } catch { return false; }
}

async function hasGit(dir) {
  try { await fsp.lstat(path.join(dir, ".git")); return true; } catch { return false; }
}

export async function listWorktrees(paths) {
  const out = [];
  for (const root of paths.worktreeRoots) {
    if (!(await isRealDir(root.dir))) continue;
    let level = [root.dir];
    for (let depth = 0; depth < root.depth; depth += 1) level = (await Promise.all(level.map(childDirs))).flat();
    for (const dir of level) {
      if (await hasGit(dir)) { out.push(dir); continue; }
      for (const inner of await childDirs(dir)) if (await hasGit(inner)) out.push(inner);
    }
  }
  return [...new Set(out)];
}

async function listGitDirs(paths, worktrees) {
  const dirs = new Set();
  for (const root of paths.repoRoots) {
    if (!(await isRealDir(root))) continue;
    for (const repo of await childDirs(root)) {
      const common = await commonGitDir(repo);
      if (common) dirs.add(common);
      else if (await isRealDir(path.join(repo, "objects"))) dirs.add(repo);
    }
  }
  for (const wt of worktrees) {
    const common = await commonGitDir(wt);
    if (common) dirs.add(common);
  }
  return [...dirs];
}

async function entries(dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function candidate(rule, p, st, bytes, paths, extra = {}) {
  return { rule, path: p, bytes, volume: volumeOf(p, paths), dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, ...extra };
}

// ─── scan tasks ──────────────────────────────────────────────────────────

// A walk cut short by the clock proves nothing: the task fails and keeps
// its last result.
function outOfTime(walk) {
  if (walk.timedOut) throw new Error("out of time");
  return walk;
}

async function scanGitTemp(gitdir, ctx) {
  const out = [];
  const objects = path.join(gitdir, "objects");
  const dirs = [objects, path.join(objects, "pack"), ...(await childDirs(objects)).filter((dir) => /\/[0-9a-f]{2}$/.test(dir))];
  for (const dir of dirs) {
    for (const entry of await entries(dir)) {
      if (!GIT_TEMP.test(entry.name) || entry.isSymbolicLink()) continue;
      const p = path.join(dir, entry.name);
      const st = await fsp.lstat(p).catch(() => null);
      if (!st || ctx.now - st.mtimeMs < AGES.gitTempMs) continue;
      out.push(candidate("git-temp", p, st, await sizeOf(p, ctx.config, ctx.run), ctx.paths));
    }
  }
  return out;
}

// Build output dirs inside a worktree, not below another build dir.
async function findBuildDirs(wt) {
  const out = [];
  const stack = [[wt, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    for (const entry of await entries(dir).catch(() => [])) {
      if (!entry.isDirectory() || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (BUILD_DIRS.has(entry.name)) {
        if (entry.name !== "target" || fs.existsSync(path.join(dir, "Cargo.toml"))) out.push(full);
        continue;
      }
      if (depth + 1 < BUILD_WALK_DEPTH) stack.push([full, depth + 1]);
    }
  }
  return out;
}

async function scanWorktree(wt, ctx) {
  const out = [];
  const st = await fsp.lstat(wt);
  // In use now: nothing here is idle (re-checked after the TTL).
  if (!st.isDirectory() || openUnder(ctx.open, wt) || busyIn(wt, ctx.busyCwds)) return out;
  const idle = outOfTime(await newestMtime(wt, { stopAfterMs: ctx.now - AGES.buildIdleMs, deadline: ctx.deadline, clock: ctx.clock }));
  // HEAD's reflog moves on commits and checkouts that touch no file.
  const gitdir = await gitDirOf(wt);
  const reflog = gitdir ? await fsp.lstat(path.join(gitdir, "logs", "HEAD")).then((row) => row.mtimeMs).catch(() => 0) : 0;
  const newest = Math.max(idle.newest, reflog);
  const idleFor = idle.complete ? ctx.now - newest : 0;
  if (idleFor >= AGES.buildIdleMs) {
    const builds = await findBuildDirs(wt);
    const ignored = await gitIgnored(wt, builds, ctx.config, ctx.run);
    for (const dir of builds) {
      if (!ignored.has(dir)) continue;
      const row = await fsp.lstat(dir).catch(() => null);
      if (!row?.isDirectory()) continue;
      out.push(candidate("build", dir, row, await sizeOf(dir, ctx.config, ctx.run), ctx.paths, { worktree: wt }));
    }
  }
  const archived = ctx.use.ok && ctx.use.archived.has(wt);
  if (ctx.use.ok && (archived || idleFor >= AGES.worktreeIdleMs) && !usedByThread(wt, ctx.use)) {
    const state = await gitState(wt, ctx.config, ctx.run);
    if (state.clean === true && state.pushed === true) {
      out.push(candidate("worktrees", wt, st, await sizeOf(wt, ctx.config, ctx.run), ctx.paths, { worktree: wt, archived }));
    }
  }
  return out;
}

async function gitDirOf(wt) {
  const dotGit = path.join(wt, ".git");
  const st = await fsp.lstat(dotGit).catch(() => null);
  if (st?.isDirectory()) return dotGit;
  if (!st?.isFile()) return null;
  const match = /^gitdir:\s*(.+)$/m.exec(await fsp.readFile(dotGit, "utf8").catch(() => ""));
  return match ? path.resolve(wt, match[1].trim()) : null;
}

// Partial downloads, old installers, and big idle entries to archive.
async function scanDownloads(dir, ctx, { archive }) {
  const out = [];
  for (const entry of await entries(dir)) {
    if (entry.isSymbolicLink() || entry.name.startsWith(TOMBSTONE_PREFIX) || entry.name.startsWith(".")) continue;
    const p = path.join(dir, entry.name);
    const st = await fsp.lstat(p).catch(() => null);
    if (!st) continue;
    const age = ctx.now - st.mtimeMs;
    if (PARTIAL.test(entry.name)) {
      if (age >= AGES.partialMs) out.push(candidate("partial", p, st, await sizeOf(p, ctx.config, ctx.run), ctx.paths));
      continue;
    }
    if (!archive) continue;
    const installer = st.isFile() && INSTALLER.test(entry.name);
    if (installer && age >= AGES.installerMs) out.push(candidate("installers", p, st, await sizeOf(p, ctx.config, ctx.run), ctx.paths));
    if (age < AGES.archiveMs) continue;
    if (st.isFile() && ctx.now - st.atimeMs < AGES.archiveMs) continue;
    const bytes = await sizeOf(p, ctx.config, ctx.run);
    if (bytes < (ctx.config.storage.archiveMinBytes ?? ARCHIVE_MIN_BYTES)) continue;
    if (st.isDirectory()) {
      const inner = outOfTime(await newestMtime(p, { stopAfterMs: ctx.now - AGES.archiveMs, deadline: ctx.deadline, clock: ctx.clock, skipBuild: false }));
      if (!inner.complete) continue;
    }
    out.push(candidate("archive", p, st, bytes, ctx.paths, { installer }));
  }
  return out;
}

async function scanTrash(dir, ctx, { anyAge }) {
  const out = [];
  for (const entry of await entries(dir)) {
    if (entry.name === ".DS_Store" || entry.name.startsWith(TOMBSTONE_PREFIX)) continue;
    const p = path.join(dir, entry.name);
    const st = await fsp.lstat(p).catch(() => null);
    // ctime moves when an item is put in the Trash.
    if (!st || (!anyAge && ctx.now - st.ctimeMs < AGES.trashMs)) continue;
    out.push(candidate("trash", p, st, await sizeOf(p, ctx.config, ctx.run), ctx.paths));
  }
  return out;
}

async function scanToolTemp(ctx) {
  const out = [];
  for (const entry of await entries(ctx.paths.rustupTmp)) {
    if (entry.isSymbolicLink()) continue;
    const p = path.join(ctx.paths.rustupTmp, entry.name);
    const st = await fsp.lstat(p).catch(() => null);
    if (st) out.push(candidate("tool-temp", p, st, await sizeOf(p, ctx.config, ctx.run), ctx.paths));
  }
  for (const root of ctx.paths.derivedData) {
    for (const entry of await entries(root)) {
      if (!entry.isDirectory()) continue;
      const p = path.join(root, entry.name);
      const st = await fsp.lstat(p).catch(() => null);
      if (!st) continue;
      // Builds create files, so dir mtimes show the last one.
      const idle = outOfTime(await newestMtime(p, { stopAfterMs: ctx.now - AGES.derivedIdleMs, deadline: ctx.deadline, clock: ctx.clock, dirsOnly: true, skipBuild: false, maxDepth: 4 }));
      if (!idle.complete || ctx.now - Math.max(idle.newest, st.mtimeMs) < AGES.derivedIdleMs) continue;
      out.push(candidate("tool-temp", p, st, await sizeOf(p, ctx.config, ctx.run), ctx.paths));
    }
  }
  return out;
}

// ─── the scan ────────────────────────────────────────────────────────────

async function listTasks(paths) {
  const worktrees = await listWorktrees(paths);
  const gitdirs = await listGitDirs(paths, worktrees);
  return [
    { key: "downloads", run: (ctx) => scanDownloads(paths.downloads, ctx, { archive: true }) },
    { key: "sd-downloads", run: (ctx) => scanDownloads(paths.sdDownloads, ctx, { archive: false }) },
    { key: "trash", run: (ctx) => scanTrash(paths.trash, ctx, { anyAge: false }) },
    { key: "sd-trash", run: (ctx) => scanTrash(paths.sdTrash, ctx, { anyAge: true }) },
    { key: "tool-temp", run: (ctx) => scanToolTemp(ctx) },
    ...gitdirs.map((dir) => ({ key: `git:${dir}`, run: (ctx) => scanGitTemp(dir, ctx) })),
    ...worktrees.map((dir) => ({ key: `wt:${dir}`, ttlMs: WORKTREE_TTL_MS, run: (ctx) => scanWorktree(dir, ctx) }))
  ];
}

// One scan within budgetMs. Tasks run round-robin from where the last scan
// stopped; a task not reached, or one that failed, keeps its last result
// (re-verified before any action). Throws when the open-file or process
// snapshot fails: the caller keeps its old plans and deletes nothing.
// cache: { cursor, tasks: { key: { at, candidates } } } (updated in place).
export async function scanStorage(config, deps = {}, { budgetMs = config.storage.scanBudgetMs, cache = { cursor: 0, tasks: {} }, busyCwds = [] } = {}) {
  const run = deps.run ?? runCommand;
  const clock = deps.clock ?? Date.now;
  const now = deps.now?.() ?? Date.now();
  const startedAt = clock();
  const deadline = startedAt + budgetMs;
  const paths = storagePaths(config);
  const open = await readOpenPaths(config, run);
  const procs = await readProcessNames(config, run);
  const use = await readThreadUse(paths, deps).catch(() => ({ ok: false, archived: new Set(), active: [], codex: [] }));
  const tasks = await listTasks(paths);
  const ctx = { config, run, paths, now, clock, deadline, use, open, busyCwds };
  cache.tasks ??= {};
  const errors = [];
  let ran = 0;
  const start = tasks.length ? (cache.cursor ?? 0) % tasks.length : 0;
  let index = 0;
  for (; index < tasks.length; index += 1) {
    if (clock() > deadline) break;
    const task = tasks[(start + index) % tasks.length];
    const cached = cache.tasks[task.key];
    if (task.ttlMs && cached && now - cached.at < task.ttlMs) continue;
    try {
      // Each task may use up to one budget; no new task starts past it.
      cache.tasks[task.key] = { at: now, candidates: await task.run({ ...ctx, deadline: clock() + budgetMs }) };
      ran += 1;
    } catch (error) {
      errors.push(`${task.key}: ${String(error?.message ?? error).slice(0, 120)}`);
    }
  }
  cache.cursor = tasks.length ? (start + index) % tasks.length : 0;
  const keys = new Set(tasks.map((task) => task.key));
  for (const key of Object.keys(cache.tasks)) if (!keys.has(key)) delete cache.tasks[key];
  // Open, busy or tool-locked items drop out of this scan's list (the
  // cache keeps them for the next).
  const candidates = Object.values(cache.tasks).flatMap((entry) => entry.candidates ?? [])
    .filter((item) => !openUnder(open, item.worktree ?? item.path) && !busyIn(item.worktree ?? item.path, busyCwds) && !toolBusy(item, paths, procs));
  return { at: now, complete: index >= tasks.length, ran, errors, candidates, durationMs: clock() - startedAt };
}
