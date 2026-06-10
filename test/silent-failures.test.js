// Silent-failure fixes from the feature audit: Linear registers even without
// a key (and picks one up live), BuildBetter reads identity/credentials live
// and surfaces sync skip reasons, and /message returns structured errors
// instead of crashing the request.
import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultRuntime, createHostedInterface } from "../src/index.js";
import { LinearTaskSource, registerLinearTaskSource } from "../src/integrations/linear-tasks.js";
import { BuildBetterTaskSource } from "../src/integrations/buildbetter-tasks.js";

test("Linear source + cron register even when LINEAR_API_KEY is unset at boot", async () => {
  delete process.env.LINEAR_API_KEY;
  const jobs = [];
  const runtime = { cron: { addJob: (j) => jobs.push(j) }, tasks: { add: () => ({}) } };

  const result = registerLinearTaskSource(runtime);
  assert.equal(result.registered, true);
  assert.equal(result.idle, true);
  assert.ok(runtime.linearTaskSource, "source attached for later credential arrival");
  assert.ok(jobs.some((j) => j.id === "linear-task-sync"), "cron job installed");

  // Unconfigured tick self-gates with a reason — and records it for status.
  const sync = await runtime.linearTaskSource.sync();
  assert.equal(sync.skipped, true);
  assert.match(sync.reason, /LINEAR_API_KEY/);
  assert.equal(runtime.linearTaskSource.lastSyncResult.skipped, true);

  // A key added mid-session (setup wizard, .env edit) is seen live.
  process.env.LINEAR_API_KEY = "lin_test_123";
  try {
    assert.equal(runtime.linearTaskSource.isConfigured(), true, "env read live, no restart needed");
  } finally {
    delete process.env.LINEAR_API_KEY;
  }
});

test("BuildBetter reads credentials/identity from env live and records sync results", async () => {
  delete process.env.BUILDBETTER_API_KEY;
  delete process.env.BUILDBETTER_USER_EMAIL;
  const runtime = { tasks: { add: () => ({}) }, mcp: { hasOAuthToken: () => false, silentTokenFor: async () => null } };
  const source = new BuildBetterTaskSource({ runtime });

  assert.equal(source.isConfigured(), false);
  const result = await source.sync();
  assert.equal(result.signals.skipped, true);
  assert.match(result.signals.reason, /no BuildBetter auth/);
  assert.equal(source.lastSyncResult.signals.skipped, true, "skip reason captured for /integrations/status");

  process.env.BUILDBETTER_API_KEY = "bb_test";
  process.env.BUILDBETTER_USER_EMAIL = "spencer@example.com";
  try {
    assert.equal(source.isConfigured(), true, "API key read live");
    assert.equal(source.userEmail, "spencer@example.com", "identity read live");
    // ensureIdentity's derived values still win over later reads.
    source.userEmail = "derived@example.com";
    assert.equal(source.userEmail, "derived@example.com");
  } finally {
    delete process.env.BUILDBETTER_API_KEY;
    delete process.env.BUILDBETTER_USER_EMAIL;
  }
});

test("Linear source still registers normally when configured", () => {
  const jobs = [];
  const runtime = { cron: { addJob: (j) => jobs.push(j) }, tasks: { add: () => ({}) } };
  const result = registerLinearTaskSource(runtime, { source: new LinearTaskSource({ runtime, apiKey: "lin_x" }) });
  assert.equal(result.registered, true);
  assert.equal(result.idle, false);
});

test("POST /message returns a structured error instead of a bare 500 crash", async () => {
  const runtime = createDefaultRuntime();
  const app = createHostedInterface(runtime, { port: 0 });
  const address = await app.listen();
  try {
    // Force the agent path to throw.
    runtime.agentHost.handleMessage = async () => { const e = new Error("Daily budget exceeded: $10 cap"); e.code = "BUDGET_EXCEEDED"; throw e; };
    const res = await fetch(`${address.url}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "t", text: "hi" })
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.code, "budget", "budget errors are distinguishable");
    assert.match(body.error, /budget exceeded/i);
  } finally {
    await app.close();
  }
});
