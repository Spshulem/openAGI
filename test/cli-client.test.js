// CLI client: target resolution precedence, node pairing config, request
// auth, and the doctor diagnostic ladder (with a stubbed daemon).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveTarget, resolveUpdateTarget, normalizeBase, CliClient, runDoctor,
  writeNodeConfig, readNodeConfig, clearNodeConfig, revokeAndClearNodeConfig,
  restartLocalDaemon, createRefreshingNodeClientProvider
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
  assert.equal(normalizeBase("node.example.test"), "http://node.example.test:43210");
  assert.equal(normalizeBase("node.example.test:8080"), "http://node.example.test:8080");
  assert.equal(normalizeBase("http://x:43210"), "http://x:43210");
  assert.equal(normalizeBase("https://main.example.com"), "https://main.example.com");
  assert.throws(() => normalizeBase("https://user:secret@main.example.test/path?q=1"), /without credentials/);
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
  writeNodeConfig({ remote: "http://node.example.test:43210", token: "paired-tok" }, dir);
  tgt = resolveTarget({ dataDir: dir });
  assert.equal(tgt.source, "node.json");
  assert.equal(tgt.url, "http://node.example.test:43210");
  assert.equal(tgt.token, "paired-tok");
  assert.equal(tgt.remote, true);

  fs.writeFileSync(path.join(dir, "identity.json"), JSON.stringify({ nodeId: "stable-node", name: "Node" }));
  writeNodeConfig({
    remote: "https://main.example.com", token: null,
    nodeToken: "n".repeat(43), nodeEnrollmentConfirmed: true
  }, dir);
  tgt = resolveTarget({ dataDir: dir });
  assert.equal(tgt.token, "n".repeat(43));
  assert.equal(tgt.nodeId, "stable-node");

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

test("resolveUpdateTarget defaults to this device even when the CLI is paired", (t) => {
  cleanEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-local-update-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, ".env"), "OPENAGI_AUTH_TOKEN=local-update-token\n", { mode: 0o600 });
  writeNodeConfig({
    remote: "https://paired-main.example.test",
    token: null,
    nodeToken: "n".repeat(43),
    nodeEnrollmentConfirmed: true
  }, dir);
  process.env.OPENAGI_REMOTE = "https://environment-main.example.test";
  process.env.OPENAGI_REMOTE_TOKEN = "remote-update-token";

  assert.deepEqual(resolveUpdateTarget({ dataDir: dir }), {
    url: "http://127.0.0.1:43210",
    token: "local-update-token",
    source: "local",
    remote: false
  });
});

test("resolveUpdateTarget honors an explicit remote update target", (t) => {
  cleanEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-remote-update-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeNodeConfig({ remote: "https://paired-main.example.test", token: "saved-token" }, dir);
  process.env.OPENAGI_REMOTE = "https://environment-main.example.test";
  process.env.OPENAGI_REMOTE_TOKEN = "environment-token";

  assert.deepEqual(resolveUpdateTarget({
    remote: "https://chosen-main.example.test",
    token: "explicit-token",
    dataDir: dir
  }), {
    url: "https://chosen-main.example.test",
    token: "explicit-token",
    source: "flag",
    remote: true
  });
});

test("node config round-trips and clears, with 0600 perms", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-node2-"));
  const file = writeNodeConfig({ remote: "http://x:43210", token: "t" }, dir);
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  assert.deepEqual(readNodeConfig(dir), {
    remote: "http://x:43210", token: "t", nodeToken: null, nodeEnrollmentConfirmed: null
  });
  fs.chmodSync(file, 0o644);
  writeNodeConfig({ remote: "http://x:43210", token: "replacement" }, dir);
  assert.equal((fs.statSync(file).mode & 0o777), 0o600, "every replacement restores credential-only permissions");
  assert.equal(readNodeConfig(dir).token, "replacement");
  assert.equal(clearNodeConfig(dir), true);
  assert.equal(readNodeConfig(dir), null);
  fs.rmSync(dir, { recursive: true });
});

test("node config keeps the last complete pairing when atomic replacement fails", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-node-atomic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = writeNodeConfig({
    remote: "https://old-main.example.test",
    token: "old-pairing-token",
    nodeToken: "old-scoped-token",
    nodeEnrollmentConfirmed: true
  }, dir);
  const before = fs.readFileSync(file, "utf8");
  let replacementAttempted = false;
  t.mock.method(fs, "renameSync", (tempPath, targetPath) => {
    if (targetPath === file) {
      replacementAttempted = true;
      assert.equal((fs.statSync(tempPath).mode & 0o777), 0o600, "temporary credential file is private before replacement");
      const error = new Error("simulated interrupted atomic replacement");
      error.code = "EIO";
      throw error;
    }
    throw new Error(`unexpected rename target: ${targetPath}`);
  });

  assert.throws(() => writeNodeConfig({
    remote: "https://new-main.example.test",
    token: "new-pairing-token"
  }, dir), /simulated interrupted atomic replacement/);
  assert.equal(replacementAttempted, true);
  assert.equal(fs.readFileSync(file, "utf8"), before, "the prior pairing file was never truncated");
  assert.deepEqual(readNodeConfig(dir), {
    remote: "https://old-main.example.test",
    token: null,
    nodeToken: "old-scoped-token",
    nodeEnrollmentConfirmed: true
  });
});

test("confirmed node config never retains a main-wide pairing credential", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-node-scrub-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeNodeConfig({
    remote: "https://main.example.test",
    token: "main-wide-token",
    nodeToken: "node-scoped-token",
    nodeEnrollmentConfirmed: true
  }, dir);
  assert.equal(readNodeConfig(dir).token, null);
  writeNodeConfig({ remote: "https://main.example.test", token: "another-main-wide-token" }, dir);
  assert.equal(readNodeConfig(dir).token, null, "re-pairing with the same main cannot restore broad authority");
  writeNodeConfig({ remote: "https://main.example.test/", token: "third-main-wide-token" }, dir);
  assert.equal(readNodeConfig(dir).nodeToken, "node-scoped-token", "equivalent origin spelling preserves enrollment");
  assert.equal(readNodeConfig(dir).token, null);
});

test("CliClient attaches the bearer token", async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push({ url, opts }); return { ok: true, status: 200, text: async () => "{}" }; };
  const client = new CliClient({ url: "http://main:43210", token: "secret", remote: true, source: "flag" }, { fetchImpl });
  await client.chat("hi");
  assert.equal(seen[0].url, "http://main:43210/message");
  assert.equal(seen[0].opts.headers.authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(seen[0].opts.body), { text: "hi", from: "cli" });
  assert.equal(seen[0].opts.redirect, "manual");
});

test("scoped-node health remains useful after the one-time admin credential is erased", async () => {
  const client = new CliClient({
    url: "https://main.example.test",
    token: "scoped-node-token",
    nodeId: "stable-node",
    remote: true,
    source: "node.json"
  }, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, firstRun: false })
    })
  });
  const health = await client.health();
  assert.equal(health.ok, true);
  assert.equal(health.json.access, "node-scoped");

  client.integrations = async () => ({ ok: false, status: 401 });
  const doctor = await runDoctor(client);
  assert.equal(doctor.ok, true);
  assert.equal(doctor.checks.find((check) => check.name === "credential")?.ok, true);
  assert.equal(doctor.checks.some((check) => check.name === "model"), false,
    "missing private status must not be reported as a missing model");
});

test("long-running node clients rotate from pairing auth to scoped auth and never fall back", (t) => {
  cleanEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-client-refresh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "identity.json"), JSON.stringify({ nodeId: "stable-node", name: "Node" }));
  writeNodeConfig({
    remote: "https://main.example.test",
    token: "pairing-credential",
    nodeToken: "pending-scoped-credential",
    nodeEnrollmentConfirmed: false
  }, dir);

  let scopedNotifications = 0;
  const provideClient = createRefreshingNodeClientProvider({
    remote: "https://main.example.test",
    token: "pairing-credential",
    dataDir: dir,
    onScopedCredential: () => { scopedNotifications += 1; }
  });
  const before = provideClient();
  assert.equal(before.target.token, "pairing-credential");
  assert.equal(before.target.nodeId, undefined);

  writeNodeConfig({
    remote: "https://main.example.test",
    token: null,
    nodeToken: "n".repeat(43),
    nodeEnrollmentConfirmed: true
  }, dir);
  const after = provideClient();
  assert.equal(after.target.token, "n".repeat(43));
  assert.equal(after.target.nodeId, "stable-node");
  assert.equal(scopedNotifications, 1);

  clearNodeConfig(dir);
  assert.throws(
    () => provideClient(),
    (error) => /scoped node pairing is no longer available/.test(error.message)
      && !error.message.includes("pairing-credential")
      && !error.message.includes("n".repeat(43)),
    "a confirmed relay fails closed instead of returning to broader auth"
  );
});

test("long-running node clients require HTTPS outside loopback", (t) => {
  cleanEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-client-transport-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.throws(
    () => createRefreshingNodeClientProvider({
      remote: "http://main.example.test",
      token: "pairing-credential",
      dataDir: dir
    })(),
    /requires HTTPS/
  );
  assert.doesNotThrow(() => createRefreshingNodeClientProvider({
    remote: "http://127.0.0.1:43210",
    token: "local-credential",
    dataDir: dir
  })(), "loopback HTTP remains valid");
  assert.doesNotThrow(() => createRefreshingNodeClientProvider({
    remote: "https://main.example.test",
    token: "pairing-credential",
    dataDir: dir
  })(), "remote HTTPS remains valid");
  assert.doesNotThrow(() => createRefreshingNodeClientProvider({
    remote: "http://tunnel.example.test",
    token: "pairing-credential",
    dataDir: dir,
    allowInsecureRemote: true
  })(), "plaintext origin requires an explicit encrypted-tunnel assertion");
});

test("long-running node clients reject a target override that conflicts with confirmed pairing", (t) => {
  cleanEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-client-conflict-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "identity.json"), JSON.stringify({ nodeId: "stable-node", name: "Node" }));
  writeNodeConfig({
    remote: "https://saved-main.example.test",
    token: null,
    nodeToken: "n".repeat(43),
    nodeEnrollmentConfirmed: true
  }, dir);

  assert.throws(() => createRefreshingNodeClientProvider({
    remote: "https://different-main.example.test",
    token: "one-shot-token",
    dataDir: dir
  })(), /conflicts with the confirmed saved pairing/);
  assert.equal(createRefreshingNodeClientProvider({
    remote: "https://saved-main.example.test/",
    dataDir: dir
  })().target.url, "https://saved-main.example.test");

  process.env.OPENAGI_REMOTE = "https://different-env-main.example.test";
  assert.throws(() => createRefreshingNodeClientProvider({ dataDir: dir })(), /conflicts with the confirmed saved pairing/);
});

test("local daemon restart ignores remote target overrides and uses local auth", async (t) => {
  cleanEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-restart-local-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, ".env"), "OPENAGI_AUTH_TOKEN=local-daemon-token\n", { mode: 0o600 });
  writeNodeConfig({ remote: "https://saved-main.example.test", token: "saved-token" }, dir);
  process.env.OPENAGI_REMOTE = "https://environment-main.example.test";
  process.env.OPENAGI_REMOTE_TOKEN = "remote-token";
  process.env.PORT = "45678";
  const requests = [];
  const result = await restartLocalDaemon({
    dataDir: dir,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 202, text: async () => JSON.stringify({ restarting: true }) };
    }
  });
  assert.equal(result.restarted, true);
  assert.equal(requests[0].url, "http://127.0.0.1:45678/control/restart");
  assert.equal(requests[0].options.headers.authorization, "Bearer local-daemon-token");
});

test("unpair uses the exact saved enrollment and keeps retryable credentials until revocation succeeds", async (t) => {
  cleanEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-unpair-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "identity.json"), JSON.stringify({ nodeId: "stable-node", name: "Node" }));
  writeNodeConfig({
    remote: "https://main.example.test",
    token: null,
    nodeToken: "n".repeat(43),
    nodeEnrollmentConfirmed: true
  }, dir);

  const failed = await revokeAndClearNodeConfig({
    dataDir: dir,
    fetchImpl: async () => { throw new Error("offline"); }
  });
  assert.equal(failed.removed, false);
  assert.ok(readNodeConfig(dir)?.nodeToken, "a failed revoke remains retryable");

  process.env.OPENAGI_REMOTE = "https://wrong-main.example.test";
  process.env.OPENAGI_REMOTE_TOKEN = "wrong-main-token";
  const requests = [];
  const succeeded = await revokeAndClearNodeConfig({
    dataDir: dir,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, revoked: true }) };
    }
  });
  assert.equal(succeeded.revoked, true);
  assert.equal(succeeded.removed, true);
  assert.equal(readNodeConfig(dir), null);
  assert.equal(requests[0].url, "https://main.example.test/nodes/revoke");
  assert.equal(requests[0].options.headers.authorization, `Bearer ${"n".repeat(43)}`);
  assert.equal(requests[0].options.headers["x-openagi-node-id"], "stable-node");
  assert.equal(requests[0].options.redirect, "manual");
});

test("unpair restarts before clearing so a running daemon reloads the new state", async (t) => {
  cleanEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-unpair-restart-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "identity.json"), JSON.stringify({ nodeId: "stable-node" }));
  fs.writeFileSync(path.join(dir, ".env"), "OPENAGI_AUTH_TOKEN=local-token\n", { mode: 0o600 });
  writeNodeConfig({
    remote: "https://main.example.test",
    token: null,
    nodeToken: "n".repeat(43),
    nodeEnrollmentConfirmed: true
  }, dir);

  const routes = [];
  const result = await revokeAndClearNodeConfig({
    dataDir: dir,
    restartLocal: true,
    fetchImpl: async (url) => {
      routes.push(url);
      if (url.endsWith("/control/restart")) {
        assert.ok(readNodeConfig(dir), "pairing remains until the daemon accepts its restart");
        return { ok: true, status: 202, text: async () => JSON.stringify({ restarting: true }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ revoked: true }) };
    }
  });
  assert.deepEqual(routes, [
    "https://main.example.test/nodes/revoke",
    "http://127.0.0.1:43210/control/restart"
  ]);
  assert.equal(result.revoked, true);
  assert.equal(result.local.restarted, true);
  assert.equal(result.removed, true);
  assert.equal(readNodeConfig(dir), null);
});

test("forced unpair keeps the pairing when a running daemon cannot restart", async (t) => {
  cleanEnv(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-unpair-force-restart-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "identity.json"), JSON.stringify({ nodeId: "stable-node" }));
  writeNodeConfig({
    remote: "https://main.example.test",
    token: null,
    nodeToken: "n".repeat(43),
    nodeEnrollmentConfirmed: true
  }, dir);

  const result = await revokeAndClearNodeConfig({
    dataDir: dir,
    force: true,
    restartLocal: true,
    fetchImpl: async (url) => url.endsWith("/nodes/revoke")
      ? { ok: false, status: 503, text: async () => "" }
      : { ok: false, status: 401, text: async () => "" }
  });
  assert.equal(result.removed, false);
  assert.equal(result.reason, "local-daemon-restart-required");
  assert.ok(readNodeConfig(dir)?.nodeToken, "the live daemon and saved pairing remain consistent for a safe retry");
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
