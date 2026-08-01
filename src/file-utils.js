import fs from "node:fs";
import path from "node:path";

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
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
