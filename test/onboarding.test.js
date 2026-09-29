// Onboarding polish: re-running /setup must not rotate the auth token or
// reset configured values, saved secrets are visibly marked, and /health
// exposes firstRun so the Mac app can walk a fresh install to the wizard.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderWizard, isFirstRun, saveEnv } from "../src/setup-wizard.js";
import { createDefaultRuntime, createHostedInterface } from "../src/index.js";

test("fresh wizard generates a token and uses defaults", () => {
  const html = renderWizard({ existingEnv: {} });
  assert.match(html, /auto-generated a strong one/);
  assert.match(html, /value="claude-sonnet-4-6"/);
  assert.match(html, /value="gpt-5"/);
  assert.ok(!html.includes("✓ saved"), "no saved markers on a fresh install");
});

test("wizard distinguishes host-owned ChatGPT OAuth from Codex-owned login and API-key billing", () => {
  const html = renderWizard({ existingEnv: {} });
  assert.match(html, /value="openai-chatgpt"/);
  assert.match(html, /value="openai-chatgpt"[^>]*disabled/);
  assert.match(html, /OPENAGI_CHATGPT_MODEL/);
  assert.match(html, /name="OPENAGI_CHATGPT_MODEL" value="" placeholder="Select an exact/);
  const enabled = renderWizard({ existingEnv: { OPENAGI_CHATGPT_ENABLED: "1" } });
  assert.match(enabled, /value="openai-chatgpt"(?![^>]*disabled)[^>]*>/);
  assert.match(html, /OPENAGI_CHATGPT_REASONING_EFFORT/);
  assert.match(html, /configured effort/i);
  assert.match(html, /Codex credentials are not read/i);
  assert.match(html, /OPENAGI_CHATGPT_CAPABILITY_TIER/);
  assert.match(html, /provisional-chat-only/);
  assert.match(html, /name="OPENAGI_CHATGPT_ENABLED" value="1"/);
  assert.match(html, /effective effort.*unknown/i);
  assert.match(html, /no OpenAGI or Codex tool effects/i);
});

test("wizard persists the explicit provisional ChatGPT OAuth opt-in", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-chatgpt-wizard-"));
  try {
    saveEnv({ dataDir, values: { OPENAGI_CHATGPT_ENABLED: "1" } });
    assert.match(fs.readFileSync(path.join(dataDir, ".env"), "utf8"), /^OPENAGI_CHATGPT_ENABLED=1$/m);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("re-run wizard keeps the existing auth token instead of rotating it", () => {
  const html = renderWizard({
    existingEnv: {
      OPENAGI_AUTH_TOKEN: "tok_existing_abc123",
      OPENAGI_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      ANTHROPIC_MODEL: "claude-opus-4-8",
      OPENAGI_DAILY_USD_LIMIT: "25",
      LINEAR_API_KEY: "lin_secret"
    }
  });
  assert.match(html, /tok_existing_abc123/, "existing token shown + submitted unchanged");
  assert.match(html, /existing<\/strong> dashboard token/, "copy explains it's the current token");
  // Prefill: provider radio, model, budget.
  assert.match(html, /value="anthropic" checked/);
  assert.match(html, /value="claude-opus-4-8"/);
  assert.match(html, /value="25" min="0.5"/);
  // Secrets never echo back, but their presence is visible.
  assert.ok(!html.includes("sk-ant-secret"), "secret values must not be echoed into the page");
  assert.ok(!html.includes("lin_secret"));
  const savedMarkers = html.match(/✓ saved/g) ?? [];
  assert.ok(savedMarkers.length >= 2, "ANTHROPIC_API_KEY and LINEAR_API_KEY show saved markers");
});

test("quick-save path exists after the auth step", () => {
  const html = renderWizard({ existingEnv: {} });
  assert.match(html, /Save now — set up the rest later/);
  assert.match(html, /minimum viable setup/);
});

test("/health exposes firstRun for the Mac app", async () => {
  const savedEnv = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY, t: process.env.OPENAGI_AUTH_TOKEN };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAGI_AUTH_TOKEN;
  const app = createHostedInterface(createDefaultRuntime(), { port: 0 });
  const address = await app.listen();
  try {
    assert.equal(isFirstRun(), true);
    let body = await (await fetch(`${address.url}/health`)).json();
    assert.equal(body.firstRun, true);

    process.env.OPENAGI_AUTH_TOKEN = "tok_x";
    body = await (await fetch(`${address.url}/health?token=tok_x`)).json();
    assert.equal(body.firstRun, false, "configured installs report firstRun:false");
  } finally {
    await app.close();
    if (savedEnv.a) process.env.ANTHROPIC_API_KEY = savedEnv.a;
    if (savedEnv.o) process.env.OPENAI_API_KEY = savedEnv.o;
    if (savedEnv.t) process.env.OPENAGI_AUTH_TOKEN = savedEnv.t; else delete process.env.OPENAGI_AUTH_TOKEN;
  }
});
