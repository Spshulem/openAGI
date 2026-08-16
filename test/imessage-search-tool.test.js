// search_imessages tool (main side) proxies to the node; iMessage node service
// (node side) serves auth-gated search over chat.db.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ToolRegistry } from "../src/index.js";
import { registerImessageSearchTool } from "../src/integrations/imessage-search-tool.js";
import { createImessageServer } from "../src/integrations/imessage-server.js";

const withEnv = (k, v, fn) => {
  const saved = process.env[k];
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { return fn(); } finally { if (saved === undefined) delete process.env[k]; else process.env[k] = saved; }
};

test("tool is not registered before either transport exists", () => {
  withEnv("OPENAGI_IMESSAGE_NODE", undefined, () => {
    const runtime = { tools: new ToolRegistry() };
    const r = registerImessageSearchTool(runtime);
    assert.equal(r.registered, false);
    assert.equal(runtime.tools.has("search_imessages"), false);
  });
});

function pairedRuntime(nodes, dispatch) {
  return {
    tools: new ToolRegistry(),
    nodeCapabilities: {
      list: () => nodes,
      resolve: (_capability, selector = {}) => {
        const wanted = selector.nodeId ?? selector.nodeName ?? null;
        if (!wanted) return nodes.length === 1 ? nodes[0] : null;
        return nodes.find((node) => node.nodeId === wanted || node.name === wanted) ?? null;
      },
      dispatch
    }
  };
}

const readyNode = (nodeId, name = null) => ({
  nodeId,
  name,
  capabilities: [{ id: "imessage-search", ready: true, operations: ["search"] }]
});

test("tool dispatches through the authenticated paired-node capability", async () => {
  const seen = [];
  const runtime = pairedRuntime([readyNode("node-1", "Office Mac")], async (...args) => {
    seen.push(args);
    return { results: [{ handle: "+1555", fromMe: false, date: "2026-04-13T12:00:00Z", text: "dinner at 7" }] };
  });
  assert.equal(registerImessageSearchTool(runtime).registered, true);
  assert.equal(runtime.tools.get("search_imessages").sideEffects, false, "search is read-only");

  const out = await runtime.tools.invoke("search_imessages", { query: "dinner", person: "sarah", days: 7 });
  assert.equal(out.ok, true);
  assert.equal(out.result.count, 1);
  assert.equal(out.result.results[0].from, "+1555");
  assert.match(out.result.results[0].text, /dinner at 7/);
  assert.deepEqual(seen[0].slice(0, 4), [
    "node-1",
    "imessage-search",
    "search",
    { query: "dinner", person: "sarah", days: 7, limit: 20 }
  ]);
});

test("multiple paired nodes require an explicit immutable selector", async () => {
  const seen = [];
  const nodes = [readyNode("one", "Work Mac"), readyNode("two", "Home Mac")];
  const runtime = pairedRuntime(nodes, async (...args) => { seen.push(args); return { results: [] }; });
  registerImessageSearchTool(runtime);
  const ambiguous = await runtime.tools.invoke("search_imessages", { query: "x" });
  assert.match(ambiguous.result.error, /Multiple/);
  assert.equal(seen.length, 0);

  const selected = await runtime.tools.invoke("search_imessages", { query: "x", node: "Home Mac" });
  assert.equal(selected.ok, true);
  assert.equal(seen[0][0], "two");
});

test("paired transport returns categorical errors without leaking node diagnostics", async () => {
  const runtime = pairedRuntime([readyNode("node-1")], async () => {
    throw new Error("secret token at /Users/private/Library/Messages/chat.db");
  });
  registerImessageSearchTool(runtime);
  const out = await runtime.tools.invoke("search_imessages", { query: "x" });
  assert.match(out.result.error, /could not complete/);
  assert.doesNotMatch(out.result.error, /secret|Users|chat\.db/i);
});

test("legacy transport requires HTTPS outside loopback", () => {
  const runtime = { tools: new ToolRegistry() };
  const result = registerImessageSearchTool(runtime, {
    env: { OPENAGI_IMESSAGE_NODE: "http://node.example.test:43298", OPENAGI_IMESSAGE_NODE_TOKEN: "secret" }
  });
  assert.equal(result.registered, false);
  assert.equal(runtime.tools.has("search_imessages"), false);
});

test("secure legacy transport is bounded, authenticated, and does not expose its endpoint", async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, auth: opts.headers.authorization, redirect: opts.redirect, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ results: [{ handle: "+1555", fromMe: false, date: "2026-04-13T12:00:00Z", text: "dinner at 7" }] }) };
  };
  const runtime = { tools: new ToolRegistry() };
  assert.equal(registerImessageSearchTool(runtime, {
    fetchImpl,
    env: { OPENAGI_IMESSAGE_NODE: "https://messages.example.test", OPENAGI_IMESSAGE_NODE_TOKEN: "secret" }
  }).registered, true);

  const out = await runtime.tools.invoke("search_imessages", { query: "dinner", person: "sarah", days: 7 });
  assert.equal(out.result.count, 1);
  assert.equal(seen[0].url, "https://messages.example.test/search");
  assert.equal(seen[0].auth, "Bearer secret");
  assert.equal(seen[0].redirect, "manual");
  assert.deepEqual(seen[0].body, { query: "dinner", handle: "sarah", days: 7, limit: 20 });
});

test("legacy failures and oversized bodies return a generic bounded error", async () => {
  const env = { OPENAGI_IMESSAGE_NODE: "https://messages.example.test" };
  const runtime = { tools: new ToolRegistry() };
  registerImessageSearchTool(runtime, {
    env,
    fetchImpl: async () => ({ ok: true, json: async () => ({ secret: "x".repeat(1024 * 1024 + 1) }) })
  });
  const out = await runtime.tools.invoke("search_imessages", { query: "x" });
  assert.match(out.result.error, /legacy iMessage service/);
  assert.doesNotMatch(out.result.error, /example|secret/i);
});

async function makeChatDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatdb-srv-"));
  const file = path.join(dir, "chat.db");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
           CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB, is_from_me INTEGER, date INTEGER, handle_id INTEGER);`);
  db.prepare("INSERT INTO handle (ROWID,id) VALUES (1,?)").run("+15551112222");
  const ns = String(BigInt(Date.now() - 978307200000) * 1000000n);
  db.prepare("INSERT INTO message (text,is_from_me,date,handle_id) VALUES (?,?,?,?)").run("the gate code is 4821", 0, ns, 1);
  db.close();
  return file;
}

test("node service: rejects bad token, serves search with the right token", async () => {
  const dbPath = await makeChatDb();
  const server = createImessageServer({ token: "tok", dbPath });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // health is open
    assert.equal((await fetch(`${base}/health`)).status, 200);
    // no/bad token → 401
    assert.equal((await fetch(`${base}/search`, { method: "POST", body: "{}" })).status, 401);
    // right token → results
    const res = await fetch(`${base}/search`, {
      method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ query: "gate code" })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.results.length, 1);
    assert.match(body.results[0].text, /gate code is 4821/);
  } finally {
    server.close();
  }
});
