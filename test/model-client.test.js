import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BREAKER_COOLDOWN_MS,
  HEALTH_TTL_MS,
  ModelClient,
  learnedMode
} from "../src/learning/model-client.js";

const TOKEN = "a".repeat(64);
// The first fetch in a process loads its HTTP stack, which can take longer
// than the 250 ms production deadline on a busy test machine. Tests that are
// not about timeouts use a generous one.
const TEST_TIMEOUT_MS = 2000;

function makeClient(options) {
  return new ModelClient({ timeoutMs: TEST_TIMEOUT_MS, ...options });
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-scoring-client-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeToken(dir, token = `${TOKEN}\n`) {
  const file = path.join(dir, "service.token");
  fs.writeFileSync(file, token, { mode: 0o600 });
  return file;
}

// A stub scoring service on an ephemeral loopback port. routes maps
// "METHOD /path" to (body, req) => ({ status, json } | { status, raw } | "hang").
async function startStub(t, routes = {}) {
  const requests = [];
  const hanging = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const key = `${req.method} ${req.url}`;
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ key, body, headers: req.headers });
      const route = routes[key];
      const reply = typeof route === "function" ? route(body, req) : route;
      if (reply === "hang") return hanging.push(res);
      if (!reply) {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end("{}");
      }
      res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...(reply.headers ?? {}) });
      res.end(reply.raw ?? JSON.stringify(reply.json ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const res of hanging) res.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, requests, routes };
}

function healthBody(overrides = {}) {
  return {
    ok: true,
    version: "v3",
    trained_through: "2026-01-31",
    heads: {
      t2: { labels: 140, auroc: 0.71, usable: true },
      value: { labels: 90, auroc: 0.58, usable: false }
    },
    thresholds: { suggestion: 0.18 },
    ...overrides
  };
}

function withoutEnv(t, keys) {
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}

test("disabled unless both the url and the token file are set: no requests, no file reads, no timers, no score", async (t) => {
  const dir = tempDir(t);
  const tokenFile = writeToken(dir);
  withoutEnv(t, ["OPENAGI_MODEL_URL", "OPENAGI_MODEL_TOKEN_FILE"]);

  const fetchCalls = [];
  const fetchImpl = async (...args) => { fetchCalls.push(args); throw new Error("must not be called"); };
  const reads = t.mock.method(fs, "readFileSync");
  const timeouts = t.mock.method(globalThis, "setTimeout");
  const intervals = t.mock.method(globalThis, "setInterval");
  const signalTimeouts = t.mock.method(AbortSignal, "timeout");

  const url = "http://127.0.0.1:43211";
  const clients = [
    new ModelClient({ tokenFile, fetchImpl }), // url unset
    new ModelClient({ url: "", tokenFile, fetchImpl }),
    new ModelClient({ fetchImpl }), // neither set
    new ModelClient({ url, fetchImpl }), // url set, token file unset: there is no default
    new ModelClient({ url, tokenFile: "  ", fetchImpl })
  ];
  for (const client of clients) {
    assert.equal(client.enabled(), false);
    assert.equal(await client.health(), null);
    assert.equal(client.usable("t2"), false);
    assert.equal(await client.scoreSuggestion({ title: "x", rationale: "y", category: "z" }), null);
    assert.equal(await client.scoreTurn({ agent_text: "x", prev_owner_text: "y" }), null);
    assert.equal(await client.scoreSignal({ text: "x", channel: "local" }), null);
    assert.equal(await client.keepScores([{ id: "m1", text: "x" }]), null);
    assert.equal(await client.clusterOf("x"), null);
    assert.equal(await client.clusters(), null);
    assert.equal(learnedMode("live", client), "off");
  }

  assert.equal(fetchCalls.length, 0);
  assert.equal(reads.mock.callCount(), 0, "not even the token file is read");
  assert.equal(timeouts.mock.callCount(), 0);
  assert.equal(intervals.mock.callCount(), 0);
  assert.equal(signalTimeouts.mock.callCount(), 0);
});

test("only loopback http(s) urls enable the client", (t) => {
  const tokenFile = writeToken(tempDir(t));
  const fetchImpl = async () => { throw new Error("unused"); };
  for (const url of ["http://127.0.0.1:43211", "http://localhost:43211/", "https://[::1]:43211", "http://127.0.0.1:43211/base/"]) {
    assert.equal(new ModelClient({ url, tokenFile, fetchImpl }).enabled(), true, url);
  }
  for (const url of ["http://192.0.2.10:43211", "http://example.com", "ftp://127.0.0.1:43211", "not a url", "  "]) {
    assert.equal(new ModelClient({ url, tokenFile, fetchImpl }).enabled(), false, url);
  }
  assert.equal(new ModelClient({ url: "" }).timeoutMs, 250, "the production deadline");
});

test("a missing, malformed or relative token file disables the client without a request; the env var supplies one", async (t) => {
  const dir = tempDir(t);
  const stub = await startStub(t, { "POST /score/suggestion": { json: { p_accept: 0.5 } } });
  const missing = makeClient({ url: stub.url, tokenFile: path.join(dir, "absent.token") });
  assert.equal(missing.enabled(), false);
  assert.equal(await missing.scoreSuggestion({ title: "x" }), null);
  assert.equal(learnedMode(undefined, missing), "off");

  const malformed = makeClient({ url: stub.url, tokenFile: writeToken(dir, "two words\n") });
  assert.equal(malformed.enabled(), false);
  const relative = makeClient({ url: stub.url, tokenFile: "service.token" });
  assert.equal(relative.enabled(), false);
  assert.equal(stub.requests.length, 0);

  // The token file may also come from the environment.
  withoutEnv(t, ["OPENAGI_MODEL_TOKEN_FILE"]);
  process.env.OPENAGI_MODEL_TOKEN_FILE = writeToken(dir);
  const fromEnv = makeClient({ url: stub.url });
  assert.deepEqual(await fromEnv.scoreSuggestion({ title: "x" }), { pAccept: 0.5, version: null });
  assert.equal(stub.requests[0].headers.authorization, `Bearer ${TOKEN}`);
});

test("the token is read once and sent as a bearer token", async (t) => {
  const dir = tempDir(t);
  const tokenFile = writeToken(dir);
  const stub = await startStub(t, { "POST /score/suggestion": { json: { p_accept: 0.42, version: "v3" } } });
  const client = makeClient({ url: stub.url, tokenFile });

  assert.deepEqual(await client.scoreSuggestion({ title: "Follow up", rationale: "r", category: "task" }), { pAccept: 0.42, version: "v3" });
  fs.writeFileSync(tokenFile, "b".repeat(64));
  await client.scoreSuggestion({ title: "Again" });
  fs.rmSync(tokenFile);
  assert.equal(client.enabled(), true);

  assert.equal(stub.requests.length, 2);
  for (const request of stub.requests) assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(stub.requests[0].body, { title: "Follow up", rationale: "r", category: "task" });
  assert.deepEqual(stub.requests[1].body, { title: "Again", rationale: "", category: "" });
});

test("each endpoint sends the contract fields and maps the response", async (t) => {
  const tokenFile = writeToken(tempDir(t));
  const stub = await startStub(t, {
    "POST /base/score/turn": { json: { p_stop: 0.1, p_nudge: 0.3, version: "v3" } },
    "POST /base/score/signal": (body) => ({ json: body.text === "untrained" ? { value: null } : { value: 0.64, version: "v3" } }),
    "POST /base/memory/keep": { json: { scores: { m1: 0.8, m2: 1.4, m3: "high" }, version: "v3" } },
    "POST /base/cluster-of": (body) => ({ json: body.text === "far" ? { cluster: null, similarity: 0.31 } : { cluster: 7, similarity: 0.82 } }),
    "GET /base/clusters": { json: [{ cluster: 7, n_7d: 12 }, { cluster: 9, n_7d: 0 }, { n_7d: 3 }] }
  });
  const client = makeClient({ url: `${stub.url}/base/`, tokenFile });

  assert.deepEqual(await client.scoreTurn({ agent_text: "done", prev_owner_text: "do it", provider: "openai", extra: "dropped" }),
    { pStop: 0.1, pNudge: 0.3, version: "v3" });
  assert.deepEqual(await client.scoreSignal({ text: "deploy", channel: "local" }), { value: 0.64, version: "v3" });
  assert.deepEqual(await client.scoreSignal({ text: "untrained", channel: "local" }), { value: null, version: null });
  assert.deepEqual(await client.keepScores([
    { id: "m1", text: "remember", tier: "short", kind: "raw", source: "chat", novelty: 0.4, risk: 0.1, repetition: 0, specificity: 0.7, strength: 0.5, content: "dropped" },
    { text: "no id" }
  ]), { scores: { m1: 0.8 }, version: "v3" });
  assert.deepEqual(await client.clusterOf("near"), { cluster: 7, similarity: 0.82 });
  assert.deepEqual(await client.clusterOf("far"), { cluster: null, similarity: 0.31 });
  assert.deepEqual(await client.clusters(), [{ cluster: 7, n7d: 12 }, { cluster: 9, n7d: 0 }]);

  const bodies = Object.fromEntries(stub.requests.map((r) => [r.key, r.body]));
  assert.deepEqual(bodies["POST /base/score/turn"], { agent_text: "done", prev_owner_text: "do it", provider: "openai" });
  assert.deepEqual(bodies["POST /base/memory/keep"], {
    items: [{ id: "m1", text: "remember", tier: "short", kind: "raw", source: "chat", novelty: 0.4, risk: 0.1, repetition: 0, specificity: 0.7, strength: 0.5 }]
  });

  // Inputs that cannot be scored are answered locally.
  const before = stub.requests.length;
  assert.equal(await client.keepScores([]), null);
  assert.equal(await client.keepScores("m1"), null);
  assert.equal(await client.clusterOf(""), null);
  assert.equal(await client.scoreSuggestion(null), null);
  assert.equal(stub.requests.length, before);
});

test("a timeout returns null, even when the fetch implementation ignores the signal", async (t) => {
  const tokenFile = writeToken(tempDir(t));
  const stub = await startStub(t, { "POST /score/suggestion": "hang" });
  const client = new ModelClient({ url: stub.url, tokenFile, timeoutMs: 50 });
  const started = Date.now();
  assert.equal(await client.scoreSuggestion({ title: "slow" }), null);
  assert.ok(Date.now() - started < 1000, "answered at the deadline, not when the service did");

  const stuck = new ModelClient({ url: stub.url, tokenFile, timeoutMs: 50, fetchImpl: () => new Promise(() => {}) });
  assert.equal(await stuck.scoreSignal({ text: "x", channel: "local" }), null);
});

test("refused, non-200, bad JSON, wrong shape and redirects all return null without throwing", async (t) => {
  const tokenFile = writeToken(tempDir(t));
  const target = await startStub(t);
  const refused = http.createServer();
  await new Promise((resolve) => refused.listen(0, "127.0.0.1", resolve));
  const refusedUrl = `http://127.0.0.1:${refused.address().port}`;
  await new Promise((resolve) => refused.close(resolve));
  assert.equal(await makeClient({ url: refusedUrl, tokenFile }).scoreSuggestion({ title: "x" }), null);

  const stub = await startStub(t, {
    "POST /score/suggestion": { status: 503, json: { error: "busy" } },
    "POST /score/turn": { raw: "not json" },
    "POST /score/signal": { json: { value: "high" } },
    "POST /memory/keep": { json: { scores: [0.5] } },
    "POST /cluster-of": { json: { similarity: 0.9 } },
    "GET /clusters": { json: { clusters: [] } },
    "GET /health": { status: 302, headers: { location: `${target.url}/health` } }
  });
  const client = makeClient({ url: stub.url, tokenFile });
  assert.equal(await client.scoreSuggestion({ title: "x" }), null);
  assert.equal(await client.scoreTurn({ agent_text: "x" }), null);
  assert.equal(await client.scoreSignal({ text: "x" }), null);
  // Out-of-range probabilities are a wrong shape too.
  stub.routes["POST /score/suggestion"] = { json: { p_accept: 1.5 } };
  assert.equal(await client.scoreSuggestion({ title: "x" }), null);

  const fresh = makeClient({ url: stub.url, tokenFile });
  assert.equal(await fresh.keepScores([{ id: "m1" }]), null);
  assert.equal(await fresh.clusterOf("x"), null);
  assert.equal(await fresh.clusters(), null);

  const redirected = makeClient({ url: stub.url, tokenFile });
  assert.equal(await redirected.health(), null);
  assert.equal(target.requests.length, 0, "redirects are not followed");

  const throwing = makeClient({ url: stub.url, tokenFile, fetchImpl: () => { throw new Error("sync"); } });
  assert.equal(await throwing.scoreSuggestion({ title: "x" }), null);
});

test("after the cooldown only one trial request goes out, however many callers arrive", async (t) => {
  const tokenFile = writeToken(tempDir(t));
  const stub = await startStub(t, { "POST /score/suggestion": { status: 500 } });
  let clock = 1_000_000;
  const client = makeClient({ url: stub.url, tokenFile, now: () => clock });
  for (let i = 0; i < 3; i += 1) await client.scoreSuggestion({ title: "x" });
  assert.equal(stub.requests.length, 3);
  clock += BREAKER_COOLDOWN_MS;
  const results = await Promise.all(Array.from({ length: 20 }, () => client.scoreSuggestion({ title: "x" })));
  assert.equal(stub.requests.length, 4, "one probe, not twenty");
  assert.ok(results.every((r) => r === null));
  stub.routes["POST /score/suggestion"] = { json: { p_accept: 0.5, version: "v1" } };
  clock += BREAKER_COOLDOWN_MS;
  const after = await Promise.all(Array.from({ length: 5 }, () => client.scoreSuggestion({ title: "x" })));
  assert.equal(stub.requests.length, 5, "the next cooldown again admits a single probe");
  assert.equal(after.filter((r) => r !== null).length, 1);
  assert.deepEqual(await client.scoreSuggestion({ title: "x" }), { pAccept: 0.5, version: "v1" }, "closed after a good probe");
});

test("the breaker opens after three consecutive failures and closes after 60 s", async (t) => {
  const tokenFile = writeToken(tempDir(t));
  const stub = await startStub(t, { "POST /score/suggestion": { status: 500 } });
  let clock = 1_000_000;
  const client = makeClient({ url: stub.url, tokenFile, now: () => clock });
  const calls = () => stub.requests.length;

  for (let i = 0; i < 3; i += 1) assert.equal(await client.scoreSuggestion({ title: "x" }), null);
  assert.equal(calls(), 3);
  assert.equal(await client.scoreSuggestion({ title: "x" }), null);
  assert.equal(await client.health(), null);
  assert.equal(calls(), 3, "open: no request");

  clock += BREAKER_COOLDOWN_MS - 1;
  await client.scoreSuggestion({ title: "x" });
  assert.equal(calls(), 3, "still open just before 60 s");

  clock += 1;
  await client.scoreSuggestion({ title: "x" });
  assert.equal(calls(), 4, "a trial request after 60 s");
  await client.scoreSuggestion({ title: "x" });
  assert.equal(calls(), 4, "the failed trial reopens it");

  stub.routes["POST /score/suggestion"] = { json: { p_accept: 0.9, version: "v3" } };
  clock += BREAKER_COOLDOWN_MS;
  assert.deepEqual(await client.scoreSuggestion({ title: "x" }), { pAccept: 0.9, version: "v3" });

  // A success resets the count: two new failures do not open it.
  stub.routes["POST /score/suggestion"] = { status: 500 };
  await client.scoreSuggestion({ title: "x" });
  await client.scoreSuggestion({ title: "x" });
  stub.routes["POST /score/suggestion"] = { json: { p_accept: 0.2 } };
  assert.deepEqual(await client.scoreSuggestion({ title: "x" }), { pAccept: 0.2, version: null });
});

test("health is cached for 60 s and concurrent callers share one request", async (t) => {
  const tokenFile = writeToken(tempDir(t));
  const stub = await startStub(t, { "GET /health": { json: healthBody() } });
  let clock = 5_000_000;
  const client = makeClient({ url: stub.url, tokenFile, now: () => clock });

  const [a, b] = await Promise.all([client.health(), client.health()]);
  assert.deepEqual(a, {
    ok: true,
    version: "v3",
    trainedThrough: "2026-01-31",
    heads: { t2: { labels: 140, auroc: 0.71, usable: true }, value: { labels: 90, auroc: 0.58, usable: false } },
    thresholds: { suggestion: 0.18 }
  });
  assert.equal(b, a);
  clock += HEALTH_TTL_MS - 1;
  await client.health();
  assert.equal(stub.requests.length, 1);
  clock += 1;
  await client.health();
  assert.equal(stub.requests.length, 2);
});

test("usable follows /health and is false when the health is unknown", async (t) => {
  const tokenFile = writeToken(tempDir(t));
  const stub = await startStub(t, { "GET /health": { json: healthBody() } });
  let clock = 9_000_000;
  const client = makeClient({ url: stub.url, tokenFile, now: () => clock });

  assert.equal(client.usable("t2"), false, "unknown before the first health answer");
  await client.health(); // the refresh usable() started
  assert.equal(stub.requests.length, 1);
  assert.equal(client.usable("t2"), true);
  assert.equal(client.usable("value"), false);
  assert.equal(client.usable("missing"), false);
  assert.equal(client.usable("constructor"), false);

  stub.routes["GET /health"] = { json: healthBody({ heads: { t2: { labels: 140, auroc: 0.6, usable: false } } }) };
  clock += HEALTH_TTL_MS;
  assert.equal(client.usable("t2"), true, "the stale answer holds while it refreshes");
  await client.health();
  assert.equal(client.usable("t2"), false);

  stub.routes["GET /health"] = { json: healthBody({ ok: false }) };
  clock += HEALTH_TTL_MS;
  await client.health();
  assert.equal(client.usable("value"), false);
  assert.equal(client.usable("t2"), false, "ok false makes every head unusable");

  stub.routes["GET /health"] = { json: healthBody() };
  clock += HEALTH_TTL_MS;
  await client.health();
  assert.equal(client.usable("t2"), true);
  stub.routes["GET /health"] = { status: 500 };
  clock += HEALTH_TTL_MS;
  await client.health();
  assert.equal(client.usable("t2"), false, "a failed refresh forgets the old answer");
});

test("learnedMode: off without an enabled client or when off; live only for exactly live; otherwise shadow", (t) => {
  const tokenFile = writeToken(tempDir(t));
  const enabled = new ModelClient({ url: "http://127.0.0.1:43211", tokenFile, fetchImpl: async () => { throw new Error("unused"); } });
  const disabled = new ModelClient({ url: "", tokenFile });

  assert.equal(learnedMode("live", null), "off");
  assert.equal(learnedMode("live", undefined), "off");
  assert.equal(learnedMode("live", disabled), "off");
  assert.equal(learnedMode("live", { enabled() { throw new Error("broken"); } }), "off");
  assert.equal(learnedMode("off", enabled), "off");
  assert.equal(learnedMode("live", enabled), "live");
  for (const flag of [undefined, "", "shadow", "LIVE", " live", "on", "1"]) {
    assert.equal(learnedMode(flag, enabled), "shadow", String(flag));
  }
});

test("the runtime builds an inert client by default and a turn never calls it", async (t) => {
  const { createDurableRuntime, DeterministicModelProvider } = await import("../src/index.js");
  const dataDir = tempDir(t);
  withoutEnv(t, ["OPENAGI_MODEL_URL", "OPENAGI_MODEL_TOKEN_FILE"]);

  const plain = createDurableRuntime({ dataDir, modelProvider: new DeterministicModelProvider(), autoConnectMcp: false });
  assert.ok(plain.modelClient instanceof ModelClient);
  assert.equal(plain.modelClient.enabled(), false);

  const fetchCalls = [];
  const modelClient = new ModelClient({ tokenFile: writeToken(dataDir), fetchImpl: async (...args) => { fetchCalls.push(args); throw new Error("must not be called"); } });
  const runtime = createDurableRuntime({ dataDir: path.join(dataDir, "spy"), modelProvider: new DeterministicModelProvider(), autoConnectMcp: false, modelClient });
  assert.equal(runtime.modelClient, modelClient);
  await runtime.agentHost.handleMessage({ channel: "local", from: "user", text: "remind me to review the deploy notes" });
  runtime.processIntegrationEvent("abi", { summary: "A repeated task", content: "Same steps again.", risk: 0.4, repetition: 0.8 });
  assert.equal(fetchCalls.length, 0);
});
