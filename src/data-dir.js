// src/data-dir.js
import os from "node:os";
import path from "node:path";

let cached = null;

// Single source of truth for where OpenAGI keeps config + state.
// Default is an ABSOLUTE ~/.openagi so it never depends on the process's
// current working directory (which differs between `npm run serve`, the
// .app, launchd, and re-clones — the cause of "my keys got wiped").
// OPENAGI_DATA_DIR overrides it (Docker sets /data; the Mac app sets ~/.openagi).
export function resolveDataDir() {
  if (cached !== null) return cached;
  const override = process.env.OPENAGI_DATA_DIR;
  const trimmed = override && override.trim();
  cached = trimmed ? path.resolve(trimmed) : path.join(os.homedir(), ".openagi");
  return cached;
}

// Test seam: drop the memoized value after mutating env in tests.
export function _resetDataDirCache() {
  cached = null;
}
