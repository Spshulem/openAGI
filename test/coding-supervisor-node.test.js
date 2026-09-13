import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodingSupervisor } from '../src/coding-supervisor.js';
import { createCodingNodeCapability } from '../src/coding-supervisor-node.js';

test('optional discovery failures preserve managed sessions and propagate a safe warning', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-node-discovery-'));
  const managed = { provider: 'codex', sessionId: 'managed-session-123', fingerprint: 'a'.repeat(64), status: 'idle', replyAvailable: true };
  const external = { ...managed, sessionId: 'external-session-123' };
  let discovered;
  const node = createCodingNodeCapability({ dataDir: path.join(dir, 'node'), externalCall: async () => {
    if (discovered instanceof Error) throw discovered;
    return discovered;
  } });
  node.supervisor.builtin.list = () => ({ sessions: [managed] });
  const main = new CodingSupervisor({ dataDir: path.join(dir, 'main'), call: () => node.execute({ capability: 'coding-supervisor', operation: 'list', payload: { operation: 'list' } }) });
  t.after(() => { main.stop(); node.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (const failure of [new Error('private backend detail'), {}, { sessions: [external, external] }, { sessions: [{ ...external, sessionId: 'bad' }] }, { sessions: [{ ...external, status: 'unknown' }] }]) {
    discovered = failure;
    const snapshot = await main.list();
    assert.deepEqual(snapshot.sessions.map(row => row.sessionId), [managed.sessionId]);
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.discoveryIncomplete, true);
    assert.match(snapshot.warning, /not a complete inventory/);
    await assert.rejects(node.supervisor.prepareReply({ ...external, message: 'Do not send' }));
  }
  discovered = { sessions: [external] };
  assert.equal((await main.list()).sessions.length, 2);
  assert.equal(main.lastSnapshot.warning, null);
  discovered = { sessions: [external, { ...external, sessionId: 'duplicate-session-123' },
    { ...external, sessionId: 'duplicate-session-123', fingerprint: 'invalid' }, { ...external, sessionId: 'bad' }] };
  const partial = await main.list();
  assert.deepEqual(partial.sessions.map(row => row.sessionId), [managed.sessionId, external.sessionId]);
  assert.equal(partial.discoveryIncomplete, true);
  await assert.rejects(node.supervisor.prepareReply({ ...external, sessionId: 'duplicate-session-123', message: 'Do not send' }));
});

test('remote coding node binds approvals to the node and refuses unsupported operations', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-node-'));
  const target = { provider: 'codex', sessionId: 'fixture-session-123', fingerprint: 'a'.repeat(64), status: 'idle', replyAvailable: true };
  let deliveries = 0;
  const node = createCodingNodeCapability({ dataDir: path.join(dir, 'node'), externalCall: async request => {
    if (request.operation === 'list') return { sessions: [target] };
    if (request.operation === 'inspect') return { turns: [{ role: 'assistant', text: 'Fixture only' }] };
    deliveries++; return { ...target, status: 'accepted' };
  } });
  const runtime = { nodeCapabilities: { dispatch: async (nodeId, capability, operation, payload) => {
    assert.equal(nodeId, 'node-a'); return node.execute({ capability, operation, payload });
  } } };
  const main = new CodingSupervisor({ dataDir: path.join(dir, 'main'), runtime, remoteNodeId: 'node-a' });
  t.after(() => { main.stop(); node.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await main.list()).sessions.length, 1);
  assert.equal((await main.setup()).remote, true);
  await assert.rejects(main.configure({ enabled: true, workspaces: ['/'] }), /project folder/);
  await assert.rejects(node.execute({ capability: 'coding-supervisor', operation: 'stop', payload: { operation: 'stop', ...target } }), /Unknown managed/);
  assert.equal((await main.inspect(target)).turns[0].text, 'Fixture only');
  const prepared = await main.prepareReply({ ...target, message: 'Fixture nudge' });
  // Main is two seconds ahead of the node; legitimate freshly approved work
  // must pass, while a substantially future-dated approval remains invalid.
  node.supervisor.now = () => prepared.preparedAt - 2000;
  await assert.rejects(node.supervisor.reply({ ...prepared, preparedAt: prepared.preparedAt + 60_000 }), /expired/);
  assert.equal(deliveries, 0);
  assert.equal(prepared.codingNodeId, 'node-a');
  await assert.rejects(main.reply({ ...prepared, codingNodeId: 'node-b' }), /node changed/);
  await assert.rejects(node.execute({ capability: 'coding-supervisor', operation: 'shell', payload: {} }));
  await assert.rejects(node.execute({ capability: 'coding-supervisor', operation: 'list', payload: { operation: 'reply' } }));
  assert.equal((await main.reply(prepared)).status, 'accepted');
  assert.equal((await main.reply(prepared)).status, 'accepted');
  assert.equal(deliveries, 1);
  // Node-side durable receipts also prevent re-delivery after a main restart.
  assert.equal((await node.supervisor.reply(prepared)).status, 'accepted');
  assert.equal(deliveries, 1);
});
