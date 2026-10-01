import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderWizard, saveEnv } from "../src/setup-wizard.js";
import { createDefaultRuntime } from "../src/abi-runtime.js";

test("setup wizard presents Codex ChatGPT as distinct from OpenAI API key and persists only non-secret settings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-codex-setup-"));
  const html = renderWizard({
    dataDir: dir,
    existingEnv: {
      OPENAGI_PROVIDER: "openai-codex",
      OPENAGI_CODEX_BIN: "/opt/codex/bin/codex",
      OPENAGI_CODEX_SHA256: "a".repeat(64),
      OPENAGI_CODEX_FALLBACK_PROVIDER: "none",
      OPENAGI_CODEX_MODEL: "gpt-test",
      OPENAGI_CODEX_REASONING_EFFORT: "medium"
    }
  });
  assert.match(html, /value="openai-codex"[^>]*checked/);
  assert.match(html, /Sign in with ChatGPT/i);
  assert.match(html, /separate from <code>OPENAGI_AUTH_TOKEN<\/code>/i);
  assert.match(html, /OPENAGI_CODEX_MODEL/);
  assert.match(html, /OPENAGI_CODEX_BIN/);
  assert.match(html, /OPENAGI_CODEX_SHA256/);
  assert.match(html, /name="OPENAGI_CODEX_FALLBACK_PROVIDER"/);
  assert.match(html, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(html, /name="CODEX_HOME"/);

  const saved = saveEnv({
    dataDir: dir,
    values: {
      OPENAGI_PROVIDER: "openai-codex",
      OPENAGI_CODEX_BIN: "/opt/codex/bin/codex",
      OPENAGI_CODEX_SHA256: "b".repeat(64),
      OPENAGI_CODEX_MODEL: "gpt-test",
      OPENAGI_CODEX_REASONING_EFFORT: "medium",
      OPENAGI_CODEX_CAPABILITY_TIER: "chat-only",
      OPENAGI_CODEX_FALLBACK_PROVIDER: "openai",
      CODEX_HOME: "/must/not/persist",
      OPENAI_ACCESS_TOKEN: "must-not-persist"
    }
  });
  assert.deepEqual(saved.keys.filter((key) => key.startsWith("OPENAGI_CODEX")), [
    "OPENAGI_CODEX_BIN",
    "OPENAGI_CODEX_CAPABILITY_TIER",
    "OPENAGI_CODEX_FALLBACK_PROVIDER",
    "OPENAGI_CODEX_MODEL",
    "OPENAGI_CODEX_REASONING_EFFORT",
    "OPENAGI_CODEX_SHA256"
  ]);
  const written = fs.readFileSync(path.join(dir, ".env"), "utf8");
  assert.doesNotMatch(written, /CODEX_HOME|ACCESS_TOKEN|must-not-persist|must\/not\/persist/);
});

test("Codex runtime uses the caller's data directory for its dedicated profile", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-codex-runtime-"));
  const runtime = createDefaultRuntime({
    dataDir,
    autoConnectMcp: false,
    modelProviderOptions: { preferred: "openai-codex", codexFallback: "none" }
  });
  assert.equal(runtime.agentHost.modelProvider.client.codexHome, path.join(dataDir, "codex"));
});
