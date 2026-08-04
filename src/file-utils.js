import fs from "node:fs";
import path from "node:path";

// ─── Data at rest is owner-only ───────────────────────────────────────────
//
// Everything under the data dir is private user state: screen OCR, iMessage-
// derived content, session transcripts, memory, tasks, scheduled prompts.
// ensureDir used to take mkdir's default (0777 & ~umask = 0755 on a normal
// machine), so on a shared Mac or a multi-account Linux box every other local
// account could traverse ~/.openagi and read whatever it found.
//
// The directory mode is the load-bearing one — without the traverse bit
// nothing below is reachable by path — but the file mode matters too, because
// files leave their directory: a backup, an rsync, a tar all preserve modes.
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/// Create `dir` (and any missing parents) owner-only.
///
/// NOTE mkdir applies `mode` only to directories it actually creates; a
/// directory that already exists is left exactly as it is. That is deliberate
/// and depended on — SkillRegistry.reload() ensureDir's the BUNDLED skills
/// directory (examples/skills, shipped inside the repo and the Docker image),
/// which is not ours to re-permission. Existing state under the data dir is
/// tightened by hardenDataDir() at boot instead.
export function ensureDir(dir, mode = DIR_MODE) {
  fs.mkdirSync(dir, { recursive: true, mode });
}

/// Best-effort "make this file owner-only". For files this process does not
/// create through writeTextAtomic/appendJsonLine, which already pass a mode —
/// in practice the SQLite databases, which node:sqlite creates with the process
/// umask (0644) and which hold the screen-OCR corpus and the session-transcript
/// index. Must be called on the database path, not the sidecars: SQLite gives
/// its journal/WAL files the same mode as the database itself.
///
/// Returns false rather than throwing: a store that cannot be re-permissioned
/// is still a working store, and the boot-time hardenDataDir() pass will retry.
export function chmodOwnerOnly(filePath, mode = FILE_MODE) {
  try {
    fs.chmodSync(filePath, mode);
    return true;
  } catch {
    return false;
  }
}

// Bound on the boot-time walk. A synchronous, unbounded traversal in the
// startup path is an availability risk for an always-on daemon; a partly
// tightened install plus a warning beats a boot that never finishes.
const HARDEN_MAX_ENTRIES = 200_000;

/// Tighten an existing data dir in place: 0700 directories, 0600 files.
/// Creates `dataDir` (owner-only) if it isn't there yet. Returns a summary
/// { dirs, files, skipped, failed } and never throws.
///
/// WHY tighten what is already on disk, rather than only getting new state
/// right: every install that predates this has 0755 directories and 0644
/// files, including observations/index.db — the screen-OCR corpus, which is
/// routinely the largest file in the install. A creation-time-only fix would
/// leave that exposed for the life of the install, which is to say: it would
/// fix nothing at all for anyone who already uses the product.
///
/// It is still someone else's data, so the pass is deliberately timid:
///   * mode bits only — nothing is read, written, moved, renamed or deleted;
///   * lstat, never stat: symlinks are skipped rather than followed, so a link
///     inside the data dir cannot be used to chmod something outside it, and
///     there are no traversal cycles to guard against;
///   * entries owned by another uid are skipped — not ours to change, and the
///     chmod would fail anyway (bind-mounted volumes, Docker uid mismatches);
///   * every chmod and readdir is individually guarded and the whole pass is
///     best-effort: a data dir we cannot fully read must never stop the daemon
///     from booting;
///   * idempotent — an entry already at the target mode is not touched, so the
///     second boot is lstat-only and reports zero changes.
export function hardenDataDir(dataDir, { log = console.log, warn = console.warn } = {}) {
  const result = { dirs: 0, files: 0, skipped: 0, failed: 0, truncated: false };
  if (!dataDir) return result;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  let seen = 0;

  // Returns the lstat when the caller may descend into `target`, else null.
  const tighten = (target, wantMode) => {
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch {
      result.failed += 1;
      return null;
    }
    if (stat.isSymbolicLink()) {
      result.skipped += 1;
      return null;
    }
    if (uid !== null && stat.uid !== uid) {
      result.skipped += 1;
      return null; // not ours: don't chmod it, don't walk into it
    }
    if ((stat.mode & 0o777) !== wantMode) {
      try {
        fs.chmodSync(target, wantMode);
        if (stat.isDirectory()) result.dirs += 1;
        else result.files += 1;
      } catch {
        result.failed += 1;
      }
    }
    return stat;
  };

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      result.failed += 1;
      return;
    }
    for (const entry of entries) {
      if (seen >= HARDEN_MAX_ENTRIES) {
        result.truncated = true;
        return;
      }
      seen += 1;
      // Dirent flags come from lstat semantics, so a symlink reports
      // isSymbolicLink() and never isDirectory(); tighten() re-checks anyway.
      const full = path.join(dir, entry.name);
      const stat = tighten(full, entry.isDirectory() ? DIR_MODE : FILE_MODE);
      if (stat?.isDirectory()) walk(full);
    }
  };

  try {
    ensureDir(dataDir);
    tighten(dataDir, DIR_MODE);
    walk(dataDir);
  } catch (error) {
    warn(`[openagi] could not tighten permissions under ${dataDir}: ${error?.message ?? error}`);
    return result;
  }

  if (result.dirs || result.files) {
    log(
      `[openagi] tightened ${result.dirs} director${result.dirs === 1 ? "y" : "ies"} to 0700 and ` +
      `${result.files} file${result.files === 1 ? "" : "s"} to 0600 under ${dataDir} — this data ` +
      "(screen OCR, message content, transcripts) was readable by other local accounts."
    );
  }
  if (result.failed) {
    warn(
      `[openagi] ${result.failed} entr${result.failed === 1 ? "y" : "ies"} under ${dataDir} could not be ` +
      "read or re-permissioned and may still be readable by other local accounts. Continuing."
    );
  }
  if (result.truncated) {
    warn(
      `[openagi] stopped tightening permissions after ${HARDEN_MAX_ENTRIES} entries under ${dataDir}; ` +
      "the rest was left as-is so startup could finish."
    );
  }
  return result;
}

export function safeFilename(value) {
  return String(value ?? "default")
    .trim()
    .replaceAll(":", "_")
    .replaceAll("/", "_")
    .replaceAll("\\", "_")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

// ─── Unusable-file quarantine ─────────────────────────────────────────────
//
// One bad byte used to permanently kill the always-on daemon, silently.
// readJsonFile did JSON.parse(readFileSync(p)) and forgave only ENOENT, so a
// snapshot truncated by a crash threw out of the store constructor, out of the
// runtime constructor, out of startServer. The daemon logged
// "Expected ',' or '}' ..." — with NO FILENAME — and exited 0, which
// launchd (KeepAlive/SuccessfulExit=false) reads as a clean, intentional stop:
// it never restarted. And the JSONL replay that TaskStore / ComputerUseLog /
// PendingActionStore already implement was unreachable, because the snapshot
// read threw before replay could run.
//
// So an unusable file is moved aside instead — never deleted — and the caller
// gets its fallback, which is exactly what lets that replay run. Three rules:
//   * the bytes are preserved under a timestamped name, for inspection;
//   * every message names the path, because a parser error alone is
//     unactionable;
//   * a TRANSIENT failure (a passing fd shortage, an I/O blip) is NOT treated
//     as corruption — quarantining then would destroy the very snapshot we are
//     trying to protect. Those rethrow, and the startup guard in boot.js turns
//     them into a non-zero exit so the supervisor simply retries.

// "The machine momentarily could not read", not "this file is garbage".
const TRANSIENT_READ_ERRORS = new Set([
  "EMFILE", "ENFILE", "EAGAIN", "EINTR", "EBUSY", "EIO", "ENOMEM",
  "ENOSPC", "ETIMEDOUT", "ESTALE", "ENXIO", "EDEADLK", "ECONNRESET"
]);

/// missing | corrupt | unreadable | transient. Pure, so it is unit-testable.
/// Anything we do not positively recognise as a file-specific errno is treated
/// as transient: an unknown error must never be a reason to move user data.
export function classifyReadFailure(error) {
  if (error?.code === "ENOENT") return "missing";
  if (error instanceof SyntaxError) return "corrupt";
  const code = typeof error?.code === "string" ? error.code : null;
  if (!code || TRANSIENT_READ_ERRORS.has(code)) return "transient";
  return /^E[A-Z]+$/.test(code) ? "unreadable" : "transient";
}

/// Move a file out of the way, preserving its bytes under a timestamped name.
/// Returns the new path. Never overwrites an existing quarantine.
export function quarantineFile(filePath) {
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  let target = `${filePath}.corrupt-${stamp}`;
  for (let n = 1; fs.existsSync(target); n += 1) target = `${filePath}.corrupt-${stamp}-${n}`;
  fs.renameSync(filePath, target);
  return target;
}

/// An error that names the file it came from. JSON.parse's own message does
/// not, and "Expected ',' or '}' at position 400" with no path is unactionable
/// in a daemon log.
function namedReadError(filePath, error, kind) {
  const err = new Error(`openagi: cannot read ${filePath} (${kind}): ${error?.message ?? error}`, { cause: error });
  err.code = error?.code;
  err.path = filePath;
  err.kind = kind;
  return err;
}

/// Read + parse a JSON file. A file that does not exist, or whose contents are
/// unusable, yields `fallback` — the unusable one is quarantined first, so the
/// bytes survive and the caller's own recovery (JSONL replay, defaults) runs.
/// Pass { quarantine: false } to get the strict old behaviour: throw instead,
/// with an error that names the path.
export function readJsonFile(filePath, fallback = null, { quarantine = true } = {}) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return recoverUnusableFile(filePath, error, fallback, quarantine);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return recoverUnusableFile(filePath, error, fallback, quarantine);
  }
}

function recoverUnusableFile(filePath, error, fallback, quarantine) {
  const kind = classifyReadFailure(error);
  if (kind === "missing") return fallback;
  // Transient, or the caller asked for strictness: do NOT touch the file.
  // boot.js turns a throw during startup into a non-zero exit, so a supervised
  // daemon retries rather than being read as a clean stop.
  if (kind === "transient" || !quarantine) throw namedReadError(filePath, error, kind);

  const why = `${kind}: ${error?.message ?? error}`;
  let moved = null;
  let moveError = null;
  try { moved = quarantineFile(filePath); } catch (e) { moveError = e; }
  if (moved) {
    console.warn(
      `[openagi] ${filePath} is unusable (${why}) — moved to ${moved} and continuing from the ` +
      "event log / defaults. Nothing was deleted; inspect or restore that file."
    );
  } else {
    console.warn(
      `[openagi] ${filePath} is unusable (${why}) and could NOT be moved aside ` +
      `(${moveError?.message ?? moveError}) — continuing from the event log / defaults. ` +
      "Fix that file or its directory permissions."
    );
  }
  return fallback;
}

export function writeJsonAtomic(filePath, value, mode = 0o600) {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function writeTextAtomic(filePath, data, mode = 0o600) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, data, { mode });
  const fd = fs.openSync(tempPath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, filePath);
}

export function appendJsonLine(filePath, value, mode = 0o600) {
  ensureDir(path.dirname(filePath));
  const line = `${JSON.stringify(value)}\n`;
  const fd = fs.openSync(filePath, "a", mode);
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function loadEnvFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }

  const loaded = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
    loaded[key] = value;
  }
  return loaded;
}
