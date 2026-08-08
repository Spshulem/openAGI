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
  const previous = {
    dataDir: process.env.OPENAGI_DATA_DIR,
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    openaiModel: process.env.OPENAI_MODEL,
    reasoningEffort: process.env.OPENAI_REASONING_EFFORT
  };
  process.env.OPENAGI_DATA_DIR = tmp;
  _resetDataDirCache();

  assert.equal(envFilePath(), path.join(tmp, ".env"));
  saveEnv({
    values: {
      ANTHROPIC_API_KEY: "sk-test-123",
      OPENAI_MODEL: "gpt-5.6-luna",
      OPENAI_REASONING_EFFORT: "high"
    }
  });

  const onDisk = fs.readFileSync(path.join(tmp, ".env"), "utf8");
  assert.match(onDisk, /ANTHROPIC_API_KEY=sk-test-123/);
  assert.match(onDisk, /OPENAI_MODEL=gpt-5\.6-luna/);
  assert.match(onDisk, /OPENAI_REASONING_EFFORT=high/);
  assert.equal(process.env.OPENAI_MODEL, "gpt-5.6-luna");
  assert.equal(process.env.OPENAI_REASONING_EFFORT, "high");

  if (previous.dataDir !== undefined) process.env.OPENAGI_DATA_DIR = previous.dataDir; else delete process.env.OPENAGI_DATA_DIR;
  _resetDataDirCache();
  if (previous.anthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = previous.anthropicKey; else delete process.env.ANTHROPIC_API_KEY;
  if (previous.openaiModel !== undefined) process.env.OPENAI_MODEL = previous.openaiModel; else delete process.env.OPENAI_MODEL;
  if (previous.reasoningEffort !== undefined) process.env.OPENAI_REASONING_EFFORT = previous.reasoningEffort; else delete process.env.OPENAI_REASONING_EFFORT;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("envFilePath() returns absolute ~/.openagi/.env when OPENAGI_DATA_DIR is unset", () => {
  const prev = process.env.OPENAGI_DATA_DIR;
  delete process.env.OPENAGI_DATA_DIR;
  // This asserts PRODUCTION behaviour, and under `node --test` the default data
  // dir is deliberately redirected to a temp dir so a test cannot touch the
  // user's live install (src/data-dir.js). Drop the runner's marker to see the
  // real default.
  const marker = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    _resetDataDirCache();
    assert.equal(envFilePath(), path.join(os.homedir(), ".openagi", ".env"));
  } finally {
    if (marker !== undefined) process.env.NODE_TEST_CONTEXT = marker;
  }
  if (prev !== undefined) process.env.OPENAGI_DATA_DIR = prev;
  _resetDataDirCache();
});
