import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryAgentStore, FileBackedAgentStore } from '../src/agent-store.js';
import { sharedSessionId } from '../src/shared-conversations.js';
import { buildMirrorSnapshot, importMirrorSnapshot, importOfflineWork, listOfflineWork, markOfflineWorkSent } from '../src/mirror.js';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(t, disk = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = disk ? new FileBackedAgentStore({ dir: path.join(dir, 'store'), maxSessionBytes: 2048 }) : new InMemoryAgentStore();
  return { dir, store, runtime: { agentHost: { store } } };
}
const pendingCount = work => Object.values(work.messages).reduce((n, messages) => n + messages.length, 0);

test('named Agent and Supervisor chats round trip without merging or inheriting owner authority', t => {
  const server = fixture(t), phone = fixture(t);
  const namedAgent = sharedSessionId('agent', id(1)), namedSupervisor = sharedSessionId('supervisor', id(2));
  server.store.appendMessage(sharedSessionId('agent'), { role: 'user', content: 'Default chat' });
  server.store.appendMessage(namedAgent, { role: 'user', content: 'Named chat', metadata: { authority: { owner: true } } });
  server.store.appendMessage('local:browser:main', { role: 'user', content: 'Owner-only chat' });
  const snapshot = buildMirrorSnapshot(server.runtime, { dataDir: server.dir });
  assert.deepEqual(Object.keys(snapshot.threads).sort(), ['agent', `agent:${id(1)}`, 'supervisor'].sort());
  assert.ok(!JSON.stringify(snapshot).includes('authority'));
  assert.ok(!JSON.stringify(snapshot).includes('Owner-only chat'));
  importMirrorSnapshot(phone.runtime, snapshot, { dataDir: phone.dir });
  assert.equal(pendingCount(listOfflineWork(phone.runtime, { dataDir: phone.dir })), 0);
  phone.store.appendMessage(namedAgent, { role: 'assistant', content: 'Offline reply', metadata: { computerUseLease: 'never-import', authority: { owner: true } } });
  phone.store.appendMessage(namedSupervisor, { role: 'user', content: 'New offline supervisor chat' });
  const work = listOfflineWork(phone.runtime, { dataDir: phone.dir });
  assert.equal(pendingCount(work), 2);
  assert.ok(!JSON.stringify(work).includes('never-import'));
  assert.equal(importOfflineWork(server.runtime, work, { dataDir: server.dir, fromNodeId: 'mobile:test' }).added.messages, 2);
  assert.equal(importOfflineWork(server.runtime, work, { dataDir: server.dir, fromNodeId: 'mobile:test' }).added.messages, 0);
  assert.deepEqual(server.store.getSession(namedAgent).messages.map(m => m.content), ['Named chat', 'Offline reply']);
  assert.deepEqual(server.store.getSession(namedSupervisor).messages.map(m => m.content), ['New offline supervisor chat']);
  assert.deepEqual(server.store.getSession(sharedSessionId('agent')).messages.map(m => m.content), ['Default chat']);
  markOfflineWorkSent(phone.runtime, { dataDir: phone.dir, work });
  assert.equal(pendingCount(listOfflineWork(phone.runtime, { dataDir: phone.dir })), 0);
  const refreshed = buildMirrorSnapshot(server.runtime, { dataDir: server.dir });
  importMirrorSnapshot(phone.runtime, refreshed, { dataDir: phone.dir });
  assert.equal(pendingCount(listOfflineWork(phone.runtime, { dataDir: phone.dir })), 0);
  assert.deepEqual(phone.store.getSession(namedSupervisor).messages.map(m => m.content), ['New offline supervisor chat']);
});

test('more named conversations than a page can hold all drain after acknowledgments', t => {
  const phone = fixture(t), server = fixture(t);
  for (let n = 1; n <= 205; n++) phone.store.appendMessage(sharedSessionId('agent', id(n)), { role: 'user', content: `Question ${n}` });
  let total = 0;
  for (let page = 0; page < 3; page++) {
    const work = listOfflineWork(phone.runtime, { dataDir: phone.dir });
    const count = pendingCount(work);
    if (!count) break;
    assert.ok(count <= 200);
    if (!page) assert.equal(work.truncated, true);
    total += importOfflineWork(server.runtime, work, { dataDir: server.dir, fromNodeId: 'mobile:test' }).added.messages;
    markOfflineWorkSent(phone.runtime, { dataDir: phone.dir, work });
  }
  assert.equal(total, 205);
  assert.equal(pendingCount(listOfflineWork(phone.runtime, { dataDir: phone.dir })), 0);
  for (let n = 1; n <= 205; n++) assert.equal(server.store.getSession(sharedSessionId('agent', id(n))).messages[0].content, `Question ${n}`);
});

test('byte-archived named chat messages remain pending until acknowledged', t => {
  const phone = fixture(t, true), server = fixture(t);
  const session = sharedSessionId('agent', id(1));
  for (let n = 0; n < 8; n++) phone.store.appendMessage(session, { role: 'user', content: `Offline ${n} ${'x'.repeat(500)}` });
  assert.equal(phone.store.getSession(session).metadata.historyArchived, true);
  const work = listOfflineWork(phone.runtime, { dataDir: phone.dir });
  assert.equal(pendingCount(work), 8);
  assert.equal(importOfflineWork(server.runtime, work, { dataDir: server.dir, fromNodeId: 'mobile:test' }).added.messages, 8);
  markOfflineWorkSent(phone.runtime, { dataDir: phone.dir, work });
  assert.equal(pendingCount(listOfflineWork(phone.runtime, { dataDir: phone.dir })), 0);
});

test('offline import rejects non-device session keys before writing anything', t => {
  const server = fixture(t);
  for (const key of ['local:browser:main', 'agent:main', 'agent:../../owner', `supervisor:${id(1)}:owner`]) {
    const work = { version: 1, messages: { [key]: [{ id: 'm1', role: 'user', content: 'Invalid target' }] }, tasks: [], memories: [] };
    assert.throws(() => importOfflineWork(server.runtime, work, { dataDir: server.dir, fromNodeId: 'mobile:test' }), { code: 'invalid_mirror' });
  }
  assert.equal(server.store.listSessions().length, 0);
});
