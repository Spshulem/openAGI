// test/data-dir-test-guard.test.js
// The test suite must never be able to operate on the user's real install.
//
// This is a regression test for something that actually happened: a runtime
// built without an explicit dataDir resolved to the default, the default was
// ~/.openagi, and running `node --test` rewrote 26 real tasks and appended 162
// events to the live logs. The test doing it looked completely ordinary — it
// just did not pass a dataDir. That is the whole failure mode, so the guard
// belongs in resolveDataDir() rather than in any individual test's setup.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { resolveDataDir, _resetDataDirCache } from "../src/data-dir.js";

const LIVE = path.join(os.homedir(), ".openagi");

function fresh(env, fn) {
  const saved = { ...process.env };
  try {
    delete process.env.OPENAGI_DATA_DIR;
    delete process.env.OPENAGI_STRICT_TEST_DATA_DIR;
    Object.assign(process.env, env);
    _resetDataDirCache();
    return fn();
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    _resetDataDirCache();
  }
}

test("the premise: this file really is running under the node test runner", () => {
  assert.ok(
    process.env.NODE_TEST_CONTEXT,
    "NODE_TEST_CONTEXT is the signal the guard keys on; without it this file proves nothing"
  );
});

test("a test that forgets its dataDir is redirected away from the live install", () => {
  const dir = fresh({}, () => resolveDataDir());
  assert.notEqual(dir, LIVE, "the default under `node --test` must never be the real ~/.openagi");
  assert.ok(
    dir.startsWith(path.resolve(os.tmpdir())),
    `expected an isolated temp dir, got ${dir}`
  );
});

test("strict mode turns the same mistake into a hard error, for CI", () => {
  assert.throws(
    () => fresh({ OPENAGI_STRICT_TEST_DATA_DIR: "1" }, () => resolveDataDir()),
    /live install/,
    "OPENAGI_STRICT_TEST_DATA_DIR=1 must fail the test rather than silently isolating it"
  );
});

test("an explicit OPENAGI_DATA_DIR is still honoured verbatim", () => {
  const target = path.join(os.tmpdir(), "openagi-explicit-check");
  const dir = fresh({ OPENAGI_DATA_DIR: target }, () => resolveDataDir());
  assert.equal(dir, path.resolve(target), "an explicit override must win over the guard");
});

test("the guard is scoped to the test runner and does not change production behaviour", () => {
  // Simulating "not a test" in-process is the only way to pin this without
  // spawning; the guard reads the env var on every uncached call.
  const dir = fresh({ NODE_TEST_CONTEXT: "" }, () => resolveDataDir());
  assert.equal(dir, LIVE, "outside the test runner the default must remain the real install");
});
