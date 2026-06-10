// test/mcp-http-interactive.test.js
// Regression for the latched-interactive bug: the OAuth "may I open a browser?"
// flag must be per-request, not stored on the client at connect time. A silent
// boot connect must not leave later tool calls unable to re-authorize.
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpHttpClient } from "../src/mcp-http-client.js";

test("interactive flag is threaded per-call, not latched on the client", async () => {
  const seen = [];
  const fakeOauth = {
    ensureToken: async ({ interactive }) => { seen.push(interactive); return "tok"; }
  };
  const client = new McpHttpClient({ name: "x", url: "https://example.test/mcp", oauth: fakeOauth });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const req = JSON.parse(opts.body);
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { tools: [] } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  try {
    await client.connect({ interactive: false }); // silent boot connect
    const duringConnect = [...seen];
    seen.length = 0;
    await client.callTool("foo", {}); // a later tool call, no explicit flag
    assert.ok(
      duringConnect.length >= 1 && duringConnect.every((i) => i === false),
      "every request in a silent connect must be non-interactive"
    );
    assert.deepEqual(
      seen, [true],
      "a tool call after a silent connect must default back to interactive (can re-auth)"
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});
