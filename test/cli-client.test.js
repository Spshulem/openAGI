// CLI client: target resolution precedence, node pairing config, request
// auth, and the doctor diagnostic ladder (with a stubbed daemon).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveTarget, normalizeBase, CliClient, runDoctor,
  writeNodeConfig, readNodeConfig, clearNodeConfig
} from "../src/cli-client.js";

const cleanEnv = (t) => {
  const saved = { r: process.env.OPENAGI_REMOTE, rt: process.env.OPENAGI_REMOTE_TOKEN, a: process.env.OPENAGI_AUTH_TOKEN, p: process.env.PORT };
  delete process.env.OPENAGI_REMOTE; delete process.env.OPENAGI_REMOTE_TOKEN; delete process.env.OPENAGI_AUTH_TOKEN; delete process.env.PORT;
  t.after(() => {
    for (const [k, v] of [["OPENAGI_REMOTE", saved.r], ["OPENAGI_REMOTE_TOKEN", saved.rt], ["OPENAGI_AUTH_TOKEN", saved.a], ["PORT", saved.p]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
};

test("normalizeBase fills scheme + daemon port", () => {
  assert.equal(normalizeBase("distiller.local"), "http://distiller.local:43210");
  assert.equal(normalizeBase("distiller.local:8080"), "http://distiller.local:8080");
  assert.equal(normalizeBase("http://x:43210"), "http://x:43210");
  assert.equal(normalizeBase("https://main.example.com"), "https://main.example.com");
});

test("resolveTarget precedence: flag > env > node.json > local", (t) => {
  cleanEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-node-"));

  // local default when nothing is set
  let tgt = resolveTarget({ dataDir: dir });
  assert.equal(tgt.source, "local");
  assert.equal(tgt.url, "http://127.0.0.1:43210");
  assert.equal(tgt.remote, false);

  // node.json pairing
  writeNodeConfig({ remote: "http://distiller.local:43210", token: "paired-tok" }, dir);
  tgt = resolveTarget({ dataDir: dir });
  assert.equal(tgt.source, "node.json");
  assert.equal(tgt.url, "http://distiller.local:43210");
  assert.equal(tgt.token, "paired-tok");
  assert.equal(tgt.remote, true);

  // env beats node.json
  process.env.OPENAGI_REMOTE = "main.example.com:9000";
  process.env.OPENAGI_REMOTE_TOKEN = "env-tok";
  tgt = resolveTarget({ dataDir: dir });
  assert.equal(tgt.source, "env");
  assert.equal(tgt.url, "http://main.example.com:9000");
  assert.equal(tgt.token, "env-tok");

  // flag beats everything
  tgt = resolveTarget({ remote: "10.0.0.5", token: "flag-tok", dataDir: dir });
  assert.equal(tgt.source, "flag");
  assert.equal(tgt.url, "http://10.0.0.5:43210");
  assert.equal(tgt.token, "flag-tok");

  fs.rmSync(dir, { recursive: true });
});

test("node config round-trips and clears, with 0600 perms", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-node2-"));
  const file = writeNodeConfig({ remote: "http://x:43210", token: "t" }, dir);
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  assert.deepEqual(readNodeConfig(dir), { remote: "http://x:43210", token: "t" });
  assert.equal(clearNodeConfig(dir), true);
  assert.equal(readNodeConfig(dir), null);
  fs.rmSync(dir, { recursive: true });
});

test("CliClient attaches the bearer token", async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push({ url, opts }); return { ok: true, status: 200, text: async () => "{}" }; };
  const client = new CliClient({ url: "http://main:43210", token: "secret", remote: true, source: "flag" }, { fetchImpl });
  await client.chat("hi");
  assert.equal(seen[0].url, "http://main:43210/message");
  assert.equal(seen[0].opts.headers.authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(seen[0].opts.body), { text: "hi", from: "cli" });
});

function stubClient(responses) {
  return {
    target: { url: "http://main:43210", remote: true, source: "flag", token: "t" },
    health: async () => responses.health,
    integrations: async () => responses.integrations ?? { ok: false, status: 401 }
  };
}

test("doctor: unreachable daemon stops early with a fix", async () => {
  const r = await runDoctor(stubClient({ health: { ok: false, status: 0, error: "ECONNREFUSED" } }));
  assert.equal(r.ok, false);
  const daemon = r.checks.find((c) => c.name === "daemon");
  assert.equal(daemon.ok, false);
  assert.match(daemon.detail, /unreachable/);
  assert.match(daemon.fix, /HOST=0.0.0.0/);
  assert.ok(!r.checks.some((c) => c.name === "model"), "no further checks when daemon is down");
});

test("doctor: 401 names the token problem", async () => {
  const r = await runDoctor(stubClient({ health: { ok: false, status: 401 } }));
  const daemon = r.checks.find((c) => c.name === "daemon");
  assert.match(daemon.detail, /401/);
  assert.match(daemon.fix, /token/i);
});

test("doctor: healthy but first-run + deterministic + no sources", async () => {
  const r = await runDoctor(stubClient({
    health: { ok: true, status: 200, json: { firstRun: true, status: { agentHost: { providerConfigured: true, provider: "DeterministicModelProvider" } } } },
    integrations: { ok: true, json: { integrations: [{ id: "linear", name: "Linear", paths: [{ kind: "api", configured: false }] }] } }
  }));
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.name === "setup").ok, false);
  const model = r.checks.find((c) => c.name === "model");
  assert.equal(model.ok, false, "deterministic provider is not a real model");
  assert.match(model.detail, /deterministic/i);
  assert.equal(r.checks.find((c) => c.name === "task-sources").ok, false);
});

test("doctor: fully configured main passes", async () => {
  const r = await runDoctor(stubClient({
    health: { ok: true, status: 200, json: { firstRun: false, status: { agentHost: { providerConfigured: true, provider: "OpenAIResponsesProvider" } } } },
    integrations: { ok: true, json: { integrations: [{ id: "buildbetter", name: "BuildBetter", paths: [{ kind: "api", configured: true }] }] } }
  }));
  assert.equal(r.ok, true);
  assert.ok(r.checks.every((c) => c.ok));
});
