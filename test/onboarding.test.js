// Onboarding polish: re-running /setup must not rotate the auth token or
// reset configured values, saved secrets are visibly marked, and /health
// exposes firstRun so the Mac app can walk a fresh install to the wizard.
import assert from "node:assert/strict";
import test from "node:test";
import { renderWizard, isFirstRun } from "../src/setup-wizard.js";
import { createDefaultRuntime, createHostedInterface } from "../src/index.js";

test("fresh wizard generates a token and uses defaults", () => {
  const html = renderWizard({ existingEnv: {} });
  assert.match(html, /auto-generated a strong one/);
  assert.match(html, /value="claude-sonnet-4-6"/);
  assert.match(html, /value="gpt-5"/);
  assert.ok(!html.includes("✓ saved"), "no saved markers on a fresh install");
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
