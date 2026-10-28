import test from "node:test";
import assert from "node:assert/strict";
import { McpHttpClient } from "../src/mcp-http-client.js";

function stalledResponse(t, contentType) {
  let body;
  let signal;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({
      start(controller) {
        body = controller;
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      }
    }), { headers: { "content-type": contentType } });
  });
  t.after(() => { try { body.error(new Error("fixture cleanup")); } catch {} });
  return () => signal;
}

for (const contentType of ["application/json", "text/event-stream"]) {
  test(`deadline covers stalled ${contentType} response body`, async t => {
    stalledResponse(t, contentType);
    const client = new McpHttpClient({ url: "https://example.invalid/mcp", timeoutMs: 25 });
    const outcome = client.request("tools/call", {}).then(() => "resolved", () => "rejected");
    const result = await Promise.race([outcome, new Promise(resolve => setTimeout(() => resolve("hung"), 150))]);
    assert.equal(result, "rejected");
    assert.equal(client.activeControllers.size, 0);
  });

  test(`disconnect aborts pending ${contentType} response body`, async t => {
    const getSignal = stalledResponse(t, contentType);
    const client = new McpHttpClient({ url: "https://example.invalid/mcp", timeoutMs: 1000 });
    const outcome = client.request("tools/call", {}).then(() => "resolved", () => "rejected");
    await new Promise(resolve => setImmediate(resolve));
    await client.close();
    assert.equal(getSignal().aborted, true);
    assert.equal(await outcome, "rejected");
    assert.equal(client.activeControllers.size, 0);
  });
}

test("SSE JSON-RPC errors reject immediately and release the response stream", async t => {
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"fixture failure"}}\n\n'));
    },
    cancel() { cancelled = true; }
  }), { headers: { "content-type": "text/event-stream" } }));
  const client = new McpHttpClient({ url: "https://example.invalid/mcp", timeoutMs: 25 });
  await assert.rejects(client.request("tools/call", {}), /fixture failure/);
  assert.equal(cancelled, true);
  assert.equal(client.activeControllers.size, 0);
});

test("successful SSE responses release an open stream after interleaved notifications", async t => {
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"method":"notifications/progress"}\n\ndata: {"id":1,"result":{"tools":[]}}\n\n'));
    },
    cancel() { cancelled = true; }
  }), { headers: { "content-type": "text/event-stream" } }));
  const client = new McpHttpClient({ url: "https://example.invalid/mcp" });
  assert.deepEqual(await client.request("tools/list", {}), { tools: [] });
  assert.equal(cancelled, true);
  assert.equal(client.activeControllers.size, 0);
});

test("OAuth retry cancels the rejected body and retains per-request interactivity", async t => {
  let cancelled = false;
  const interactive = [];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (++calls === 1) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 401 });
    const message = JSON.parse(options.body);
    return Response.json({ id: message.id, result: { tools: [] } });
  });
  const client = new McpHttpClient({ url: "https://example.invalid/mcp", oauth: {
    ensureToken: async options => { interactive.push(options.interactive); return "fixture"; },
    loadCache: () => ({}), saveCache: () => {}
  } });
  assert.deepEqual(await client.request("tools/list", {}, { interactive: false }), { tools: [] });
  assert.equal(cancelled, true);
  assert.deepEqual(interactive, [false, false]);
  assert.equal(client.activeControllers.size, 0);
});

for (const ending of ["\n", "\r\n", "\r"]) {
  test(`SSE accepts ${JSON.stringify(ending)} line endings across byte chunks`, async () => {
    const client = new McpHttpClient({ url: "https://mcp.example.invalid" });
    const wire = `: heartbeat${ending}${ending}data: {"method":"notice"}${ending}${ending}data: {"id":7,${ending}data: "result":{"ok":true}}${ending}${ending}`;
    let cancelled = false;
    let deadline;
    let streamController;
    const bytes = new TextEncoder().encode(wire);
    const body = new ReadableStream({
      start(controller) { streamController = controller; for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); },
      cancel() { cancelled = true; }
    });
    try {
      // Leave the connection open, as real SSE servers do. A missing frame
      // delimiter must fail promptly rather than hanging the test runner.
      const result = await Promise.race([
        client.readSseForResponse(new Response(body), 7),
        new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("reply was not parsed")), 500); })
      ]);
      assert.deepEqual(result, { ok: true });
      assert.equal(cancelled, true);
      assert.equal(body.locked, false);
    } finally {
      clearTimeout(deadline);
      try { streamController.error(new Error("fixture cleanup")); } catch {}
      if (!body.locked) await body.cancel().catch(() => {});
    }
  });
}
