import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { handleSupervisorRequest, localBridgeFetch } from "../scripts/coding-supervisor-adapter.mjs";

const target = { provider: "codex", id: "session-12345678", cwd: "/fixture/project", file: "/fixture/session.jsonl", project: "Fixture", status: "idle", sendVia: "even-terminal" };
function fixture(patch = {}) {
  const delivered = [];
  const lib = {
    discoverSessions: async () => [{ ...target, ...patch }], readSessionRecords: () => [],
    readG2Config: async () => ({ provider: "claude", url: "http://localhost:1234", codexUrl: "http://localhost:1235" }),
    getG2Status: async () => ({ state: "missing" }),
    postG2Prompt: async (config, message, sessionId) => { delivered.push({ config, message, sessionId }); return { sessionId }; }
  };
  const attach = { annotateTargets: (s) => s, claudeAttachments: () => new Map(), readClaudeRegistry: () => [] };
  const inspect = { extractTurns: () => [{ role: "assistant", text: "Fixture" }] };
  const deps = { lib, attach, inspect };
  return { deps, delivered, async request(operation, rest = {}) { return handleSupervisorRequest({ version: 1, operation, provider: target.provider, sessionId: target.id, ...rest }, deps); } };
}

test("adapter lists and inspects without exposing paths or bridge configuration", async () => {
  const f = fixture();
  const list = await f.request("list");
  assert.equal(list.sessions[0].replyAvailable, true);
  assert.doesNotMatch(JSON.stringify(list), /\/fixture|localhost/);
  assert.equal((await f.request("inspect")).turns.length, 1);
  assert.equal(f.delivered.length, 0);
});

test("adapter routes exact ID/provider/cwd to the correct bridge, not the display session", async () => {
  const f = fixture();
  const { fingerprint } = (await f.request("list")).sessions[0];
  const result = await f.request("reply", { fingerprint, message: "Fixture instruction" });
  assert.equal(result.status, "accepted");
  assert.equal(f.delivered[0].config.url, "http://localhost:1235");
  assert.equal(f.delivered[0].config.cwd, target.cwd);
  assert.equal(f.delivered[0].sessionId, target.id);
});

test("active/manual Claude sessions are not killed, relayed by an LLM, or resumed", async () => {
  for (const sendVia of ["manual", "sendmessage"]) {
    const f = fixture({ provider: "claude", sendVia, pid: 123 });
    const { fingerprint, replyAvailable } = (await f.request("list")).sessions[0];
    assert.equal(replyAvailable, false);
    await assert.rejects(f.request("reply", { provider: "claude", fingerprint, message: "Fixture" }));
    assert.equal(f.delivered.length, 0);
  }
});

test("busy and awaiting-provider-approval sessions return a blocked receipt without sending", async () => {
  for (const state of ["working", "awaiting", "unknown"]) {
    const f = fixture();
    f.deps.lib.getG2Status = async () => ({ state });
    const { fingerprint } = (await f.request("list")).sessions[0];
    assert.equal((await f.request("reply", { fingerprint, message: "Fixture" })).status, "blocked");
    assert.equal(f.delivered.length, 0);
  }
});

test("wrong IDs, changed targets and oversized replies cannot be delivered", async () => {
  const f = fixture();
  await assert.rejects(f.request("inspect", { sessionId: "session-1234" }));
  const { fingerprint } = (await f.request("list")).sessions[0];
  await assert.rejects(f.request("reply", { fingerprint: "wrong", message: "Fixture" }));
  await assert.rejects(f.request("reply", { fingerprint, message: "x".repeat(4001) }));
  f.deps.lib.postG2Prompt = async () => ({ sessionId: "wrong-session" });
  await assert.rejects(f.request("reply", { fingerprint, message: "Fixture" }));
});

test("missing delivery configuration still supports discovery", async () => {
  const f = fixture();
  f.deps.lib.readG2Config = async () => { throw new Error("missing"); };
  assert.equal((await f.request("list")).sessions[0].replyAvailable, false);
});

test("bridge credential fetch refuses remote, credentialed, and unrelated endpoints", async () => {
  for (const url of ["https://example.com/api/prompt", "http://example.com/api/status", "http://user:pass@localhost/api/status", "http://localhost/delete"]) {
    await assert.rejects(localBridgeFetch(url), /local HTTP/);
  }
});

test("bridge fetch rejects redirects and bounds bodies and body deadlines", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/status") { res.writeHead(302, { location: "/api/prompt" }); res.end(); }
    else if (req.headers["x-test"] === "large") res.end("x".repeat(1024 * 1024 + 1));
    else { res.writeHead(200); res.flushHeaders(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(localBridgeFetch(`${base}/api/status`));
  await assert.rejects(localBridgeFetch(`${base}/api/prompt`, { headers: { "x-test": "large" } }), /limit/);
  await assert.rejects(localBridgeFetch(`${base}/api/prompt`, { signal: AbortSignal.timeout(50) }));
});
