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

test("tool not registered without OPENAGI_IMESSAGE_NODE", () => {
  withEnv("OPENAGI_IMESSAGE_NODE", undefined, () => {
    const runtime = { tools: new ToolRegistry() };
    const r = registerImessageSearchTool(runtime);
    assert.equal(r.registered, false);
    assert.equal(runtime.tools.has("search_imessages"), false);
  });
});

test("tool registers + proxies to the node with auth", async () => {
  await withEnv("OPENAGI_IMESSAGE_NODE", "http://node:43298", async () => {
    await withEnv("OPENAGI_IMESSAGE_NODE_TOKEN", "secret", async () => {
      const seen = [];
      const fetchImpl = async (url, opts) => {
        seen.push({ url, auth: opts.headers.authorization, body: JSON.parse(opts.body) });
        return { ok: true, json: async () => ({ results: [{ handle: "+1555", fromMe: false, date: "2026-04-13T12:00:00Z", text: "dinner at 7" }] }) };
      };
      const runtime = { tools: new ToolRegistry() };
      assert.equal(registerImessageSearchTool(runtime, { fetchImpl }).registered, true);
      assert.equal(runtime.tools.get("search_imessages").sideEffects, false, "search is read-only");

      const out = await runtime.tools.invoke("search_imessages", { query: "dinner", person: "sarah", days: 7 });
      assert.ok(out.ok);
      assert.equal(out.result.count, 1);
      assert.equal(out.result.results[0].from, "+1555");
      assert.match(out.result.results[0].text, /dinner at 7/);
      assert.equal(seen[0].url, "http://node:43298/search");
      assert.equal(seen[0].auth, "Bearer secret");
      assert.deepEqual(seen[0].body, { query: "dinner", handle: "sarah", days: 7, limit: 20 });
    });
  });
});

test("tool returns a friendly error when the node is unreachable", async () => {
  await withEnv("OPENAGI_IMESSAGE_NODE", "http://node:43298", async () => {
    const runtime = { tools: new ToolRegistry() };
    registerImessageSearchTool(runtime, { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
    const out = await runtime.tools.invoke("search_imessages", { query: "x" });
    assert.match(out.result.error, /couldn't reach the iMessage node/);
  });
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
