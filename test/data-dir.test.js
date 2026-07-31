// test/data-dir.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { resolveDataDir, _resetDataDirCache } from "../src/data-dir.js";

// The two tests below assert PRODUCTION behaviour — that the default is the
// real ~/.openagi. Inside `node --test` that default is deliberately
// unreachable: resolveDataDir() redirects to an isolated temp dir so a test
// that forgets its dataDir cannot operate on the user's live install (see the
// guard in src/data-dir.js and test/data-dir-test-guard.test.js). So these
// tests have to drop the runner's marker to observe the production path.
// Everything else here exercises an explicit override, which the guard never
// touches, and needs no such treatment.
function asProduction(fn) {
  const marker = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    _resetDataDirCache();
    return fn();
  } finally {
    if (marker !== undefined) process.env.NODE_TEST_CONTEXT = marker;
    _resetDataDirCache();
  }
}

test("defaults to ~/.openagi when OPENAGI_DATA_DIR is unset", () => {
  const prev = process.env.OPENAGI_DATA_DIR;
  delete process.env.OPENAGI_DATA_DIR;
  asProduction(() => {
    assert.equal(resolveDataDir(), path.join(os.homedir(), ".openagi"));
  });
  if (prev !== undefined) process.env.OPENAGI_DATA_DIR = prev;
  _resetDataDirCache();
});

test("honors OPENAGI_DATA_DIR as an absolute path", () => {
  const prev = process.env.OPENAGI_DATA_DIR;
  process.env.OPENAGI_DATA_DIR = "/tmp/openagi-test";
  _resetDataDirCache();
  assert.equal(resolveDataDir(), "/tmp/openagi-test");
  if (prev !== undefined) process.env.OPENAGI_DATA_DIR = prev; else delete process.env.OPENAGI_DATA_DIR;
  _resetDataDirCache();
});

test("resolves a relative OPENAGI_DATA_DIR to absolute", () => {
  const prev = process.env.OPENAGI_DATA_DIR;
  process.env.OPENAGI_DATA_DIR = "rel-data";
  _resetDataDirCache();
  assert.equal(resolveDataDir(), path.resolve("rel-data"));
  if (prev !== undefined) process.env.OPENAGI_DATA_DIR = prev; else delete process.env.OPENAGI_DATA_DIR;
  _resetDataDirCache();
});

test("treats an empty or whitespace OPENAGI_DATA_DIR as unset", () => {
  const prev = process.env.OPENAGI_DATA_DIR;
  process.env.OPENAGI_DATA_DIR = "   ";
  asProduction(() => {
    assert.equal(resolveDataDir(), path.join(os.homedir(), ".openagi"));
  });
  if (prev !== undefined) process.env.OPENAGI_DATA_DIR = prev; else delete process.env.OPENAGI_DATA_DIR;
  _resetDataDirCache();
});
