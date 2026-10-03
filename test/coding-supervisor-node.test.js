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

function nodeFacade(nodes, dispatched, node) {
  return {
    list: (id) => nodes.filter((entry) => entry.capabilities.some((capability) => capability.id === id)),
    describe: (nodeId) => ({ nodeId, name: { 'mac-old': 'Old Mac' }[nodeId] ?? null, lastSeenAt: '2026-10-03T09:15:00.000Z', online: false, capabilities: [] }),
    dispatch: async (nodeId, capability, operation, payload) => { dispatched.push([nodeId, operation]); return node.execute({ capability, operation, payload }); }
  };
}

test('main resolves the coding node at call time, pins approvals to it, and names the fix when none is ready', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-node-resolve-'));
  const project = path.join(fs.realpathSync(dir), 'project');
  fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  const node = createCodingNodeCapability({ dataDir: path.join(dir, 'node'), builtinOptions: { findExecutable: () => '/fixture/codex', spawnImpl: () => { throw new Error('no spawn in this test'); } } });
  node.supervisor.builtin.configure({ enabled: true, workspaces: [project] });
  const ready = { id: 'coding-supervisor', ready: true, operations: node.capability.operations };
  const nodes = [{ nodeId: 'mac-new', name: 'Spencer Mac', capabilities: [ready] }];
  const dispatched = [];
  const runtime = { nodeCapabilities: nodeFacade(nodes, dispatched, node), drafts: { get: (id) => (id === 'draft_1' ? { title: 'Fix the fleet', body: 'Make Conductor reads recover.' } : null) } };
  // Configured for a Mac that is gone: the one ready coding node takes the work.
  const main = new CodingSupervisor({ dataDir: path.join(dir, 'main'), runtime, remoteNodeId: 'mac-old' });
  t.after(() => { main.stop(); node.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const setup = await main.setup();
  assert.equal(setup.nodeId, 'mac-new');
  assert.deepEqual(dispatched.at(-1), ['mac-new', 'setup']);
  const workspaceId = setup.workspaces[0].id;

  // A draft becomes a repair brief behind the fixed rules.
  const prepared = await main.prepareStart({ provider: 'codex', workspaceId, draftId: 'draft_1' });
  assert.equal(prepared.codingNodeId, 'mac-new');
  assert.match(prepared.message, /^OpenAGI repair brief\. Rules for this session:\n- Start a new branch from origin\/main/);
  assert.match(prepared.message, /Never merge, release, deploy or restart services, and never read or write ~\/\.openagi\./);
  assert.match(prepared.message, /Brief: Fix the fleet\nMake Conductor reads recover\.$/);
  await assert.rejects(main.prepareStart({ provider: 'codex', workspaceId, draftId: 'missing' }), /No draft with that id/);

  // The pinned node must still be ready when the approval runs.
  nodes.length = 0;
  await assert.rejects(main.startApproved(prepared), /node changed since approval: mac-new is not ready now/);
  assert.equal(dispatched.filter(([, operation]) => operation === 'start').length, 0);
  await assert.rejects(main.list(), /Coding node Old Mac is not connected \(last seen 2026-10-03T09:15:00\.000Z\)\. Fix: open OpenAGI on that Mac/);

  // Two ready nodes and neither is the configured one: which to choose is the owner's call.
  nodes.push({ nodeId: 'mac-a', name: 'A', capabilities: [ready] }, { nodeId: 'mac-b', name: 'B', capabilities: [ready] });
  await assert.rejects(main.list(), /2 coding nodes are ready \(A, B\).*set OPENAGI_CODING_SUPERVISOR_NODE/);
});

test('a paired install advertises its coding node by default; OPENAGI_CODING_NODE=0 turns it off', async t => {
  const { createDurableRuntime, createHostedInterface } = await import('../src/index.js');
  for (const [value, expected] of [['1', true], ['0', false]]) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-node-provider-'));
    const runtime = createDurableRuntime({ dataDir, registerDefaults: false, integrations: false, skills: false, autoConnectMcp: false });
    const app = createHostedInterface(runtime, { dataDir, host: '127.0.0.1', port: 0, authToken: 'x', tickerMs: 0, nodeControlEnabled: false,
      serviceEnv: { OPENAGI_CODING_NODE: value } });
    await app.listen();
    try {
      await runtime.nodeCapabilities.refresh();
      const local = runtime.nodeCapabilities.list('coding-supervisor').find((entry) => entry.local);
      assert.equal(Boolean(local), expected, `OPENAGI_CODING_NODE=${value}`);
      if (expected) {
        const capability = local.capabilities[0];
        assert.equal(capability.ready, true, 'ready, so its main can choose workspaces');
        assert.equal(capability.detail, 'No coding workspaces chosen on this computer yet');
        const listed = await runtime.nodeCapabilities.dispatch(local.nodeId, 'coding-supervisor', 'list', { operation: 'list' });
        assert.deepEqual(listed.sessions, [], 'inert with no workspaces');
      }
    } finally {
      await app.close();
      runtime.observations?.db?.close(); runtime.vectorStore?.db?.close(); runtime.sessionIndex?.db?.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
});
