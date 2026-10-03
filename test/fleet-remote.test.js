import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFleetCapability, RemoteFleetSupervisor } from '../src/fleet/remote.js';
import { createFleetRoute } from '../src/fleet/routes.js';
import { DEFAULTS, resolveFleetConfig } from '../src/fleet/contracts.js';
import { FleetSupervisor } from '../src/fleet/supervisor.js';
import { OutreachStore } from '../src/outreach-store.js';
import { G2Proactive } from '../src/g2-proactive.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-remote-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = { mode: 'observe', enabled: true, lastError: null, snapshot: { threads: [] }, questions: [{ id: 'fq_one', title: 'Which branch?', body: 'Pick a branch', options: ['feature', 'main'] }], actions: [] };
  const supervisor = { getState: () => structuredClone(state), tick: async () => state.snapshot, setMode: mode => (state.mode = mode),
    answerQuestion: async (id, answer) => { const question = state.questions.find(q => q.id === id); state.questions = []; return { question: { ...question, status: 'answered', answer }, delivery: { status: 'sent' } }; },
    dismissQuestion: id => { const question = state.questions.find(q => q.id === id); state.questions = state.questions.filter(q => q.id !== id); return question ? { ...question, status: 'dismissed' } : null; } };
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

test('requests that type into an app outlast a whole UI delivery; reads keep the short timeout', async t => {
  const { remote, calls } = fixture(t);
  await remote.refresh();
  await remote.answerQuestion('fq_one', 'feature');
  const [read, answer] = calls.map(c => c[4].timeoutMs);
  assert.equal(read, 120000);
  // Both caps count from the request's start: its probes, the lock wait and
  // earlier sends in it are inside them, typing too. What can run past the
  // first cap fits in the cleanup: the probe still running at it (frontApp:
  // two commands, each with its kill grace) or readiness (two commands and
  // the permission check). Clearing (two reads when nothing ran over) and
  // restoring the owner's app only run in what is left (see fleet-ui-delivery).
  const command = DEFAULTS.uiStepTimeoutMs + DEFAULTS.uiKillGraceMs;
  assert.ok(DEFAULTS.uiCleanupMs >= 2 * command + DEFAULTS.uiStepTimeoutMs, 'a probe or readiness running at the deadline');
  assert.ok(DEFAULTS.uiCleanupMs >= 2 * DEFAULTS.uiReadTimeoutMs, 'two reads of clearing');
  assert.ok(answer >= DEFAULTS.uiDeliveryTimeoutMs + DEFAULTS.uiCleanupMs, 'delivery and its cleanup, from the request start');
  assert.ok(answer <= 5 * 60 * 1000, 'within the broker ceiling');
});

test('dismissing a mirrored question on the glasses closes it on the computer', async t => {
  const { remote, runtime, dir, state, calls } = fixture(t);
  runtime.fleetSupervisor = remote;
  await remote.refresh();
  const g2 = new G2Proactive({ dir: path.join(dir, 'g2'), runtime });
  g2.dispatch('glasses', { op: 'configure', settings: { enabled: true, categories: ['approvals'] } });
  const [item] = g2.dispatch('glasses', { op: 'feed' }).items;
  assert.equal(g2.dispatch('glasses', { op: 'dismiss', id: item.id }).ok, true);
  await new Promise(setImmediate);
  assert.deepEqual(calls.at(-1)[3], { method: 'POST', path: '/fleet/api/questions/fq_one', body: { dismiss: true } });
  assert.equal(state.questions.length, 0);
  assert.equal(runtime.outreach.list()[0].status, 'dismissed');
  assert.equal(g2.dispatch('glasses', { op: 'feed' }).items.length, 0);
});

test('an offline computer keeps the question open, the glasses keep their dismissal, and it lands after reconnect', async t => {
  const { remote, runtime, dir, state, calls } = fixture(t);
  runtime.fleetSupervisor = remote;
  await remote.refresh();
  const online = runtime.nodeCapabilities.dispatch;
  runtime.nodeCapabilities.dispatch = async () => { throw new Error('offline'); };
  const g2 = new G2Proactive({ dir: path.join(dir, 'g2'), runtime });
  g2.dispatch('glasses', { op: 'configure', settings: { enabled: true, categories: ['approvals'] } });
  const [item] = g2.dispatch('glasses', { op: 'feed' }).items;
  assert.equal(g2.dispatch('glasses', { op: 'dismiss', id: item.id }).ok, true);
  await new Promise(setImmediate);
  assert.match(remote.getState().lastError, /unavailable/);
  assert.equal(state.questions.length, 1);
  assert.equal(runtime.outreach.list()[0].status, 'unseen');
  assert.equal(g2.dispatch('glasses', { op: 'feed' }).items.length, 0);
  // Still offline on the next refresh: kept for later.
  await assert.rejects(remote.refresh(), /unavailable/);
  assert.equal(state.questions.length, 1);

  runtime.nodeCapabilities.dispatch = online;
  await remote.refresh();
  assert.deepEqual(calls.at(-1)[3], { method: 'POST', path: '/fleet/api/questions/fq_one', body: { dismiss: true } });
  assert.equal(state.questions.length, 0);
  assert.equal(runtime.outreach.list()[0].status, 'dismissed');
  // Sent once.
  const sent = calls.length;
  await remote.refresh();
  assert.equal(calls.length, sent + 1);
});

test('a missed glasses dismissal is dropped when the computer closed the question meanwhile', async t => {
  const { remote, runtime, state, calls } = fixture(t);
  await remote.refresh();
  const online = runtime.nodeCapabilities.dispatch;
  runtime.nodeCapabilities.dispatch = async () => { throw new Error('offline'); };
  await assert.rejects(remote.dismissQuestion('fq_one', { replay: true }), /unavailable/);
  // A page dismissal that failed is not replayed.
  await assert.rejects(remote.dismissQuestion('fq_two'), /unavailable/);
  assert.deepEqual([...remote.pendingDismissals], ['fq_one']);
  state.questions = [];
  runtime.nodeCapabilities.dispatch = online;
  await remote.refresh();
  assert.deepEqual(calls.map(c => c[3].path), ['/fleet/api/state', '/fleet/api/state']);
  assert.deepEqual([...remote.pendingDismissals], []);
});

test('node capability refuses arbitrary routes, commands, and methods', async t => {
  const { capability } = fixture(t);
  for (const [operation, payload] of [ ['exec', {}], ['request', {method:'POST',path:'/message'}], ['request',{method:'DELETE',path:'/fleet/api/state'}], ['request',{method:'POST',path:'/fleet/api/questions/../../control/update'}] ]) {
    await assert.rejects(capability.invoke(operation,payload), /Unsupported/);
  }
});

test("the Mac capability forwards the owner's send and validates it", async () => {
  const { createFleetCapability } = await import("../src/fleet/remote.js");
  const calls = [];
  const supervisor = {
    getState: () => ({ mode: "auto", questions: [], actions: [], snapshot: null, settings: {} }),
    sendOwnerMessage: async (key, message) => { calls.push([key, message]); return { delivery: { status: "sent", route: "computer-use", detail: "typed" } }; }
  };
  const capability = createFleetCapability(supervisor);
  const ok = await capability.invoke("request", { method: "POST", path: "/fleet/api/send", body: { threadKey: "codex:abc-1", message: "Push it." } });
  assert.equal(ok.response.status, 200);
  assert.equal(ok.response.body.delivery.status, "sent");
  assert.deepEqual(calls, [["codex:abc-1", "Push it."]]);
  const badKey = await capability.invoke("request", { method: "POST", path: "/fleet/api/send", body: { threadKey: "../etc", message: "x" } });
  assert.equal(badKey.response.status, 400);
  const empty = await capability.invoke("request", { method: "POST", path: "/fleet/api/send", body: { threadKey: "codex:abc-1", message: " " } });
  assert.equal(empty.response.status, 400);
});

test("a send queued 200 s before this Mac picked it up keeps the broker's deadline, not a fresh 5 min", async () => {
  const seen = [];
  const supervisor = {
    getState: () => ({ mode: "propose", questions: [{ id: "fq_one", options: ["feature"] }], actions: [{ id: "fa_one" }], snapshot: null, settings: {} }),
    sendOwnerMessage: async (_key, _message, options) => { seen.push(["send", options]); return { delivery: { status: "sent" } }; },
    answerQuestion: async (_id, _answer, options) => { seen.push(["answer", options]); return { question: null, delivery: { status: "sent" } }; },
    sendProposed: async (_id, options) => { seen.push(["action", options]); return { action: null, delivery: { status: "sent" } }; }
  };
  const capability = createFleetCapability(supervisor);
  // node-control's dispatch: expiresAt is 300 s from createdAt, 200 s of it spent queued.
  const createdAt = Date.now() - 200_000;
  const expiresAt = new Date(createdAt + 5 * 60 * 1000).toISOString();
  await capability.invoke("request", { method: "POST", path: "/fleet/api/send", body: { threadKey: "codex:abc-1", message: "Push it." } }, { expiresAt });
  await capability.invoke("request", { method: "POST", path: "/fleet/api/questions/fq_one", body: { answer: "feature" } }, { expiresAt });
  await capability.invoke("request", { method: "POST", path: "/fleet/api/actions/fa_one/send" }, { expiresAt });
  assert.deepEqual(seen, [["send", { deadlineAt: Date.parse(expiresAt) }], ["answer", { deadlineAt: Date.parse(expiresAt) }], ["action", { deadlineAt: Date.parse(expiresAt) }]]);
  assert.ok(Date.parse(expiresAt) - Date.now() <= 100_000, "about 100 s left, not a fresh 5 min");
  // A local call (no broker) has no deadline.
  await capability.invoke("request", { method: "POST", path: "/fleet/api/send", body: { threadKey: "codex:abc-1", message: "Push it." } });
  assert.deepEqual(seen.at(-1), ["send", { deadlineAt: null }]);
});

test("a Scan now through the broker ticks without app sends; the Mac's own page scans as before", async () => {
  const ticks = [];
  const supervisor = { getState: () => ({ mode: "auto", questions: [], actions: [], snapshot: null, settings: {} }), tick: async (options) => { ticks.push(options); return null; } };
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  assert.equal((await createFleetCapability(supervisor).invoke("request", { method: "POST", path: "/fleet/api/scan" }, { expiresAt })).response.status, 200);
  assert.equal((await createFleetRoute({ supervisor })("POST", "/fleet/api/scan", null, async () => ({}))).status, 200);
  assert.deepEqual(ticks, [{ reason: "owner-scan", deferUi: true }, { reason: "owner-scan" }]);
});

test('a question reopened on the computer brings back its mirrored copy, so G2 does not ping again', async t => {
  const { remote, runtime, state, dir } = fixture(t);
  await remote.refresh();
  const [first] = runtime.outreach.list();
  const g2 = new G2Proactive({ dir: path.join(dir, 'g2'), runtime });
  const node = g2.node('glasses');
  node.settings.enabled = true;
  node.settings.categories = ['approvals'];
  node.marks[first.id] = { notified: true };
  const question = state.questions[0];
  state.questions = [];
  await remote.refresh();
  assert.equal(runtime.outreach.get(first.id).status, 'dismissed');
  state.questions = [{ ...question, reopenedAt: '2026-09-28T06:04:03.000Z' }];
  await remote.refresh();
  assert.deepEqual(runtime.outreach.list().map(item => [item.id, item.status]), [[first.id, 'seen']]);
  assert.deepEqual(g2.feed(node).map(item => [item.id, item.notified]), [[first.id, true]]);
});

test('a reworded question updates its mirrored copy in place, so G2 shows the new text without a ping', async t => {
  const { remote, runtime, state, dir } = fixture(t);
  await remote.refresh();
  const [first] = runtime.outreach.list();
  runtime.outreach.markSeen([first.id]);
  const g2 = new G2Proactive({ dir: path.join(dir, 'g2'), runtime });
  const node = g2.node('glasses');
  node.settings.enabled = true;
  node.settings.categories = ['approvals'];
  node.marks[first.id] = { notified: true };
  state.questions = [{ id: 'fq_one', title: 'Which branch now?', body: 'Pick one', options: ['feature', 'main', 'release'] }];
  await remote.refresh();
  assert.deepEqual(runtime.outreach.list().map(item => [item.id, item.status, item.title, item.summary]), [[first.id, 'seen', 'Which branch now?', 'Pick one']]);
  assert.deepEqual(g2.feed(node).map(item => [item.id, item.title, item.options, item.notified]), [[first.id, 'Which branch now?', ['feature', 'main', 'release'], true]]);

  // Reopened after a blip with new text: the old copy comes back reworded.
  state.questions = [];
  await remote.refresh();
  state.questions = [{ id: 'fq_one', title: 'Which branch, again?', body: 'Pick one', options: ['main'], reopenedAt: '2026-09-28T06:04:03.000Z' }];
  await remote.refresh();
  assert.deepEqual(runtime.outreach.list().map(item => [item.id, item.status, item.title, item.actions]), [[first.id, 'seen', 'Which branch, again?', ['main', 'dismiss']]]);
});

// End to end: the Mac's real store and supervisor behind the node capability,
// the main's mirror and outreach store, and the glasses' feed.
test('a blip on the computer keeps the same main outreach copy and G2 does not ping again', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-remote-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse('2026-09-26T12:00:00.000Z');
  const ago = ms => new Date(now - ms).toISOString();
  const ask = "Ready. Want me to merge with --admin or wait for Nikhil's approval?";
  let lastAgentText = ask;
  const thread = () => ({
    key: 'codex:t1', kind: 'codex', id: 't1', title: 'Fix billing', cwd: '/work/t1', repo: 'acme/app', branch: 'spencer/fix', workspace: null,
    agentStatus: 'idle', lastActivityAt: ago(60 * 60_000), lastAgentText, lastAgentAt: ago(60 * 60_000), lastUserText: 'continue', lastUserAt: ago(120 * 60_000),
    error: null, openTasks: [], prRefs: [], live: null, writerLocked: false, archived: false, excluded: null, meta: {}
  });
  const config = resolveFleetConfig({}, { home: dir, mode: 'observe', limits: { ...DEFAULTS }, managerRef: 'none', push: null });
  const mac = new FleetSupervisor({ dataDir: path.join(dir, 'mac'), config, deps: {
    now: () => now,
    executor: { deliver: async () => ({ status: 'sent' }), inFlight: () => [], whenIdle: async () => {} },
    fetchImpl: async () => { throw new Error('no network in tests'); },
    readLivePeers: () => new Map(),
    listCodexThreads: async () => [thread()], listClaudeThreads: async () => [], listConductorThreads: async () => [],
    readCodexLbErrors: async () => [], findLocalHeavyVerification: async () => [],
    readLocalGit: async () => ({ head: 'b'.repeat(40), branch: 'spencer/fix', upstream: 'origin/spencer/fix', ahead: 0, remote: 'acme/app' }),
    findPrForBranch: async () => null, fetchPrStates: async () => new Map(),
    probeBuildBot3: async () => ({ reachable: true, checkedAt: ago(0), gate: { state: 'ok', reason: null, since: null }, fullQueue: 0, quickQueue: 0, load: [1, 1, 1], runs: [], timersDead: [], error: null }),
    checkLb: async () => ({ healthy: true, detail: '200', watchLine: null }),
    findManagerSession: () => null
  } });
  const capability = createFleetCapability(mac);
  const events = [];
  const outreach = new OutreachStore({ dir: path.join(dir, 'main-outreach'), runtime: { events: { emit: (name, item) => events.push([name, item.id]) } } });
  const runtime = { outreach, nodeCapabilities: { dispatch: async (...args) => capability.invoke(args[2], args[3]) } };
  const remote = new RemoteFleetSupervisor({ runtime, nodeId: 'mac' });
  runtime.fleetSupervisor = remote;
  const g2 = new G2Proactive({ dir: path.join(dir, 'g2'), runtime, now: () => now });
  g2.dispatch('glasses', { op: 'configure', settings: { supervisorOnly: true } });
  // What the glasses app does on each feed read: ping once for a new item.
  const pings = [];
  const glance = () => {
    for (const item of g2.dispatch('glasses', { op: 'feed' }).items) {
      if (item.notified || !g2.dispatch('glasses', { op: 'can-notify', id: item.id }).notify) continue;
      g2.dispatch('glasses', { op: 'notify', id: item.id });
      pings.push(item.id);
    }
  };

  await mac.tick();
  const [question] = mac.getState().questions;
  assert.equal(question.kind, 'agent-ask');
  await remote.refresh();
  const [copy] = outreach.list();
  glance();
  assert.deepEqual(pings, [copy.id]);

  // Blip: the ask drops out for one tick, then is back within the hour.
  lastAgentText = 'Pushed.';
  now += 10 * 60_000;
  await mac.tick();
  assert.deepEqual(mac.getState().questions, []);
  await remote.refresh();
  assert.equal(outreach.get(copy.id).status, 'dismissed');
  glance();

  lastAgentText = ask;
  now += 20 * 60_000;
  await mac.tick();
  const [back] = mac.getState().questions;
  assert.equal(back.id, question.id);
  await remote.refresh();
  assert.deepEqual(outreach.list().map(item => [item.id, item.status]), [[copy.id, 'seen']]);
  assert.deepEqual(events.filter(([name]) => name === 'outreach'), [['outreach', copy.id], ['outreach', copy.id]], 'appended, then reopened for the Mac overlay');
  glance();
  assert.deepEqual(pings, [copy.id], 'no second ping on the glasses');
  assert.deepEqual(g2.dispatch('glasses', { op: 'feed' }).items.map(item => [item.id, item.notified]), [[copy.id, true]]);
});

// The Mac's review closes junk before the main mirrors it, and the owner can
// reopen a wrong close from the main.
test('a question the review closes never reaches the main or the glasses, and reopens from the main', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-remote-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.parse('2026-09-26T12:00:00.000Z');
  const ago = ms => new Date(now - ms).toISOString();
  const thread = {
    key: 'codex:t1', kind: 'codex', id: 't1', title: 'Current local time: sweep', cwd: '/work/t1', repo: 'acme/app', branch: 'spencer/fix', workspace: null,
    agentStatus: 'idle', lastActivityAt: ago(60 * 60_000), lastAgentText: 'Status table. Want me to spend credits on a rerun?', lastAgentAt: ago(60 * 60_000),
    lastUserText: 'continue', lastUserAt: ago(120 * 60_000), error: null, openTasks: [], prRefs: [], live: null, writerLocked: false, archived: false, excluded: null, meta: {}
  };
  let remote = null;
  let mirroredMidReview = null;
  const runModel = async ({ prompt }) => {
    // The main polls while the model runs.
    await remote.refresh();
    mirroredMidReview = remote.runtime.outreach.list().length;
    const [entry] = JSON.parse(prompt.split('<questions>\n')[1].split('\n</questions>')[0]);
    return { reviews: [{ id: entry.id, decision: 'close', category: 'junk', reason: 'automation sweep status table' }] };
  };
  const config = resolveFleetConfig({}, { home: dir, mode: 'observe', limits: { ...DEFAULTS }, managerRef: 'none', push: null, review: { enabled: true } });
  const mac = new FleetSupervisor({ dataDir: path.join(dir, 'mac'), config, deps: {
    now: () => now, runModel,
    executor: { deliver: async () => ({ status: 'sent' }), inFlight: () => [], whenIdle: async () => {} },
    fetchImpl: async () => { throw new Error('no network in tests'); },
    readLivePeers: () => new Map(),
    listCodexThreads: async () => [thread], listClaudeThreads: async () => [], listConductorThreads: async () => [],
    readCodexLbErrors: async () => [], findLocalHeavyVerification: async () => [],
    readLocalGit: async () => ({ head: 'b'.repeat(40), branch: 'spencer/fix', upstream: 'origin/spencer/fix', ahead: 0, remote: 'acme/app' }),
    findPrForBranch: async () => null, fetchPrStates: async () => new Map(),
    probeBuildBot3: async () => ({ reachable: true, checkedAt: ago(0), gate: { state: 'ok', reason: null, since: null }, fullQueue: 0, quickQueue: 0, load: [1, 1, 1], runs: [], timersDead: [], error: null }),
    checkLb: async () => ({ healthy: true, detail: '200', watchLine: null }),
    findManagerSession: () => null
  } });
  const capability = createFleetCapability(mac);
  const outreach = new OutreachStore({ dir: path.join(dir, 'main-outreach') });
  const runtime = { outreach, nodeCapabilities: { dispatch: async (...args) => capability.invoke(args[2], args[3]) } };
  remote = new RemoteFleetSupervisor({ runtime, nodeId: 'mac' });
  runtime.fleetSupervisor = remote;
  const g2 = new G2Proactive({ dir: path.join(dir, 'g2'), runtime, now: () => now });
  g2.dispatch('glasses', { op: 'configure', settings: { supervisorOnly: true } });

  await mac.tick();
  assert.equal(mirroredMidReview, 0, 'not mirrored while the review ran');
  await remote.refresh();
  assert.deepEqual(outreach.list(), []);
  assert.deepEqual(g2.dispatch('glasses', { op: 'feed' }).items, []);
  const [closed] = remote.getState().reviewClosed;
  assert.equal(closed.reviewCategory, 'junk');

  const route = createFleetRoute({ supervisor: remote });
  const reopened = await route('POST', `/fleet/api/questions/${closed.id}`, null, async () => ({ reopen: true }));
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.question.pinned, true);
  assert.deepEqual(mac.getState().questions.map(q => q.id), [closed.id]);
  await remote.refresh();
  assert.deepEqual(outreach.list().map(item => item.sourceRef.id), [closed.id]);
});

test('main reads screens, clicks and controls apps on the Mac through the broker with the delivery ceiling', async t => {
  const { remote, calls } = fixture(t);
  const seen = [];
  const mac = {
    getState: () => ({ mode: 'auto', enabled: true, snapshot: { threads: [] }, questions: [], actions: [] }),
    screenThread: async (key) => { seen.push(['screen', key]); return { status: 'read', detail: 'read Codex', screen: { prompt: null } }; },
    clickThread: async (key, label, options) => { seen.push(['click', key, label, options.stateId]); return { delivery: { status: 'sent', detail: 'clicked' }, prompt: null }; },
    appAction: async (app, action, options) => { seen.push(['app', app, action, options.expectRunning]); return { ok: true, detail: 'restarted Conductor' }; }
  };
  const capability = createFleetCapability(mac);
  remote.runtime.nodeCapabilities.dispatch = async (...args) => { calls.push(args); return capability.invoke(args[2], args[3]); };
  assert.equal((await remote.screenThread('codex:t1')).status, 'read');
  assert.equal((await remote.clickThread('codex:t1', 'Allow once', { stateId: '0123456789abcdef' })).delivery.status, 'sent');
  assert.equal((await remote.appAction('conductor', 'restart', { expectRunning: ['conductor:s1'] })).ok, true);
  assert.deepEqual(seen, [['screen', 'codex:t1'], ['click', 'codex:t1', 'Allow once', '0123456789abcdef'], ['app', 'conductor', 'restart', ['conductor:s1']]]);
  const timeouts = calls.slice(-3).map((call) => call[4].timeoutMs);
  assert.deepEqual(timeouts, [120000, 300000, 300000], 'a screen read is a request; a click and an app action wait like a send');
  await assert.rejects(() => capability.invoke('request', { method: 'POST', path: '/fleet/api/apps/finder/open' }), /Unsupported fleet request/);
});
