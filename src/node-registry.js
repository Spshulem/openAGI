// src/node-registry.js
// Two small pieces: (1) every installation's own stable identity, generated
// once and persisted regardless of whether it's paired to anything; (2) a
// file-backed registry of *other* nodes, kept by whichever installation is
// acting as a main (i.e. has received at least one heartbeat). A node counts
// "online" if its last heartbeat arrived within ONLINE_WINDOW_MS (3x the 30s
// send interval used by the heartbeat sender in node-heartbeat-sender.js) —
// missing up to 2 heartbeats in a row doesn't flip it offline, only 3+.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";

export const ONLINE_WINDOW_MS = 90_000;
export const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

// Liveness is a *derivation from a timestamp*, never a stored fact. GET /nodes
// on a paired node used to hand back a cached upstream response verbatim, so a
// "status":"online" computed by the main two weeks ago was replayed forever,
// long after the machine it described had gone dark. Every caller recomputes
// from lastSeenAt against the clock at read time; "unknown" is a real answer
// when there is no usable timestamp, and is preferable to a confident guess.
export function statusFor(lastSeenAt, now = Date.now()) {
  if (typeof lastSeenAt !== "string" || !lastSeenAt) return "unknown";
  const t = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(t)) return "unknown";
  return (now - t) <= ONLINE_WINDOW_MS ? "online" : "offline";
}

// Numeric, dot-separated comparison so 0.0.10 sorts after 0.0.6 (a plain
// string compare gets this backwards, which is exactly the range the project
// is in). Returns null — not 0 — when either side isn't comparable, so the
// caller can decline to claim anything rather than silently treating an
// unparseable version as equal.
export function compareVersions(a, b) {
  const parse = (v) => {
    if (typeof v !== "string") return null;
    const core = v.trim().replace(/^v/, "").split(/[-+]/)[0];
    if (!/^\d+(\.\d+)*$/.test(core)) return null;
    return core.split(".").map(Number);
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// The newest comparable version in a list, or null if none are comparable.
export function newestOf(versions) {
  let best = null;
  for (const v of versions) {
    if (typeof v !== "string" || !v) continue;
    if (best === null) {
      if (compareVersions(v, v) !== null) best = v;
      continue;
    }
    if (compareVersions(v, best) === 1) best = v;
  }
  return best;
}

function plistString(xml, key) {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml);
  const value = m ? m[1].trim() : "";
  // build-mac-app.sh substitutes __VERSION__/__BUILD__ into Info.plist. An
  // unsubstituted placeholder means the bundle was never stamped — surface
  // nothing rather than the literal "__VERSION__".
  return value && !value.startsWith("__") ? value : null;
}

// Inside OpenAGI.app the JS lives at Contents/Resources/openAGI/src, so the
// bundle's stamped Info.plist is three levels up. CFBundleShortVersionString
// is stamped from the git tag by build-mac-app.sh, which makes it strictly
// more trustworthy than package.json (currently 0.0.6 against tags at v0.0.10).
function readAppBundle(moduleDir) {
  const contents = path.resolve(moduleDir, "..", "..", "..");
  if (path.basename(contents) !== "Contents") return null;
  let xml;
  try { xml = fs.readFileSync(path.join(contents, "Info.plist"), "utf8"); } catch { return null; }
  const version = plistString(xml, "CFBundleShortVersionString");
  const build = plistString(xml, "CFBundleVersion");
  if (!version && !build) return null;
  return { version, build };
}

// Read HEAD straight out of .git rather than shelling out to git: this runs on
// every GET /nodes, the daemon may not have git on PATH, and spawning a
// subprocess to answer a status question is a needless execution surface.
function readGitSha(moduleDir) {
  const repoRoot = path.resolve(moduleDir, "..");
  let gitDir = path.join(repoRoot, ".git");
  try {
    if (fs.statSync(gitDir).isFile()) {
      // A worktree/submodule checkout: .git is a pointer file.
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, "utf8"));
      if (!m) return null;
      gitDir = path.resolve(repoRoot, m[1].trim());
    }
  } catch { return null; }
  let head;
  try { head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim(); } catch { return null; }
  const short = (sha) => (/^[0-9a-f]{40}$/i.test(sha) ? sha.slice(0, 7) : null);
  if (short(head)) return short(head); // detached HEAD
  const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim();
  if (!ref || ref.includes("..")) return null;
  try {
    const sha = short(fs.readFileSync(path.join(gitDir, ref), "utf8").trim());
    if (sha) return sha;
  } catch { /* loose ref absent — try packed-refs below */ }
  try {
    const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8");
    const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
    if (line) return short(line.split(" ")[0]);
  } catch { /* no packed-refs either */ }
  return null;
}

let buildInfoCache = null;

// What this install actually is, in descending order of trustworthiness:
// an explicit stamp from the environment (CI/Docker), the app bundle's
// Info.plist, or the git SHA of the checkout. package.json is only ever the
// version fallback — it has drifted behind the release tags, which is why a
// version alone cannot answer "is this node up to date". When nothing is
// knowable the build is null: the UI renders that as "unknown", and we never
// fabricate an identifier.
export function resolveBuildInfo({
  packageVersion = null, env = process.env, moduleDir = MODULE_DIR, cache = true
} = {}) {
  if (cache && buildInfoCache) return buildInfoCache;
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const envVersion = str(env.OPENAGI_VERSION);
  const envBuild = str(env.OPENAGI_BUILD);
  let info;
  if (envBuild) {
    info = { version: envVersion ?? packageVersion, build: envBuild, buildSource: "env" };
  } else {
    const bundle = readAppBundle(moduleDir);
    if (bundle) {
      info = { version: bundle.version ?? envVersion ?? packageVersion, build: bundle.build, buildSource: "app-bundle" };
    } else {
      const sha = readGitSha(moduleDir);
      info = sha
        ? { version: envVersion ?? packageVersion, build: sha, buildSource: "git" }
        : { version: envVersion ?? packageVersion, build: null, buildSource: "unknown" };
    }
  }
  if (cache) buildInfoCache = info;
  return info;
}

export function readOrCreateIdentity(dataDir = resolveDataDir()) {
  const filePath = path.join(dataDir, "identity.json");
  const existing = readJsonFile(filePath, null);
  if (existing?.nodeId) return existing;
  const identity = { nodeId: crypto.randomUUID(), name: os.hostname() || "openagi" };
  writeJsonAtomic(filePath, identity);
  return identity;
}

export class NodeRegistry {
  constructor({ dir } = {}) {
    this.dir = dir ?? path.join(resolveDataDir(), "nodes");
    ensureDir(this.dir);
    this.storePath = path.join(this.dir, "registry.json");
  }

  upsert({ nodeId, name, role, url, version, build, buildSource }, { now = Date.now() } = {}) {
    // Prune against the SAME in-memory store we're about to update, rather
    // than pruning (its own read+maybe-write) and then re-reading the file
    // again from disk for the upsert — one read, one write, per call.
    const store = this._read();
    this._pruneStore(store, now);
    const existing = store.entries[nodeId];
    store.entries[nodeId] = {
      nodeId,
      name,
      role,
      url,
      version,
      build: build ?? null,
      buildSource: buildSource ?? null,
      firstSeenAt: existing?.firstSeenAt ?? new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString()
    };
    writeJsonAtomic(this.storePath, store);
  }

  list({ now = Date.now() } = {}) {
    const store = this._read();
    return Object.values(store.entries)
      .map((entry) => ({ ...entry, status: statusFor(entry.lastSeenAt, now) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  prune({ now = Date.now() } = {}) {
    const store = this._read();
    const removed = this._pruneStore(store, now);
    if (removed > 0) writeJsonAtomic(this.storePath, store);
    return removed;
  }

  // Mutates `store.entries` in place, deleting anything stale; returns the
  // count removed. Shared by prune() (which persists unconditionally when
  // something changed) and upsert() (which persists anyway right after).
  _pruneStore(store, now) {
    let removed = 0;
    for (const [nodeId, entry] of Object.entries(store.entries)) {
      if ((now - new Date(entry.lastSeenAt).getTime()) > PRUNE_AFTER_MS) {
        delete store.entries[nodeId];
        removed += 1;
      }
    }
    return removed;
  }

  _read() {
    return readJsonFile(this.storePath, { version: 1, entries: {} });
  }
}
