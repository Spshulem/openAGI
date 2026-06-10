// test/data-dir.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { resolveDataDir, _resetDataDirCache } from "../src/data-dir.js";

test("defaults to ~/.openagi when OPENAGI_DATA_DIR is unset", () => {
  const prev = process.env.OPENAGI_DATA_DIR;
  delete process.env.OPENAGI_DATA_DIR;
  _resetDataDirCache();
  assert.equal(resolveDataDir(), path.join(os.homedir(), ".openagi"));
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
  _resetDataDirCache();
  assert.equal(resolveDataDir(), path.join(os.homedir(), ".openagi"));
  if (prev !== undefined) process.env.OPENAGI_DATA_DIR = prev; else delete process.env.OPENAGI_DATA_DIR;
  _resetDataDirCache();
});
