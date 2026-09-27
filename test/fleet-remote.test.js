import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFleetCapability, RemoteFleetSupervisor } from '../src/fleet/remote.js';
import { createFleetRoute } from '../src/fleet/routes.js';
import { OutreachStore } from '../src/outreach-store.js';
import { G2Proactive } from '../src/g2-proactive.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-remote-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = { mode: 'observe', enabled: true, lastError: null, snapshot: { threads: [] }, questions: [{ id: 'fq_one', title: 'Which branch?', body: 'Pick a branch', options: ['feature', 'main'] }], actions: [] };
  const supervisor = { getState: () => structuredClone(state), tick: async () => state.snapshot, setMode: mode => (state.mode = mode),
    answerQuestion: async (id, answer) => { const question = state.questions.find(q => q.id === id); state.questions = []; return { question: { ...question, status: 'answered', answer }, delivery: { status: 'sent' } }; } };
  const capability = createFleetCapability(supervisor);
  const calls = [];
  const runtime = { outreach: new OutreachStore({ dir: path.join(dir, 'outreach') }), nodeCapabilities: { dispatch: async (...args) => {
    calls.push(args);
    return capability.invoke(args[2], args[3]);
  } } };
  const remote = new RemoteFleetSupervisor({ runtime, nodeId: 'selected-mac' });
  return { dir, state, runtime, remote, capability, calls };
}

test('main routes fleet reads and mode changes only to the selected enrolled node', async t => {
  const { remote, state, calls } = fixture(t);
  const route = createFleetRoute({ supervisor: remote });
  assert.equal((await route('GET', '/fleet/api/state')).body.questions.length, 1);
  const result = await route('POST', '/fleet/api/mode', null, async () => ({ mode: 'propose' }));
  assert.equal(result.status, 200);
  assert.equal(result.body.mode, 'propose');
  assert.equal(state.mode, 'propose');
  assert.ok(calls.every(c => c[0] === 'selected-mac' && c[1] === 'fleet-supervisor'));
});

test('mirrored questions reach the existing G2 feed and close after an owner answer', async t => {
  const { remote, runtime, dir } = fixture(t);
  await remote.refresh();
  await remote.refresh();
  assert.equal(runtime.outreach.list().length, 1);
  const g2 = new G2Proactive({ dir: path.join(dir, 'g2'), runtime });
  const node = g2.node('glasses');
  node.settings.enabled = true;
  node.settings.categories = ['approvals'];
  assert.equal(g2.feed(node)[0].title, 'Which branch?');
  await remote.answerQuestion('fq_one', 'feature');
  assert.equal(remote.getState().questions.length, 0);
  assert.equal(runtime.outreach.list()[0].status, 'dismissed');
  assert.equal(g2.feed(node).length, 0);
});

test('offline node retains last state and cannot falsely confirm an answer', async t => {
  const { remote, runtime } = fixture(t);
  await remote.refresh();
  runtime.nodeCapabilities.dispatch = async () => { throw new Error('offline'); };
  await assert.rejects(remote.answerQuestion('fq_one', 'feature'), /unavailable/);
  assert.equal(remote.getState().questions.length, 1);
  assert.equal(runtime.outreach.list()[0].status, 'unseen');
  assert.match(remote.getState().lastError, /unavailable/);
});

test('node capability refuses arbitrary routes, commands, and methods', async t => {
  const { capability } = fixture(t);
  for (const [operation, payload] of [ ['exec', {}], ['request', {method:'POST',path:'/message'}], ['request',{method:'DELETE',path:'/fleet/api/state'}], ['request',{method:'POST',path:'/fleet/api/questions/../../control/update'}] ]) {
    await assert.rejects(capability.invoke(operation,payload), /Unsupported/);
  }
});
