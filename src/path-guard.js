// src/path-guard.js
//
// One place to turn "a string that came from outside" into "a path we are
// willing to open". Every sink this guards had the same shape:
//
//     path.join(<someDir>, `${idFromUrl}.json`)
//
// with the id taken from a route whose regex was `[^/]+`. That regex does NOT
// mean "one path segment": `url.pathname` keeps percent-encoding, so
// `..%2F..%2F..%2Fvictim` matches `[^/]+`, and the handler then calls
// decodeURIComponent on it before joining. The join happily walks out of the
// directory and the caller reads / rewrites / unlinks whatever it lands on.
//
// The fix is deliberately two independent checks, because each one alone has
// known bypasses:
//
//   1. An allowlist on the decoded segment. Nothing outside [A-Za-z0-9._-]
//      (plus spaces for user-chosen labels) survives, which rules out `/`,
//      `\`, NUL, a second round of percent-encoding, and non-ASCII dot
//      lookalikes such as U+FF0E FULLWIDTH FULL STOP or U+2024 ONE DOT LEADER
//      that some normalizers fold back to ".".
//   2. A containment assertion on the RESOLVED path. Note the trailing
//      separator: a bare `full.startsWith(base)` accepts `/data/auth-evil/x`
//      for base `/data/auth`, because the sibling directory shares a prefix.
//
// What this does NOT guarantee: the resolved path is not re-checked after
// following symlinks, so a symlink already planted inside the base directory
// by some other write primitive still points wherever it points. Containment
// here is lexical.

import path from "node:path";

export class PathGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = "PathGuardError";
    this.code = "UNSAFE_PATH";
  }
}

/// Ids and file stems this codebase generates itself (`sug_…`, `prop_…`,
/// `ses_…`, `act_…`, triage pass ids). No spaces.
export const STRICT_SEGMENT = /^[A-Za-z0-9._-]{1,64}$/;

/// User-chosen display names that double as file stems. MCP server names have
/// always permitted spaces — the live install has `buildbetter staging.json`
/// in <dataDir>/mcp/auth — so rejecting spaces here would break clear-auth for
/// real servers. A space is not a path separator on any platform we target.
export const LABEL_SEGMENT = /^[A-Za-z0-9._ -]{1,64}$/;

/// Is `value` a single, separator-free name we can safely join?
export function isSafeSegment(value, pattern = STRICT_SEGMENT) {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  if (value.includes("\0")) return false;
  // Leading/trailing whitespace is never meaningful in a name we generate and
  // makes " .." style probes harder to reason about — reject outright.
  if (value !== value.trim()) return false;
  // "." / ".." / "..." — a name made only of dots is never a legitimate stem.
  if (/^\.+$/.test(value)) return false;
  return pattern.test(value);
}

/// Throw unless `candidatePath` resolves strictly INSIDE `baseDir`.
/// Exported separately so it can be tested against the sibling-prefix bypass
/// without going through the allowlist first.
export function assertContained(baseDir, candidatePath, label = "path") {
  const base = path.resolve(baseDir);
  const full = path.resolve(candidatePath);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (!full.startsWith(prefix)) {
    throw new PathGuardError(`${label} escapes its directory`);
  }
  return full;
}

/// Validate every segment, then join and assert containment. Returns the
/// absolute path. Throws PathGuardError on anything suspicious.
export function safeJoin(baseDir, segments, { pattern = STRICT_SEGMENT, label = "path segment" } = {}) {
  const parts = Array.isArray(segments) ? segments : [segments];
  if (parts.length === 0) throw new PathGuardError(`${label}: nothing to join`);
  for (const seg of parts) {
    if (!isSafeSegment(seg, pattern)) {
      const shown = typeof seg === "string" ? seg.slice(0, 64) : String(seg);
      throw new PathGuardError(`${label} ${JSON.stringify(shown)} is not an allowed name`);
    }
  }
  const base = path.resolve(baseDir);
  return assertContained(base, path.resolve(base, ...parts), label);
}

/// Non-throwing form for call sites whose contract is "return null when the
/// id doesn't resolve to a file we own".
export function safeJoinOrNull(baseDir, segments, options) {
  try {
    return safeJoin(baseDir, segments, options);
  } catch {
    return null;
  }
}
