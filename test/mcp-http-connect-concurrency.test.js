import test from 'node:test';
import assert from 'node:assert/strict';
import { McpHttpClient } from '../src/mcp-http-client.js';

function fixture(t, { failFirst = false } = {}) {
  let initializes = 0;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const message = JSON.parse(options.body);
    calls.push(message);
    if (message.method === 'initialize') {
      const attempt = ++initializes;
      // Keep the handshake open while other callers arrive.
      await new Promise(resolve => setImmediate(resolve));
      if (failFirst && attempt === 1) throw new Error('fixture handshake unavailable');
      return Response.json({ id: message.id, result: { protocolVersion: '2025-03-26' } },
        { headers: { 'mcp-session-id': `fixture-session-${attempt}` } });
    }
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    assert.equal(options.headers['mcp-session-id'], `fixture-session-${initializes}`);
    return Response.json({ id: message.id, result: message.method === 'tools/list'
      ? { tools: [{ name: 'fixture_tool' }] } : { content: [{ type: 'text', text: message.params.arguments.value }] } });
  });
  return { calls, initializes: () => initializes };
}

test('concurrent first-use tool calls share one complete HTTP MCP handshake', async t => {
  const f = fixture(t);
  const client = new McpHttpClient({ url: 'https://example.invalid/mcp' });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => client.callTool('fixture_tool', { value: String(i) })));
  assert.equal(f.initializes(), 1);
  assert.equal(f.calls.filter(c => c.method === 'notifications/initialized').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'tools/list').length, 1);
  assert.deepEqual(results.map(r => r.content[0].text), Array.from({ length: 12 }, (_, i) => String(i)));
  assert.equal(client.connected, true);
  assert.equal(client.activeControllers.size, 0);
});

test('a failed shared handshake rejects every waiter and a later call retries once', async t => {
  const f = fixture(t, { failFirst: true });
  const client = new McpHttpClient({ url: 'https://example.invalid/mcp' });
  const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => client.callTool('fixture_tool')));
  assert.ok(attempts.every(r => r.status === 'rejected' && /fixture handshake unavailable/.test(r.reason.message)));
  assert.equal(f.initializes(), 1);
  assert.equal(f.calls.filter(c => c.method === 'tools/call').length, 0);
  assert.equal(client.connected, false);
  await client.callTool('fixture_tool', { value: 'retry' });
  assert.equal(f.initializes(), 2);
  assert.equal(client.lastError, null);
});

test('shared silent initialization does not latch interactivity on later tool calls', async t => {
  const f = fixture(t);
  const flags = [];
  const client = new McpHttpClient({ url: 'https://example.invalid/mcp', oauth: {
    ensureToken: async ({ interactive }) => { flags.push(interactive); return 'fixture'; }
  } });
  await Promise.all([client.connect({ interactive: false }), client.connect({ interactive: false })]);
  assert.equal(f.initializes(), 1);
  assert.deepEqual(flags, [false, false, false]);
  await client.callTool('fixture_tool', { value: 'later' });
  assert.equal(flags.at(-1), true);
});
