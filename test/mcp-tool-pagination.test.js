import test from "node:test";
import assert from "node:assert/strict";
import { McpHttpClient } from "../src/mcp-http-client.js";
import { McpStdioClient } from "../src/mcp-client.js";

const first = { name: "first", inputSchema: { type: "object" } };
const last = { name: "last", inputSchema: { type: "object" } };

for (const Client of [McpHttpClient, McpStdioClient]) {
  const transport = Client === McpHttpClient ? "HTTP" : "stdio";
  test(`${transport} refresh collects all pages, including empty intermediate pages`, async () => {
    const client = new Client({ url: "https://example.invalid/mcp" });
    client.connected = true;
    const params = [];
    client.request = async (method, input) => {
      assert.equal(method, "tools/list");
      params.push(input);
      if (!input.cursor) return { tools: [first], nextCursor: "opaque/+=" };
      if (input.cursor === "opaque/+=") return { tools: [], nextCursor: "final" };
      return { tools: [last] };
    };
    assert.deepEqual(await client.listTools(), [first, last]);
    assert.deepEqual(params, [{}, { cursor: "opaque/+=" }, { cursor: "final" }]);
  });

  for (const failure of ["request", "cycle", "invalid", "limit"]) {
    test(`${transport} ${failure} pagination failure preserves complete prior inventory`, async () => {
      const client = new Client({ url: "https://example.invalid/mcp" });
      client.connected = true;
      client.tools = [last];
      let calls = 0;
      client.request = async () => {
        calls++;
        if (failure === "request" && calls > 1) throw new Error("fixture page failed");
        if (failure === "invalid" && calls > 1) return { tools: null };
        return { tools: [first], nextCursor: failure === "limit" ? `page-${calls}` : "repeat" };
      };
      await assert.rejects(client.listTools(), /page failed|pagination|tools\/list/);
      assert.deepEqual(client.tools, [last]);
      assert.ok(calls <= 100, "pagination must be bounded");
    });
  }
}

test("HTTP silent connect discovers later pages without opening authorization", async t => {
  const interactive = [];
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const req = JSON.parse(options.body);
    calls.push(req);
    if (req.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = req.method === "initialize" ? { serverInfo: { name: "fixture" } }
      : req.params.cursor ? { tools: [last] } : { tools: [first], nextCursor: "next" };
    return Response.json({ jsonrpc: "2.0", id: req.id, result });
  });
  const client = new McpHttpClient({ url: "https://example.invalid/mcp", oauth: {
    ensureToken: async options => { interactive.push(options.interactive); return "fixture"; }
  } });
  assert.deepEqual((await client.connect({ interactive: false })).tools, [first, last]);
  assert.deepEqual(interactive, [false, false, false, false]);
  assert.equal(calls.at(-1).params.cursor, "next");
});

test("stdio connect discovers and can call a tool from a later page", async t => {
  const script = `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const req = JSON.parse(line);
      if (req.id == null) return;
      const result = req.method === 'initialize' ? { serverInfo: { name: 'fixture' } }
        : req.method === 'tools/call' ? { content: [{ type: 'text', text: req.params.name }] }
        : req.params.cursor ? { tools: [${JSON.stringify(last)}] }
        : { tools: [${JSON.stringify(first)}], nextCursor: 'next' };
      console.log(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
    });`;
  const client = new McpStdioClient({ name: "fixture", command: process.execPath, args: ["-e", script] });
  t.after(() => client.close());
  assert.deepEqual((await client.connect()).tools, [first, last]);
  assert.deepEqual(await client.callTool("last"), { content: [{ type: "text", text: "last" }] });
});
