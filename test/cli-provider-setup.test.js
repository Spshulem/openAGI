// `openagi provider` + `openagi setup` output hygiene, for the guided
// (coding-agent-driven) setup path. Unit tests drive useCliProvider with a
// stubbed client; the CLI tests run bin/openagi.js against a stub daemon.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readProviderState, useCliProvider } from "../src/cli-client.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function stub(routes) {
  const calls = [];
  return {
    calls,
    target: { url: "http://127.0.0.1:43210", remote: false, source: "local", token: "t" },
    async request(method, route, body) {
      calls.push(`${method} ${route}`);
      const handler = routes[`${method} ${route}`];
      const next = Array.isArray(handler) ? handler.shift() : handler;
      if (!next) return { ok: false, status: 404, json: null };
      return typeof next === "function" ? next(body) : next;
    }
  };
}

const providerBody = (over = {}) => ({
  ok: true, status: 200,
  json: { current: "DeterministicModelProvider", model: null, configured: false, preference: "auto", available: { claudeCli: true, codexCli: false }, ...over }
});

test("provider state maps the daemon view without exposing anything secret", async () => {
  const s = await readProviderState(stub({ "GET /admin/provider": providerBody({ current: "ClaudeCliProvider", configured: true, model: "m" }) }));
  assert.equal(s.ok, true);
  assert.equal(s.active, "claude-cli");
  assert.equal(s.configured, true);
  assert.equal(s.cli["claude-cli"].ready, true);
  assert.equal(s.cli["codex-cli"].ready, false);
  assert.equal(s.cli["codex-cli"].signIn, "codex login");
});

test("deterministic fallback never counts as configured", async () => {
  const s = await readProviderState(stub({ "GET /admin/provider": providerBody({ configured: true }) }));
  assert.equal(s.active, "none");
  assert.equal(s.configured, false);
});

test("API-key providers are refused before touching the daemon", async () => {
  for (const choice of ["anthropic", "openai", "chatgpt", "", "claude"]) {
    const client = stub({});
    const r = await useCliProvider(client, choice);
    assert.equal(r.ok, false);
    assert.equal(r.step, "choice");
    assert.match(r.fix, /browser setup page/);
    assert.deepEqual(client.calls, []);
  }
});

test("a CLI the daemon cannot see stops at sign-in with the command the person runs", async () => {
  const client = stub({ "GET /admin/provider": providerBody() });
  const r = await useCliProvider(client, "codex-cli");
  assert.equal(r.step, "sign-in");
  assert.match(r.fix, /`codex login`/);
  assert.match(r.fix, /as the user the daemon runs as/);
  assert.deepEqual(client.calls, ["GET /admin/provider"], "no test or save when not signed in");
});

test("an existing different provider is never replaced without --replace", async () => {
  const client = stub({ "GET /admin/provider": providerBody({ current: "AnthropicProvider", configured: true }) });
  const r = await useCliProvider(client, "claude-cli");
  assert.equal(r.step, "replace");
  assert.match(r.error, /anthropic/);
  assert.ok(!client.calls.includes("POST /setup/save"));
});

test("a failed test prompt saves nothing", async () => {
  const client = stub({
    "GET /admin/provider": providerBody(),
    "POST /setup/test": { ok: false, status: 400, json: { ok: false, error: "Model verification failed.", message: "The provider could not answer." } }
  });
  const r = await useCliProvider(client, "claude-cli");
  assert.equal(r.step, "test");
  assert.match(r.error, /could not answer/);
  assert.ok(!client.calls.includes("POST /setup/save"));
});

test("success runs one real test, then saves, then confirms the daemon switched", async () => {
  const bodies = [];
  const client = stub({
    "GET /admin/provider": [providerBody(), providerBody({ current: "ClaudeCliProvider", configured: true, preference: "claude-cli", model: "m" })],
    "POST /setup/test": (b) => { bodies.push(b); return { ok: true, status: 200, json: { ok: true, reply: "hi", model: "m" } }; },
    "POST /setup/save": (b) => { bodies.push(b); return { ok: true, status: 200, json: {} }; }
  });
  const r = await useCliProvider(client, "claude-cli");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(client.calls, ["GET /admin/provider", "POST /setup/test", "POST /setup/save", "GET /admin/provider"]);
  for (const b of bodies) assert.deepEqual(b, { setupModel: true, OPENAGI_PROVIDER: "claude-cli" }, "only the provider choice is sent");
});

test("--replace switches only after the candidate answers", async () => {
  const client = stub({
    "GET /admin/provider": [providerBody({ current: "ClaudeCliProvider", configured: true, available: { claudeCli: true, codexCli: true } }),
      providerBody({ current: "CodexCliProvider", configured: true, available: { claudeCli: true, codexCli: true } })],
    "POST /setup/test": { ok: true, status: 200, json: { ok: true, reply: "hi" } },
    "POST /setup/save": { ok: true, status: 200, json: {} }
  });
  const r = await useCliProvider(client, "codex-cli", { replace: true });
  assert.equal(r.ok, true);
  assert.equal(r.provider, "codex-cli");
});

test("a saved choice the daemon did not apply is reported, not claimed", async () => {
  const client = stub({
    "GET /admin/provider": [providerBody(), providerBody()],
    "POST /setup/test": { ok: true, status: 200, json: { ok: true, reply: "hi" } },
    "POST /setup/save": { ok: true, status: 200, json: {} }
  });
  const r = await useCliProvider(client, "claude-cli");
  assert.equal(r.ok, false);
  assert.equal(r.step, "verify");
});

test("daemon down and 401 give recovery steps instead of throwing", async () => {
  const down = await useCliProvider(stub({ "GET /admin/provider": { ok: false, status: 0, error: "ECONNREFUSED" } }), "claude-cli");
  assert.equal(down.step, "daemon");
  assert.match(down.fix, /Start OpenAGI/);
  const denied = await useCliProvider(stub({ "GET /admin/provider": { ok: false, status: 401 } }), "claude-cli");
  assert.match(denied.fix, /same OS user as the daemon/);
});

// --- the real CLI against a stub daemon -------------------------------------

async function withStubDaemon(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-cli-provider-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { port: server.address().port, dataDir };
}

function runCli(args, { port, dataDir, env = {} }) {
  return new Promise((resolve) => {
    // No NODE_TEST_CONTEXT: the child is a real CLI run, with its own data dir.
    const child = spawn(process.execPath, [path.join(REPO, "bin", "openagi.js"), ...args], {
      env: { PATH: process.env.PATH, HOME: dataDir, OPENAGI_DATA_DIR: dataDir, PORT: String(port), ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
  });
}

test("`openagi setup` never prints the auth token into non-terminal output", async (t) => {
  const { port, dataDir } = await withStubDaemon(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, firstRun: false }));
  });
  const secret = "cli-setup-secret-7d2e91";
  fs.writeFileSync(path.join(dataDir, ".env"), `OPENAGI_AUTH_TOKEN=${secret}\n`, { mode: 0o600 });
  const r = await runCli(["setup"], { port, dataDir });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\/setup/);
  assert.match(r.out, /hidden because output is not a terminal/);
  assert.doesNotMatch(r.out, new RegExp(secret));
});

test("`openagi provider` reports state and `use` exits non-zero with a fix when not signed in", async (t) => {
  const seen = [];
  const { port, dataDir } = await withStubDaemon(t, (req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ current: "DeterministicModelProvider", configured: false, preference: "auto", available: { claudeCli: false, codexCli: true } }));
  });
  const status = await runCli(["provider"], { port, dataDir });
  assert.equal(status.code, 0, status.out);
  assert.match(status.out, /none \(no working model yet\)/);
  assert.match(status.out, /claude-cli\s+not ready .*`claude auth login`/);
  assert.match(status.out, /codex-cli\s+CLI found \+ signed in/);

  const use = await runCli(["provider", "use", "claude-cli"], { port, dataDir });
  assert.equal(use.code, 1);
  assert.match(use.out, /sign-in: the OpenAGI daemon cannot see a signed-in Claude Code CLI/);
  assert.ok(seen.every((s) => s === "GET /admin/provider"), `no test/save attempted: ${seen}`);

  const json = await runCli(["provider", "--json"], { port, dataDir });
  assert.equal(JSON.parse(json.out).cli["codex-cli"].ready, true);
});
