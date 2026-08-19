// test/service-nodes.test.js
//
// The Nodes view was built entirely out of heartbeats, so it could only ever
// see machines that run an OpenAGI daemon. A service-only host running
// `openagi imessage-server` has no daemon identity and never heartbeats. It is
// reached only because the main's environment names it
// (OPENAGI_IMESSAGE_NODE), so the topology needs a separate service model.
//
// These tests pin the four things that make surfacing it safe rather than just
// pretty:
//   1. A service is a DISTINCT kind. It has no nodeId/version/lastSeenAt and
//      must never be smuggled into the `nodes` roster, where an older client
//      would decode it as a peer that is permanently "unknown".
//   2. Its liveness is a PROBE, not a remembered heartbeat, and the answer says
//      whether it was measured during this request or recalled from a cache
//      and how old that cache is. Replaying a cached verdict as a live one is
//      the exact bug that had this view reporting a two-week-dead machine as
//      "online"; it must not come back one field over.
//   3. The probe must never hold the response hostage. A sleeping service host
//      cannot stop the rest of the topology from rendering.
//   4. The token never leaves this process — not in the JSON, not in the
//      dashboard HTML, not in an error string.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { writeNodeConfig } from "../src/cli-client.js";
import {
  ServiceProbe,
  readServiceConfig,
  scrubEndpoint,
  adoptRemoteServices,
  mergeServices
} from "../src/service-nodes.js";

const TOKEN = "imsg-tok-3f9a2b7c-never-print-me";

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function bootApp(dataDir, opts = {}) {
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, authToken: null, ...opts
  });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  return { runtime, app, base };
}

// A stand-in for `openagi imessage-server`: GET /health, bearer-gated on
// everything else. `seen` records the headers we were probed with.
async function startFakeService({ status = 200, body = { ok: true, service: "imessage" } } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((r) => server.close(r))
  };
}

// Accepts the TCP connection and then says nothing, ever — a machine that is
// awake enough to answer SYN but not to serve. This is the shape of "asleep"
// that a plain closed port does NOT reproduce (a closed port fails instantly).
async function startBlackHole() {
  const sockets = new Set();
  const server = net.createServer((s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    }
  };
}

// A port nothing has ever listened on: connection refused, immediately.
async function deadUrl() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  await new Promise((r) => server.close(r));
  return url;
}

// ---------------------------------------------------------------------------
// 1. A service is its own kind — never a peer
// ---------------------------------------------------------------------------

test("a probed service is reported as a service, not as a node-shaped row", async () => {
  const svc = await startFakeService();
  try {
    const probe = new ServiceProbe({ timeoutMs: 1000, budgetMs: 900 });
    const out = await probe.describe({
      env: { OPENAGI_IMESSAGE_NODE: svc.url, OPENAGI_IMESSAGE_NODE_TOKEN: TOKEN }
    });
    const imsg = out.find((s) => s.id === "imessage");
    assert.ok(imsg, "the configured service is described");
    assert.equal(imsg.kind, "service");
    assert.equal(imsg.configured, true);
    assert.equal(imsg.endpoint, svc.url);
    assert.ok(imsg.purpose, "the view has to be able to say what the machine is FOR");

    // The fields a peer has and a service genuinely does not. Faking any of
    // them would put a permanently-"unknown" ghost peer in the roster.
    for (const absent of ["nodeId", "version", "build", "buildSource", "lastSeenAt", "status", "role", "behind", "updateCommand"]) {
      assert.ok(!(absent in imsg), `a service must not carry a peer's "${absent}" field`);
    }
  } finally { await svc.close(); }
});

test("the probe authenticates with the configured token but never returns it", async () => {
  const svc = await startFakeService();
  try {
    const probe = new ServiceProbe({ timeoutMs: 1000, budgetMs: 900 });
    const out = await probe.describe({
      env: { OPENAGI_IMESSAGE_NODE: svc.url, OPENAGI_IMESSAGE_NODE_TOKEN: TOKEN }
    });
    assert.equal(svc.seen.length, 1);
    assert.equal(svc.seen[0].url, "/health", "liveness is the service's own health route");
    assert.equal(svc.seen[0].auth, `Bearer ${TOKEN}`, "a token-gated health route still has to answer us");
    assert.ok(!JSON.stringify(out).includes(TOKEN), "and the token never comes back out");
  } finally { await svc.close(); }
});

// ---------------------------------------------------------------------------
// 2. Liveness is probed, and honest about live vs recalled
// ---------------------------------------------------------------------------

test("a reachable service is reported reachable, measured during this request", async () => {
  const svc = await startFakeService();
  try {
    const probe = new ServiceProbe({ timeoutMs: 1000, budgetMs: 900 });
    const [imsg] = await probe.describe({ env: { OPENAGI_IMESSAGE_NODE: svc.url } });
    assert.equal(imsg.reachability, "reachable");
    assert.equal(imsg.checkBasis, "live");
    assert.equal(imsg.checkAgeMs, 0);
    assert.ok(Number.isFinite(new Date(imsg.checkedAt).getTime()), "and it is dated");
  } finally { await svc.close(); }
});

test("a dead service is reported unreachable with a reason, not silently omitted", async () => {
  const url = await deadUrl();
  const probe = new ServiceProbe({ timeoutMs: 1000, budgetMs: 900 });
  const [imsg] = await probe.describe({ env: { OPENAGI_IMESSAGE_NODE: url } });
  assert.equal(imsg.configured, true, "it is still configured — the machine is just down");
  assert.equal(imsg.reachability, "unreachable");
  assert.equal(imsg.checkBasis, "live");
  assert.ok(imsg.detail, "the user gets told why");
  assert.equal(imsg.endpoint, url, "the address stays visible so they know which box to wake");
});

test("a service that answers non-2xx is unreachable and says so — 'up but refusing' is not 'up'", async () => {
  const svc = await startFakeService({ status: 401, body: { error: "unauthorized" } });
  try {
    const probe = new ServiceProbe({ timeoutMs: 1000, budgetMs: 900 });
    const [imsg] = await probe.describe({ env: { OPENAGI_IMESSAGE_NODE: svc.url } });
    assert.equal(imsg.reachability, "unreachable");
    assert.match(imsg.detail, /401/);
  } finally { await svc.close(); }
});

test("a health probe cancels its response body instead of buffering untrusted bytes", async () => {
  let cancelled = 0;
  let buffered = 0;
  const probe = new ServiceProbe({
    timeoutMs: 1000,
    budgetMs: 900,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: { cancel: async () => { cancelled += 1; } },
      arrayBuffer: async () => { buffered += 1; return new ArrayBuffer(0); }
    })
  });
  const [imsg] = await probe.describe({ env: { OPENAGI_IMESSAGE_NODE: "http://service.example" } });
  assert.equal(imsg.reachability, "reachable");
  assert.equal(cancelled, 1, "the unread body is released");
  assert.equal(buffered, 0, "the probe never allocates the response body");
});

test("an unconfigured service says not-configured — never a fabricated status", async () => {
  const probe = new ServiceProbe({ timeoutMs: 1000, budgetMs: 900 });
  const [imsg] = await probe.describe({ env: {} });
  assert.equal(imsg.configured, false);
  assert.equal(imsg.reachability, "not-configured");
  assert.equal(imsg.endpoint, null);
  assert.equal(imsg.checkedAt, null);
  assert.equal(imsg.checkBasis, "none");
  assert.ok(imsg.detail?.includes("OPENAGI_IMESSAGE_NODE"), "it tells the user which knob turns it on");
});

test("a re-used probe result is labelled cached with its age — never replayed as live", async () => {
  const svc = await startFakeService();
  try {
    // minIntervalMs high enough that the second call cannot re-probe.
    const probe = new ServiceProbe({ timeoutMs: 1000, budgetMs: 900, minIntervalMs: 60_000 });
    const env = { OPENAGI_IMESSAGE_NODE: svc.url };
    const [first] = await probe.describe({ env });
    assert.equal(first.checkBasis, "live");
    await new Promise((r) => setTimeout(r, 25));
    const [second] = await probe.describe({ env });
    assert.equal(svc.seen.length, 1, "the second request did not re-probe");
    assert.equal(second.reachability, "reachable");
    assert.notEqual(second.checkBasis, "live", "this verdict was NOT measured during this request");
    assert.equal(second.checkBasis, "cached");
    assert.ok(second.checkAgeMs >= 20, `cached age is reported (${second.checkAgeMs}ms)`);
    assert.equal(second.checkedAt, first.checkedAt, "and it is dated to when it was actually measured");
  } finally { await svc.close(); }
});

// ---------------------------------------------------------------------------
// 3. A sleeping service must not hold the response
// ---------------------------------------------------------------------------

test("a service that accepts the connection and never answers does not exceed the probe budget", async () => {
  const hole = await startBlackHole();
  try {
    const probe = new ServiceProbe({ timeoutMs: 10_000, budgetMs: 250 });
    const t0 = Date.now();
    const [imsg] = await probe.describe({ env: { OPENAGI_IMESSAGE_NODE: hole.url } });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, `describe returned in ${elapsed}ms, well inside the 10s probe timeout`);
    assert.equal(imsg.reachability, "unknown", "we do not know yet, and we say so");
    assert.equal(imsg.checkBasis, "none");
    assert.equal(imsg.checkedAt, null, "an unfinished probe is never dated");
    assert.ok(imsg.detail, "the row explains that the probe is still running");
  } finally { await hole.close(); }
});

// ---------------------------------------------------------------------------
// 4. Credentials never surface
// ---------------------------------------------------------------------------

test("credentials embedded in the endpoint URL are stripped from everything rendered", async () => {
  const svc = await startFakeService();
  const withCreds = svc.url.replace("http://", `http://svcuser:${TOKEN}@`);
  try {
    const probe = new ServiceProbe({ timeoutMs: 1000, budgetMs: 900 });
    const out = await probe.describe({ env: { OPENAGI_IMESSAGE_NODE: withCreds } });
    const [imsg] = out;
    assert.equal(imsg.endpoint, svc.url, "the displayed endpoint has no userinfo");
    assert.ok(!imsg.host.includes("@"));
    assert.ok(!JSON.stringify(out).includes(TOKEN), "the embedded password never reaches the response");
    assert.ok(!JSON.stringify(out).includes("svcuser"));
    // ...and it is still used to authenticate, converted to a header.
    assert.match(svc.seen[0].auth ?? "", /^Basic /);
  } finally { await svc.close(); }
});

test("the exported endpoint sanitizer never returns private parsing material", () => {
  const sanitized = scrubEndpoint(`http://svcuser:${TOKEN}@example.test/private-route`);
  assert.deepEqual(sanitized, {
    endpoint: "http://example.test",
    host: "example.test",
    invalid: false
  });
  assert.ok(!JSON.stringify(sanitized).includes(TOKEN));
  assert.ok(!JSON.stringify(sanitized).includes("private-route"));
});

test("a query-string credential in the endpoint is dropped from the displayed address", () => {
  const s = scrubEndpoint(`http://192.0.2.45:43298/?token=${TOKEN}#frag`);
  assert.equal(s.endpoint, "http://192.0.2.45:43298");
  assert.ok(!JSON.stringify(s).includes(TOKEN));
});

test("a credential-like path stays private while the probe keeps the configured base path", async () => {
  const svc = await startFakeService();
  const pathSecret = "route-secret-6c2858f1";
  const configured = `${svc.url}/gateway/${pathSecret}?token=${TOKEN}#frag`;
  try {
    const probe = new ServiceProbe({ timeoutMs: 1000, budgetMs: 900 });
    const out = await probe.describe({ env: { OPENAGI_IMESSAGE_NODE: configured } });
    const [imsg] = out;
    assert.equal(imsg.endpoint, svc.url, "only the origin is safe to display or propagate");
    assert.equal(imsg.host, new URL(svc.url).host);
    assert.equal(svc.seen[0].url, `/gateway/${pathSecret}/health`, "the private path still reaches the configured health route");
    assert.ok(!JSON.stringify(out).includes(pathSecret), "the path credential never reaches /nodes output");
    assert.ok(!JSON.stringify(out).includes(TOKEN), "query credentials are still discarded");
  } finally { await svc.close(); }
});

test("an unparseable endpoint is reported as misconfigured rather than crashing the roster", async () => {
  const probe = new ServiceProbe({ timeoutMs: 1000, budgetMs: 900 });
  const [imsg] = await probe.describe({ env: { OPENAGI_IMESSAGE_NODE: "not a url" } });
  assert.equal(imsg.configured, true);
  assert.equal(imsg.endpoint, null);
  assert.equal(imsg.reachability, "unreachable");
  assert.ok(imsg.detail?.includes("OPENAGI_IMESSAGE_NODE"));
});

test("readServiceConfig keeps the token out of the description it hands back", () => {
  const cfg = readServiceConfig({ env: { OPENAGI_IMESSAGE_NODE: "http://x:1", OPENAGI_IMESSAGE_NODE_TOKEN: TOKEN } });
  const entry = cfg.find((c) => c.kind.id === "imessage");
  assert.ok(entry.probeHeaders.authorization.includes(TOKEN), "the outbound header does carry it");
  assert.ok(entry.secrets.includes(TOKEN), "and it is registered for scrubbing out of error text");
});

// ---------------------------------------------------------------------------
// Route: GET /nodes on a main
// ---------------------------------------------------------------------------

const withEnv = async (vars, fn) => {
  const saved = new Map();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

test("GET /nodes on a main reports the configured service alongside the heartbeat roster", async () => {
  const svc = await startFakeService();
  await withEnv({ OPENAGI_IMESSAGE_NODE: svc.url, OPENAGI_IMESSAGE_NODE_TOKEN: TOKEN }, async () => {
    const dataDir = tmp("openagi-svc-main-");
    const { app, base } = await bootApp(dataDir);
    try {
      const res = await fetch(`${base}/nodes`);
      const text = await res.text();
      const json = JSON.parse(text);

      assert.ok(Array.isArray(json.services), "services is its own top-level array");
      const imsg = json.services.find((s) => s.id === "imessage");
      assert.ok(imsg, "the machine the user asked about is finally visible");
      assert.equal(imsg.reachability, "reachable");
      assert.equal(imsg.origin, "local", "this main is the one that has it configured");
      assert.equal(imsg.endpoint, svc.url);

      // It must NOT have been smuggled into the peer roster.
      assert.equal(json.nodes.length, 1, "the roster still contains only real OpenAGI installs");
      assert.equal(json.nodes[0].self, true);
      assert.ok(!json.nodes.some((n) => n.name === imsg.name), "a service is not a node");

      // Backward compatibility: an older client decodes these keys, and a
      // CHANGED key breaks it where an unknown key does not.
      for (const key of ["self", "nodes", "newestVersion", "updateCommand", "pairedTo", "stale", "cachedAt", "unreachableReason"]) {
        assert.ok(key in json, `existing key "${key}" is still present`);
      }
      assert.equal(typeof json.self.nodeId, "string");
      assert.equal(json.pairedTo, null);
      assert.equal(json.stale, false);

      assert.ok(!text.includes(TOKEN), "the token is not in the response bytes");
    } finally { await app.close(); }
  });
  await svc.close();
});

test("GET /nodes still answers promptly when the service machine is asleep", async () => {
  const hole = await startBlackHole();
  await withEnv({ OPENAGI_IMESSAGE_NODE: hole.url, OPENAGI_IMESSAGE_NODE_TOKEN: TOKEN }, async () => {
    const dataDir = tmp("openagi-svc-asleep-");
    const { app, base } = await bootApp(dataDir);
    try {
      const t0 = Date.now();
      const json = await (await fetch(`${base}/nodes`)).json();
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 3000, `the Nodes tab rendered in ${elapsed}ms despite a sleeping service`);
      assert.ok(json.nodes.some((n) => n.self === true), "the rest of the topology is intact");
      const imsg = json.services.find((s) => s.id === "imessage");
      assert.ok(["unknown", "unreachable"].includes(imsg.reachability));
      assert.notEqual(imsg.reachability, "reachable", "we never claim reachable without an answer");
    } finally { await app.close(); }
  });
  await hole.close();
});

test("the dashboard HTML never carries the service token", async () => {
  const svc = await startFakeService();
  // OPENAGI_AUTH_TOKEN gets us past the first-run wizard redirect so `/` is
  // really the dashboard; authToken is still null on the interface itself.
  await withEnv({
    OPENAGI_IMESSAGE_NODE: svc.url, OPENAGI_IMESSAGE_NODE_TOKEN: TOKEN, OPENAGI_AUTH_TOKEN: "dashboard-test"
  }, async () => {
    const dataDir = tmp("openagi-svc-html-");
    const { app, base } = await bootApp(dataDir);
    try {
      const html = await (await fetch(`${base}/`, {
        headers: { authorization: "Bearer dashboard-test" }
      })).text();
      assert.ok(html.includes("renderNodes"), "we really did fetch the dashboard");
      assert.ok(!html.includes(TOKEN), "no credential is baked into the page");
    } finally { await app.close(); }
  });
  await svc.close();
});

// ---------------------------------------------------------------------------
// Propagation: the main advertises its services to paired nodes
// ---------------------------------------------------------------------------

test("a paired node sees the main's service node, attributed to the main and never claimed as its own measurement", async () => {
  const svc = await startFakeService();
  await withEnv({ OPENAGI_IMESSAGE_NODE: svc.url, OPENAGI_IMESSAGE_NODE_TOKEN: TOKEN }, async () => {
    const mainDir = tmp("openagi-svc-prop-main-");
    const { app: mainApp, base: mainBase } = await bootApp(mainDir);
    const nodeDir = tmp("openagi-svc-prop-node-");
    writeNodeConfig({ remote: mainBase, token: null }, nodeDir);
    // The node has no iMessage config of its own: the local node renders the
    // topology while the remote main owns the service configuration.
    const { app: nodeApp, base: nodeBase } = await bootApp(nodeDir, { serviceEnv: {} });
    try {
      const res = await fetch(`${nodeBase}/nodes`);
      const text = await res.text();
      const json = JSON.parse(text);
      assert.equal(json.stale, false);
      const imsg = json.services.find((s) => s.id === "imessage" && s.origin === "main");
      assert.ok(imsg, "the local Nodes tab shows the service host too");
      assert.equal(imsg.endpoint, svc.url, "the address is carried onward so the row is identifiable");
      assert.ok(imsg.originName, "and the row says which machine has it configured");
      assert.equal(imsg.checkBasis, "reported", "this node did not probe it — the main did");
      assert.equal(imsg.reachability, "reachable");
      assert.ok(imsg.checkAgeMs !== null, "how long ago the main checked is part of the answer");
      assert.ok(!text.includes(TOKEN), "the main advertises the address, never the credential");
    } finally { await nodeApp.close(); await mainApp.close(); }
  });
  await svc.close();
});

test("adoptRemoteServices refuses to inherit a main's placeholder or a credentialed address", () => {
  const adopted = adoptRemoteServices([
    { kind: "service", id: "imessage", name: "iMessage", configured: true, endpoint: `http://u:${TOKEN}@host:1`, reachability: "reachable", checkedAt: new Date(Date.now() - 5000).toISOString() },
    { kind: "service", id: "ghost", configured: false, reachability: "not-configured" },
    { id: "weird", configured: true, reachability: "totally-fine" },
    "garbage"
  ], { originName: "Primary host", basis: "reported" });
  assert.equal(adopted.length, 2, "unconfigured placeholders are not propagated");
  const imsg = adopted.find((s) => s.id === "imessage");
  assert.equal(imsg.endpoint, "http://host:1", "re-scrubbed on receipt — we do not trust the main to have done it");
  assert.ok(!JSON.stringify(adopted).includes(TOKEN));
  assert.equal(imsg.origin, "main");
  assert.equal(imsg.originName, "Primary host");
  assert.ok(imsg.checkAgeMs >= 4000);
  assert.equal(adopted.find((s) => s.id === "weird").reachability, "unknown",
    "a reachability value we do not recognise is not passed through");
});

// The Nodes dashboard indexes a lookup table by `reachability`. A value that
// resolves on Object.prototype ("constructor", "__proto__") is not null, so it
// sails past a `?? fallback` and puts `undefined` into a class attribute. This
// pane already had one XSS finding; keep wire-supplied values off the prototype.
test("a reachability value that would reach Object.prototype is normalised away", () => {
  for (const hostile of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const [adopted] = adoptRemoteServices([
      { id: "imessage", configured: true, endpoint: "http://host:1", reachability: hostile }
    ], { originName: "m" });
    assert.equal(adopted.reachability, "unknown", `"${hostile}" must not survive`);
  }
});

test("a service name carrying markup crosses the wire intact but is never trusted as markup", () => {
  const payload = "<img src=x onerror=alert(1)>";
  const [adopted] = adoptRemoteServices([
    { id: "imessage", name: payload, configured: true, endpoint: "http://host:1", reachability: "reachable" }
  ], { originName: payload });
  // The API is a data channel, not a rendering one — it neither mangles nor
  // sanitises the name. escapeHtml at the render site is what makes it safe,
  // and this test exists so that stays a conscious contract.
  assert.equal(adopted.name, payload);
  assert.equal(adopted.originName, payload);
});

test("mergeServices prefers a service this machine measured itself over the main's report", () => {
  const local = [{ id: "imessage", configured: true, origin: "local", reachability: "reachable", checkBasis: "live" }];
  const remote = [{ id: "imessage", configured: true, origin: "main", reachability: "unreachable", checkBasis: "reported" }];
  const merged = mergeServices(local, remote);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].origin, "local", "first-hand beats second-hand");

  const placeholder = [{ id: "imessage", configured: false, origin: "local", reachability: "not-configured" }];
  const merged2 = mergeServices(placeholder, remote);
  assert.equal(merged2[0].origin, "main", "but a local placeholder yields to a real one from the main");
});

test("a paired node whose main is unreachable shows the inherited service as recalled, not current", async () => {
  const dataDir = tmp("openagi-svc-stalecache-");
  writeNodeConfig({ remote: "http://127.0.0.1:1", token: null }, dataDir);
  fs.mkdirSync(path.join(dataDir, "nodes"), { recursive: true });
  const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString();
  fs.writeFileSync(path.join(dataDir, "nodes", "cache.json"), JSON.stringify({
    self: { nodeId: "main-node", name: "Primary host", role: "main" },
    nodes: [],
    services: [{
      kind: "service", id: "imessage", name: "iMessage pass-through", configured: true,
      endpoint: "http://192.0.2.45:43298", host: "192.0.2.45:43298",
      reachability: "reachable", checkedAt: twoWeeksAgo, checkBasis: "live", origin: "local"
    }],
    cachedAt: twoWeeksAgo
  }));
  const { app, base } = await bootApp(dataDir);
  try {
    const json = await (await fetch(`${base}/nodes`)).json();
    assert.equal(json.stale, true);
    const imsg = json.services.find((s) => s.id === "imessage");
    assert.ok(imsg);
    assert.notEqual(imsg.checkBasis, "live", "a fortnight-old probe is not a live one");
    assert.equal(imsg.checkBasis, "cached");
    assert.ok(imsg.checkAgeMs > 13 * 86400000, "and the view can say how stale it is");
  } finally { await app.close(); }
});
