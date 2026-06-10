// test/env-persistence.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _resetDataDirCache } from "../src/data-dir.js";
import { envFilePath, saveEnv } from "../src/setup-wizard.js";

test("saveEnv writes under OPENAGI_DATA_DIR and survives a reload", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-env-"));
  const prev = process.env.OPENAGI_DATA_DIR;
  process.env.OPENAGI_DATA_DIR = tmp;
  _resetDataDirCache();

  assert.equal(envFilePath(), path.join(tmp, ".env"));
  saveEnv({ values: { ANTHROPIC_API_KEY: "sk-test-123" } });

  const onDisk = fs.readFileSync(path.join(tmp, ".env"), "utf8");
  assert.match(onDisk, /ANTHROPIC_API_KEY=sk-test-123/);

  if (prev !== undefined) process.env.OPENAGI_DATA_DIR = prev; else delete process.env.OPENAGI_DATA_DIR;
  _resetDataDirCache();
  delete process.env.ANTHROPIC_API_KEY;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("envFilePath() returns absolute ~/.openagi/.env when OPENAGI_DATA_DIR is unset", () => {
  const prev = process.env.OPENAGI_DATA_DIR;
  delete process.env.OPENAGI_DATA_DIR;
  _resetDataDirCache();
  assert.equal(envFilePath(), path.join(os.homedir(), ".openagi", ".env"));
  if (prev !== undefined) process.env.OPENAGI_DATA_DIR = prev;
  _resetDataDirCache();
});
