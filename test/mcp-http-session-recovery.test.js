import test from "node:test";
import assert from "node:assert/strict";
import { McpHttpClient } from "../src/mcp-http-client.js";

function connectedClient() {
  const client = new McpHttpClient({ url: "https://example.invalid/mcp" });
  client.connected = true;
  client.sessionId = "expired-fixture";
  return client;
}

test("expired session rejects the action once and the next call establishes a new session", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const message = JSON.parse(options.body);
    calls.push({ method: message.method, session: options.headers["mcp-session-id"] });
    if (calls.length === 1) return new Response("Session expired", { status: 404 });
    if (message.method === "initialize") {
      assert.equal(options.headers["mcp-session-id"], undefined);
      return Response.json({ id: message.id, result: { capabilities: { tools: {} } } }, { headers: { "mcp-session-id": "fresh-fixture" } });
    }
    assert.equal(options.headers["mcp-session-id"], "fresh-fixture");
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    return Response.json({ id: message.id, result: message.method === "tools/list" ? { tools: [{ name: "read_fixture" }] } : { content: [] } });
  });
  const client = connectedClient();
  await assert.rejects(client.callTool("write_fixture", {}), /404/);
  assert.equal(calls.length, 1, "never replay an action that might have side effects");
  assert.equal(client.connected, false);
  assert.equal(client.sessionId, null);
  assert.deepEqual(await client.callTool("read_fixture", {}), { content: [] });
  assert.deepEqual(calls.map(x => x.method), ["tools/call", "initialize", "notifications/initialized", "tools/list", "tools/call"]);
  assert.equal(client.connected, true);
  assert.equal(client.activeControllers.size, 0);
});

test("a late expired-session response cannot invalidate a newer session", async t => {
  let reply;
  t.mock.method(globalThis, "fetch", () => new Promise(resolve => { reply = resolve; }));
  const client = connectedClient();
  const pending = client.callTool("read_fixture", {});
  client.sessionId = "newer-fixture";
  reply(new Response("Expired", { status: 404 }));
  await assert.rejects(pending, /404/);
  assert.equal(client.connected, true);
  assert.equal(client.sessionId, "newer-fixture");
});

for (const status of [403, 500]) {
  test(`HTTP ${status} does not discard an established session`, async t => {
    t.mock.method(globalThis, "fetch", async () => new Response("Fixture error", { status }));
    const client = connectedClient();
    await assert.rejects(client.callTool("read_fixture", {}), new RegExp(String(status)));
    assert.equal(client.connected, true);
    assert.equal(client.sessionId, "expired-fixture");
  });
}
