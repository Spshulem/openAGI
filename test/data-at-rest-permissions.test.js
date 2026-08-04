// test/data-at-rest-permissions.test.js
//
// The data dir is the most sensitive thing this project owns: screen OCR
// (observations/index.db), iMessage-derived content, session transcripts,
// memory and task state. ensureDir() created every directory under it with the
// default 0777 & ~umask — 0755 on a normal machine — so any other local account
// could `cd` in and read whatever it found. Files were inconsistent: the JSON /
// JSONL writers already passed mode 0600, but SQLite creates its database (and
// its -wal / -shm sidecars) 0644, and any file written before the mode argument
// existed is still 0644 on disk today.
//
// Two properties are pinned here:
//   1. NEW state is owner-only from creation — 0700 dirs, 0600 files.
//   2. EXISTING installs are tightened in place on boot, because a fix that
//      only covers fresh installs would leave a multi-gigabyte screen-OCR
//      corpus world-readable forever.
//
// (2) mutates the user's files, so the tightening pass is also tested for the
// things that make it safe: it changes mode bits and nothing else, it never
// follows a symlink out of the data dir, and it survives a directory it cannot
// read instead of taking the daemon down with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureDir, hardenDataDir, DIR_MODE, FILE_MODE } from "../src/file-utils.js";

const mode = (p) => fs.lstatSync(p).mode & 0o777;
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test("ensureDir creates directories owner-only", () => {
  const root = tmp("perm-ensuredir-");
  const nested = path.join(root, "observations", "frames");
  ensureDir(nested);

  assert.equal(mode(nested), DIR_MODE, "the leaf directory must be 0700");
  assert.equal(
    mode(path.join(root, "observations")),
    DIR_MODE,
    "intermediate directories created by the same recursive mkdir must be 0700 too — " +
    "a 0755 parent lets another account list and traverse it"
  );
});

test("ensureDir leaves a directory that already exists alone", () => {
  // mkdir does not chmod an existing directory, and it must not: the bundled
  // skills directory (examples/skills, shipped inside the repo and the Docker
  // image) is ensureDir'd on every SkillRegistry.reload().
  const root = tmp("perm-existing-");
  const dir = path.join(root, "bundled");
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755); // defeat umask so the precondition is exact
  ensureDir(dir);
  assert.equal(mode(dir), 0o755, "ensureDir must not silently re-permission a pre-existing directory");
});

test("hardenDataDir tightens an install that is already 0755/0644", () => {
  const root = tmp("perm-harden-");
  const obs = path.join(root, "observations");
  fs.mkdirSync(obs, { recursive: true });
  fs.chmodSync(root, 0o755);
  fs.chmodSync(obs, 0o755);

  // Exactly what node:sqlite leaves behind: the DB and its write-ahead log.
  const db = path.join(obs, "index.db");
  const wal = path.join(obs, "index.db-wal");
  fs.writeFileSync(db, "sqlite-ish", { mode: 0o644 });
  fs.writeFileSync(wal, "wal-ish", { mode: 0o644 });
  fs.chmodSync(db, 0o644);
  fs.chmodSync(wal, 0o644);

  const result = hardenDataDir(root, { log: () => {}, warn: () => {} });

  assert.equal(mode(root), DIR_MODE, "the data dir itself must end up 0700");
  assert.equal(mode(obs), DIR_MODE, "sub-directories must end up 0700");
  assert.equal(mode(db), FILE_MODE, "the OCR database must end up 0600");
  assert.equal(mode(wal), FILE_MODE, "the -wal sidecar holds recent rows and must end up 0600 too");
  assert.equal(result.dirs, 2);
  assert.equal(result.files, 2);
  assert.equal(result.failed, 0);
});

test("hardenDataDir is idempotent — a second boot changes nothing", () => {
  const root = tmp("perm-idem-");
  fs.mkdirSync(path.join(root, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(root, "tasks", "user.jsonl"), "{}\n", { mode: 0o644 });
  fs.chmodSync(path.join(root, "tasks", "user.jsonl"), 0o644);

  const first = hardenDataDir(root, { log: () => {}, warn: () => {} });
  assert.ok(first.dirs + first.files > 0, "the first pass must actually change something");

  const second = hardenDataDir(root, { log: () => {}, warn: () => {} });
  assert.equal(second.dirs, 0, "an already-tightened install must not be re-chmod'ed");
  assert.equal(second.files, 0, "an already-tightened install must not be re-chmod'ed");
  assert.equal(second.failed, 0);
});

test("hardenDataDir preserves file contents and mtime ordering — mode bits only", () => {
  const root = tmp("perm-content-");
  const file = path.join(root, "memory-state.json");
  fs.writeFileSync(file, '{"keep":"me"}', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  const before = fs.readFileSync(file, "utf8");
  const size = fs.statSync(file).size;

  hardenDataDir(root, { log: () => {}, warn: () => {} });

  assert.equal(fs.readFileSync(file, "utf8"), before, "contents must be untouched");
  assert.equal(fs.statSync(file).size, size, "nothing may be rewritten or truncated");
  assert.equal(mode(file), FILE_MODE);
});

test("hardenDataDir does not chmod through a symlink that escapes the data dir", () => {
  const root = tmp("perm-symlink-");
  const outside = tmp("perm-outside-");
  const victim = path.join(outside, "someone-elses-file");
  fs.writeFileSync(victim, "not ours", { mode: 0o644 });
  fs.chmodSync(victim, 0o644);
  fs.symlinkSync(victim, path.join(root, "link-out"));

  const outsideDir = path.join(outside, "someone-elses-dir");
  fs.mkdirSync(outsideDir);
  fs.chmodSync(outsideDir, 0o755);
  fs.symlinkSync(outsideDir, path.join(root, "dir-link-out"));

  const result = hardenDataDir(root, { log: () => {}, warn: () => {} });

  assert.equal(mode(victim), 0o644, "a symlinked file outside the data dir must not be chmod'ed");
  assert.equal(mode(outsideDir), 0o755, "a symlinked directory outside the data dir must not be chmod'ed or walked");
  assert.ok(result.skipped >= 2, "both symlinks must be reported as skipped");
});

test("a directory whose own mode blocks the walk is repaired, then walked", () => {
  // We own it, so "unreadable" is a state we can and should fix: chmod to 0700
  // first, then descend. Pinning this because the obvious implementation order
  // (readdir, then chmod) would silently skip the subtree instead.
  const root = tmp("perm-unreadable-");
  const locked = path.join(root, "locked");
  fs.mkdirSync(locked);
  const inner = path.join(locked, "inner.json");
  fs.writeFileSync(inner, "{}", { mode: 0o644 });
  fs.chmodSync(inner, 0o644);
  fs.chmodSync(locked, 0o000);
  try {
    const result = hardenDataDir(root, { log: () => {}, warn: () => {} });
    assert.equal(mode(locked), DIR_MODE);
    assert.equal(mode(inner), FILE_MODE, "the contents of a repaired directory must be tightened too");
    assert.equal(result.failed, 0);
  } finally {
    fs.chmodSync(locked, 0o700); // so the temp dir can be cleaned up
  }
});

test("hardenDataDir never throws when it cannot even create the data dir", () => {
  // The startup path calls this before anything is listening, so a throw here
  // would be a boot failure. Simulate the read-only-parent case.
  const parent = tmp("perm-readonly-parent-");
  fs.chmodSync(parent, 0o500);
  const warnings = [];
  try {
    let result;
    assert.doesNotThrow(() => {
      result = hardenDataDir(path.join(parent, "openagi"), { log: () => {}, warn: (m) => warnings.push(m) });
    }, "a data dir the daemon cannot create must never abort startup");
    assert.ok(result, "a summary must still come back");
    assert.equal(warnings.length, 1, "the failure must be reported once, not swallowed silently");
  } finally {
    fs.chmodSync(parent, 0o700);
  }
});

test("hardenDataDir creates the data dir owner-only when it does not exist yet", () => {
  const root = path.join(tmp("perm-fresh-"), "nested", ".openagi");
  hardenDataDir(root, { log: () => {}, warn: () => {} });
  assert.equal(mode(root), DIR_MODE, "a first-run install must get a 0700 data dir, not 0755");
});

test("a real boot leaves the whole data dir owner-only, SQLite included", async (t) => {
  const dataDir = tmp("perm-boot-");
  // Pre-create the state a pre-fix install would have on disk.
  fs.chmodSync(dataDir, 0o755);
  const stale = path.join(dataDir, "agent-host");
  fs.mkdirSync(stale, { recursive: true });
  fs.chmodSync(stale, 0o755);
  fs.writeFileSync(path.join(stale, "session-index.jsonl"), "", { mode: 0o644 });
  fs.chmodSync(path.join(stale, "session-index.jsonl"), 0o644);

  const savedEnv = {
    dataDir: process.env.OPENAGI_DATA_DIR,
    host: process.env.HOST,
    port: process.env.PORT,
    token: process.env.OPENAGI_AUTH_TOKEN
  };
  process.env.OPENAGI_DATA_DIR = dataDir;
  process.env.HOST = "127.0.0.1";
  process.env.PORT = "0";
  delete process.env.OPENAGI_AUTH_TOKEN;

  const { _resetDataDirCache } = await import("../src/data-dir.js");
  _resetDataDirCache();
  const { startServer } = await import("../src/boot.js");
  const started = await startServer();
  // The SQLite stores open asynchronously; wait for them so index.db exists.
  await started.runtime.sessionIndex?.ready;
  await started.runtime.observations?.ready;
  try {
    const loose = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        const m = mode(full);
        if (entry.isDirectory()) {
          if (m & 0o077) loose.push(`${full} ${m.toString(8)}`);
          walk(full);
        } else if (entry.isFile()) {
          if (m & 0o077) loose.push(`${full} ${m.toString(8)}`);
        }
      }
    };
    assert.equal(mode(dataDir) & 0o077, 0, `data dir itself is group/other accessible: ${mode(dataDir).toString(8)}`);
    walk(dataDir);
    assert.deepEqual(loose, [], `these entries are readable by other local accounts:\n${loose.join("\n")}`);
  } finally {
    await started.app.close?.();
    for (const [k, v] of Object.entries({
      OPENAGI_DATA_DIR: savedEnv.dataDir, HOST: savedEnv.host, PORT: savedEnv.port, OPENAGI_AUTH_TOKEN: savedEnv.token
    })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
