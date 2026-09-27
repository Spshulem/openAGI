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
    answerQuestion: async (id, answer) => { const question = state.questions.find(q => q.id === id); state.questions = []; return { question: { ...question, status: 'answered', answer }, delivery: { status: 'sent' } }; },
    dismissQuestion: async id => { const question = state.questions.find(q => q.id === id); state.questions = []; return { ...question, status: 'dismissed' }; } };
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
  assert.ok(calls.every(c => c[4].timeoutMs > 180_000), 'dispatch outlasts the peer relay timeout');
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

test('an outreach dismissal preserves the owner decision until its route records it', async t => {
  const { remote, runtime } = fixture(t);
  await remote.refresh();
  const item = runtime.outreach.list()[0];
  const dispatch = runtime.nodeCapabilities.dispatch;
  let dismissalReached, releaseDismissal;
  const reached = new Promise(resolve => { dismissalReached = resolve; });
  const held = new Promise(resolve => { releaseDismissal = resolve; });
  runtime.nodeCapabilities.dispatch = async (...args) => {
    const result = await dispatch(...args);
    if (args[3].path === '/fleet/api/questions/fq_one') {
      dismissalReached();
      await held;
    }
    return result;
  };
  remote.beginOutreachDecision('fq_one');
  const dismissal = remote.dismissQuestion('fq_one');
  await reached; // The computer has dismissed it, but main has not received that reply.
  await remote.refresh(); // A concurrent refresh sees the now-empty question list.
  releaseDismissal();
  await dismissal;
  assert.equal(runtime.outreach.get(item.id).status, 'unseen');
  runtime.outreach.resolve(item.id, { action: 'dismiss', by: 'user', note: 'Use main' }, { status: 'dismissed' });
  remote.finishOutreachDecision('fq_one');
  assert.deepEqual(runtime.outreach.get(item.id).decision, { action: 'dismiss', by: 'user', note: 'Use main' });
});

test('successful refresh retires open questions from the previously selected node', async t => {
  const { remote, runtime } = fixture(t);
  const old = runtime.outreach.append({ type: 'fleet-question', sourceRef: { kind: 'fleet', id: 'fq_old', nodeId: 'old-mac' },
    title: 'Old Mac question', needsDecision: true, actions: ['dismiss'] });
  await remote.refresh();
  assert.equal(runtime.outreach.get(old.id).status, 'dismissed');
  assert.deepEqual(runtime.outreach.list({ status: 'unseen' }).map(item => item.sourceRef.id), ['fq_one']);
});

test('node capability refuses arbitrary routes, commands, and methods', async t => {
  const { capability } = fixture(t);
  for (const [operation, payload] of [ ['exec', {}], ['request', {method:'POST',path:'/message'}], ['request',{method:'DELETE',path:'/fleet/api/state'}], ['request',{method:'POST',path:'/fleet/api/questions/../../control/update'}] ]) {
    await assert.rejects(capability.invoke(operation,payload), /Unsupported/);
  }
});
