// test/sec-health-disclosure.test.js
//
// GET /health is a PUBLIC route (isPublicRoute in src/auth.js) and it used to
// answer every caller with the whole of runtime.status(). That object embeds
// cron.listJobs(), and a cron job carries its `input` verbatim — the scheduled
// prompt text, the SMS/Telegram recipient, the agent id it runs as — alongside
// the integration list, the provider config and the memory counts.
//
// On a loopback-only install that is untidy. The moment the daemon is put
// behind a tunnel (OPENAGI_PUBLIC_URL is a supported, documented feature, and
// docker-compose.example.yml ships a cloudflared sidecar) it is an
// unauthenticated dump of the user's private automation to anyone who guesses
// the URL — no credential involved, because /health is exempt from auth.
//
// The split these tests pin down:
//   * unauthenticated  → liveness only. HTTP 200, { ok, firstRun }. No status.
//   * authenticated    → the full body, unchanged, so the dashboard, the Mac
//                        tray poll and `openagi doctor` keep working.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TOKEN = "tok_health_disclosure_test";

// Values planted in a cron job's input. If any of them can be read without a
// credential, the route is disclosing the user's automation.
const SECRET_RECIPIENT = "+15550001111";
const SECRET_PROMPT = "Text Dana the Q3 severance numbers before the board call";

async function bootDaemon() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-health-"));
  process.env.OPENAGI_DATA_DIR = dataDir;
  // A token must be configured: that is the tunnelled/exposed posture this
  // route has to be safe in. It also makes isFirstRun() false, so the
  // first-run setup bypass (which waives auth on /setup*) is not in play.
  process.env.OPENAGI_AUTH_TOKEN = TOKEN;

  const { _resetDataDirCache } = await import("../src/data-dir.js");
  _resetDataDirCache();
  const { createDurableRuntime, createHostedInterface } = await import("../src/index.js");

  const runtime = createDurableRuntime({ dataDir });
  runtime.cron.addJob({
    id: "sec-health-secret-job",
    name: "Nightly severance text",
    task: "send-message",
    input: { channel: "sms", to: SECRET_RECIPIENT, prompt: SECRET_PROMPT, agentId: "agent_private" },
    intervalMs: 60 * 60 * 1000,
    replace: true
  });

  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, dataDir, authToken: TOKEN });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  return { app, base, dataDir };
}

test("unauthenticated GET /health answers liveness without disclosing cron job inputs", async () => {
  const { app, base } = await bootDaemon();
  try {
    const res = await fetch(`${base}/health`);
    // Still a usable probe: launchd, the Docker HEALTHCHECK and the setup
    // wizard's restart poll all key off the status code alone.
    assert.equal(res.status, 200, "/health must stay a working liveness probe for unauthenticated probes");

    const body = await res.json();
    assert.equal(body.ok, true, "liveness must still report ok:true");
    assert.equal(typeof body.firstRun, "boolean", "firstRun must survive — clients route to the wizard on it");

    const serialized = JSON.stringify(body);
    assert.ok(
      !serialized.includes(SECRET_RECIPIENT),
      `unauthenticated /health leaked a cron job's message recipient: ${serialized.slice(0, 400)}`
    );
    assert.ok(
      !serialized.includes(SECRET_PROMPT),
      `unauthenticated /health leaked a cron job's scheduled prompt: ${serialized.slice(0, 400)}`
    );
    assert.ok(
      !serialized.includes("sec-health-secret-job"),
      `unauthenticated /health leaked a cron job id: ${serialized.slice(0, 400)}`
    );
    assert.equal(body.status, undefined, "the full runtime status must not be served to an anonymous caller");
  } finally {
    await app.close?.();
  }
});

test("authenticated GET /health still returns the full runtime status", async () => {
  const { app, base } = await bootDaemon();
  try {
    const res = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.ok, true);
    assert.equal(typeof body.firstRun, "boolean");
    assert.ok(body.status, "an authorized caller must still get runtime.status()");

    // The exact fields the Mac tray (AppState.HealthResponse) decodes. Losing
    // any of these silently blanks the menu-bar status, which would be a worse
    // trade than the disclosure we are fixing.
    assert.ok(body.status.agentHost, "tray needs status.agentHost");
    assert.equal(typeof body.status.agentHost.provider, "string", "tray needs agentHost.provider");
    assert.equal(typeof body.status.agentHost.providerConfigured, "boolean", "tray needs agentHost.providerConfigured");
    assert.ok(body.status.memory, "tray needs status.memory");
    for (const tier of ["short", "medium", "long"]) {
      assert.equal(typeof body.status.memory[tier], "number", `tray needs memory.${tier}`);
    }
    // `openagi doctor` (runDoctor in src/cli-client.js) reads the same shape.
    assert.ok(Array.isArray(body.status.integrations), "doctor/dashboard need status.integrations");

    const job = body.status.cron.find((j) => j.id === "sec-health-secret-job");
    assert.ok(job, "authorized callers must still see scheduled jobs");
    assert.equal(job.input.to, SECRET_RECIPIENT, "authorized callers must still see job inputs");
  } finally {
    await app.close?.();
  }
});

test("a query-token caller is treated as authorized on /health", async () => {
  // The Mac app and the dashboard both hand the token over as ?token= on first
  // contact; checkAuth accepts that and sets a cookie. /health must use the
  // same decision function, not a header-only shortcut.
  const { app, base } = await bootDaemon();
  try {
    const res = await fetch(`${base}/health?token=${TOKEN}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.status, "?token= must authorize /health exactly like the Authorization header");
  } finally {
    await app.close?.();
  }
});

test("a cookie caller is treated as authorized on /health", async () => {
  // How the dashboard actually calls it: refreshHealth() does a same-origin
  // fetchJson("/health") and reads status.agentHost off the result, carrying
  // only the openagi_token cookie that /sign-in set.
  const { app, base } = await bootDaemon();
  try {
    const res = await fetch(`${base}/health`, { headers: { cookie: `openagi_token=${TOKEN}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.status?.agentHost, "the dashboard's cookie session must still get the full status");
  } finally {
    await app.close?.();
  }
});

test("with no token configured /health keeps serving the full status", async () => {
  // No token means the daemon is loopback-only — checkBindSafety() refuses to
  // boot a non-loopback bind without one — so the local caller can already
  // open the dashboard. Withholding the body here would break the tray and
  // `openagi doctor` on the default single-user install for no gain.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sec-health-open-"));
  process.env.OPENAGI_DATA_DIR = dataDir;
  process.env.OPENAGI_AUTH_TOKEN = "";
  // Keep isFirstRun() false so this exercises the ordinary auth path.
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-ant-not-a-real-key";

  const { _resetDataDirCache } = await import("../src/data-dir.js");
  _resetDataDirCache();
  const { createDurableRuntime, createHostedInterface } = await import("../src/index.js");
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, dataDir });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  try {
    const body = await (await fetch(`${base}/health`)).json();
    assert.equal(body.ok, true);
    assert.ok(body.status, "auth-disabled installs must still get the full status");
  } finally {
    await app.close?.();
  }
});
