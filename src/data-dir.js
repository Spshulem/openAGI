// src/data-dir.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let cached = null;

/// Where the real install lives. Tests must never resolve here.
function liveDataDir() {
  return path.join(os.homedir(), ".openagi");
}

/// Are we inside `node --test`? The runner sets NODE_TEST_CONTEXT in every
/// test child ("child-v8"), which is the only signal available before any
/// test file has had a chance to configure anything.
function inTestRunner() {
  return Boolean(process.env.NODE_TEST_CONTEXT);
}

// Single source of truth for where OpenAGI keeps config + state.
// Default is an ABSOLUTE ~/.openagi so it never depends on the process's
// current working directory (which differs between `npm run serve`, the
// .app, launchd, and re-clones — the cause of "my keys got wiped").
// OPENAGI_DATA_DIR overrides it (Docker sets /data; the Mac app sets ~/.openagi).
export function resolveDataDir() {
  if (cached !== null) return cached;
  const override = process.env.OPENAGI_DATA_DIR;
  const trimmed = override && override.trim();
  if (trimmed) {
    cached = path.resolve(trimmed);
    return cached;
  }
  // GUARD: under `node --test`, the default must NEVER be the real install.
  //
  // This is not hypothetical. A test that builds a runtime without passing a
  // dataDir used to land here and operate on the user's live ~/.openagi —
  // running the suite rewrote 26 real tasks (10 agent tasks flipped out of
  // in_progress, stale-markers stamped onto 16 user tasks) and appended 162
  // events to the real logs. Nothing in the test was doing anything exotic;
  // the default was simply the live directory.
  //
  // A throw would be the loudest answer but would fail every existing test
  // that relies on the default, so tests are REDIRECTED to an isolated
  // per-process directory and told about it once. Set
  // OPENAGI_STRICT_TEST_DATA_DIR=1 to make it a hard error instead — CI should,
  // so a test that forgets its dataDir is caught rather than quietly isolated.
  if (inTestRunner()) {
    if (process.env.OPENAGI_STRICT_TEST_DATA_DIR === "1") {
      throw new Error(
        "resolveDataDir(): a test resolved the DEFAULT data dir, which is the live " +
        `install at ${liveDataDir()}. Pass an explicit dataDir (or set OPENAGI_DATA_DIR ` +
        "to a temp dir) for this runtime. See src/data-dir.js."
      );
    }
    cached = fs.mkdtempSync(path.join(os.tmpdir(), `openagi-test-${process.pid}-`));
    warnRedirect(cached);
    return cached;
  }
  cached = liveDataDir();
  return cached;
}

let warned = false;
function warnRedirect(dir) {
  if (warned) return;
  warned = true;
  console.warn(
    `[openagi] test runtime asked for the default data dir; redirected to ${dir} ` +
    "so the live ~/.openagi is not touched. Pass an explicit dataDir to silence this."
  );
}

// Test seam: drop the memoized value after mutating env in tests.
export function _resetDataDirCache() {
  cached = null;
}
