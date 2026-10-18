import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FleetStore } from '../src/fleet/store.js';
import { FleetSupervisor } from '../src/fleet/supervisor.js';
import { SuggestionManager, autoGate, runDiagnosis, suggestionFix } from '../src/fleet/suggestions.js';
import { collectRuntimeProblems } from '../src/fleet/runtime-diagnostics.js';
import { REMEDIES, suggestionPlan } from '../src/fleet/remedies.js';
import { resolveFleetConfig } from '../src/fleet/contracts.js';
import { BudgetGuard } from '../src/budget-guard.js';
import { createFleetRoute } from '../src/fleet/routes.js';
import { createFleetCapability, RemoteFleetSupervisor } from '../src/fleet/remote.js';
import { registerVoiceTools } from '../src/fleet/voice-tools.js';
import { ToolRegistry } from '../src/tool-registry.js';

const NOW = new Date(2026, 9, 18, 12).getTime();
const seed = { anomalyId: 'anomaly-0', area: 'policy', rootCause: 'Synthetic reproducible failure', proposedFix: 'Repair repeated asks', nextAction: 'Reproduce with a synthetic fixture', acceptance: 'No repeated asks', evidenceActionIds: ['a1'], confidence: 0.9, minutesSavedPerDay: 4 };
function fixture(t, mode = 'propose') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-improvement-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new FleetStore({ dir: path.join(dir, 'fleet'), now: () => NOW });
  let explanation = { ...seed, remedy: 'code' };
  const calls = { explain: 0, duplicate: 0, fixes: 0 };
  const manager = new SuggestionManager({ store, config: resolveFleetConfig({}, { selfFix: { mode } }), now: () => NOW,
    models: { explain: async () => { calls.explain++; return explanation; }, duplicate: async () => { calls.duplicate++; return false; } },
    queueFix: input => { calls.fixes++; return store.queueFix(input); }, notify: async () => ({ pushed: false }) });
  const report = { anomalies: [{ id: 'anomaly-0', area: 'policy', metric: 'repeats', eventsPerDay: 2, evidenceActionIds: ['a1'] }] };
  return { dir, store, manager, report, calls, explain: value => { explanation = value; } };
}

for (const remedy of REMEDIES) test(`${remedy} is durable and only code can start a coder`, async t => {
  const f = fixture(t);
  f.explain({ ...seed, remedy });
  await f.manager.publish(await f.manager.propose(f.report));
  const [saved] = new FleetStore({ dir: f.store.dir }).suggestions();
  assert.equal(saved.remedy, remedy);
  const [question] = f.store.openQuestions();
  assert.equal(question.options.includes('Fix it'), remedy === 'code');
  assert.equal(question.meta.plan.label, suggestionPlan(saved).label);
  const reviewed = await f.manager.respond(saved.id, 'Review plan');
  assert.equal(reviewed.plan.nextAction, seed.nextAction);
  assert.equal(f.store.suggestions()[0].status, 'open', 'reviewing a plan does not resolve its problem');
  assert.equal(f.store.openQuestions().length, 1);
  if (remedy === 'code') {
    await f.manager.respond(saved.id, 'Fix it');
    assert.equal(f.calls.fixes, 1);
  } else {
    await assert.rejects(f.manager.respond(saved.id, 'Fix it'), /local plan/);
    assert.throws(() => suggestionFix(saved), /local plan/, 'remote hub cannot bypass routing');
    assert.equal(f.calls.fixes, 0);
    assert.equal(autoGate(saved, { mode: 'auto', now: NOW }), false);
  }
});

test('invalid remedy is refused before publication or coding', async t => {
  const f = fixture(t);
  for (const remedy of ['bypass-permission', undefined, null]) {
    f.explain({ ...seed, remedy });
    await assert.rejects(f.manager.propose(f.report), /Invalid remedy/);
  }
  assert.equal(f.calls.fixes, 0);
});

test('all automatic non-code routes stay local without running a coder', async t => {
  const f = fixture(t, 'auto');
  for (const remedy of REMEDIES.filter(r => r !== 'code')) {
    await f.manager.publish([{ ...seed, remedy, fingerprint: remedy, metric: remedy, score: 1, evidence: {} }]);
  }
  assert.equal(f.calls.fixes, 0);
  assert.equal(f.store.fixes().length, 0);
});

test('public issue drafts never copy private diagnosis or next steps', () => {
  const plan = suggestionPlan({ ...seed, remedy: 'feature', rootCause: 'PRIVATE_OWNER_MESSAGE', nextAction: 'PRIVATE_INSTALLATION_DETAIL', evidence: { actionIds: ['PRIVATE_ACTION'] } });
  assert.ok(plan.issueDraft);
  assert.doesNotMatch(JSON.stringify(plan.issueDraft), /PRIVATE_/);
  assert.match(plan.issueDraft.body, /no issue has been submitted/);
});

test('runtime collectors expose aggregate facts, leave unavailable checks unknown, and never copy error text', () => {
  const runtime = {
    cron: { listJobs: () => [{ enabled: true, lastError: 'PRIVATE_JOB_CONTENT', nextRunAt: new Date(NOW - 600000).toISOString() }] },
    memory: { limits: { medium: 50 }, snapshot: () => ({ medium: Array(50).fill({ content: 'PRIVATE_MEMORY' }) }), qualityStats: () => ({ active: 50, recalled: 1, recallCoverage: 0.02 }) },
    budget: { status: () => ({ spentUsd: 2, dailyUsdLimit: 2, secret: 'PRIVATE_CREDENTIAL' }) },
    imessagePoller: { status: () => ({ enabled: true, lastError: 'PRIVATE_MESSAGE_CONTENT', selfHandle: 'PRIVATE_ACCOUNT' }) },
  };
  const result = collectRuntimeProblems(runtime, NOW);
  assert.deepEqual(result.problems.map(p => p.remedy), ['clarification', 'skill', 'setup', 'setup']);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  assert.equal(result.checks.cron, 'measured');
  assert.equal(collectRuntimeProblems({}, NOW).checks.memory, 'unknown');
  assert.equal(collectRuntimeProblems({ cron: { listJobs() { throw Error('PRIVATE_ERROR'); } } }, NOW).checks.cron, 'unknown');
});

test('full memory alone and disabled integrations do not become code defects', () => {
  const runtime = { memory: { limits: { medium: 1 }, snapshot: () => ({ medium: [{}] }), qualityStats: () => ({ active: 1, recallCoverage: 0 }) }, imessagePoller: { status: () => ({ enabled: false, lastError: 'old error' }) } };
  assert.equal(collectRuntimeProblems(runtime, NOW).problems.length, 0);
});

test('native daily diagnosis stays free, deduplicated across restart, and does not create issues or fixes', async t => {
  const f = fixture(t);
  const runtime = { budget: { status: () => ({ spentUsd: 5, dailyUsdLimit: 5 }) } };
  const diagnose = () => runDiagnosis({ store: f.store, dataDir: f.dir, now: NOW, models: f.manager, runtime });
  const first = await diagnose();
  await f.manager.publish(first.suggestions);
  const before = f.store.suggestions();
  await f.manager.publish((await diagnose()).suggestions);
  assert.equal(f.store.suggestions().length, before.length);
  assert.equal(new FleetStore({ dir: f.store.dir }).suggestions().length, before.length);
  assert.equal(f.calls.explain, 0);
  assert.equal(f.calls.duplicate, 0);
  assert.equal(f.calls.fixes, 0);
  assert.equal(f.store.fixes().length, 0);
});

test('daily scheduler uses opt-in local collectors once and preserves unresolved status', async t => {
  const f = fixture(t);
  const config = resolveFleetConfig({}, { selfFix: { runtimeImprovements: true, mode: 'propose' }, limits: { quietHours: [0, 0] } });
  const supervisor = new FleetSupervisor({ dataDir: f.dir, config, runtime: { budget: { status: () => ({ spentUsd: 1, dailyUsdLimit: 1 }) } }, deps: { now: () => NOW, diagnoseModels: f.manager.models } });
  supervisor._store = f.store;
  supervisor._suggestionManager = f.manager;
  await supervisor.diagnoseTick();
  await supervisor.diagnoseTick();
  assert.equal(f.store.suggestions().length, 1);
  assert.equal(f.store.suggestions()[0].remedy, 'setup');
  const question = f.store.openQuestions()[0];
  await supervisor.answerQuestion(question.id, 'Review plan');
  assert.equal(f.store.openQuestions().length, 1);
  assert.equal(f.store.suggestions()[0].status, 'open');
  assert.equal(f.calls.explain, 0);
  assert.equal(resolveFleetConfig({}).selfFix.runtimeImprovements, false);
  assert.equal(resolveFleetConfig({ OPENAGI_RUNTIME_IMPROVEMENTS: '1' }).selfFix.runtimeImprovements, true);
});

test('voice reservations gate diagnosis before any model call, even with an area filter', async t => {
  const f = fixture(t);
  const budget = new BudgetGuard({ storePath: path.join(f.dir, 'budget', 'usage.json'), dailyUsdLimit: 2 });
  budget.setVoiceReservation('synthetic-call', 2);
  assert.equal(budget.status().spentUsd, 0);
  const result = await runDiagnosis({ store: f.store, dataDir: f.dir, now: NOW, options: { area: 'policy' },
    models: { mode: 'propose', propose() { throw new Error('model must not be called'); } }, runtime: { budget } });
  assert.equal(result.modelSkipped, 'budget-exhausted');
  assert.equal(result.modelError, undefined);
  assert.equal(collectRuntimeProblems({ budget }, NOW).problems[0].remedy, 'setup');
  budget.setVoiceReservation('synthetic-call', 0);
  assert.equal(collectRuntimeProblems({ budget }, NOW).problems.length, 0);
});

test('active cron work is not overdue but idle overdue work and failures remain visible', () => {
  const jobs = [{ id: 'active', enabled: true, nextRunAt: new Date(NOW - 7 * 60000).toISOString() }];
  const cron = { listJobs: () => jobs, isJobRunning: id => id === 'active' };
  assert.equal(collectRuntimeProblems({ cron }, NOW).problems.length, 0);
  jobs.push({ ...jobs[0], id: 'idle' });
  assert.deepEqual(collectRuntimeProblems({ cron }, NOW).problems[0].evidence.measured, { failed: 0, overdue: 1 });
  jobs[0].lastError = 'synthetic previous failure';
  assert.deepEqual(collectRuntimeProblems({ cron }, NOW).problems[0].evidence.measured, { failed: 1, overdue: 1 });
});

test('clarification answers persist through the question API and are reconsidered without closing the finding', async t => {
  const f = fixture(t);
  f.explain({ ...seed, remedy: 'clarification' });
  await f.manager.publish(await f.manager.propose(f.report));
  const supervisor = new FleetSupervisor({ dataDir: f.dir, config: f.manager.config, deps: { now: () => NOW } });
  supervisor._store = f.store;
  supervisor._suggestionManager = f.manager;
  const q = f.store.openQuestions()[0];
  assert.ok(q.options.includes('Answer question'));
  const route = createFleetRoute({ supervisor });
  const pathname = `/fleet/api/questions/${q.id}`;
  const request = clarification => route('POST', pathname, new URL(pathname, 'http://localhost'), async () => ({ answer: 'Answer question', clarification }));
  assert.equal((await request('')).status, 400);
  assert.equal((await request('x'.repeat(2001))).status, 400);
  assert.equal((await request('It waits for owner setup.')).status, 200);
  assert.equal(f.store.question(q.id).status, 'open');
  const [saved] = new FleetStore({ dir: f.store.dir }).suggestions();
  assert.equal(saved.clarification.answer, 'It waits for owner setup.');
  assert.equal(saved.status, 'open');
  // A full queue and absent original anomaly must not prevent reconsideration.
  for (const metric of ['other-1', 'other-2']) f.store.saveSuggestion({ ...saved, id: metric, metric, remedy: 'setup' });
  let explanationInput;
  f.manager.models.explain = async input => {
    explanationInput = input;
    return { ...seed, remedy: 'setup', anomalyId: input.anomalies[0].id };
  };
  const candidates = await f.manager.propose({ anomalies: [], metrics: {}, evidence: [] });
  assert.equal(explanationInput.clarifications[0].answer, saved.clarification.answer);
  await f.manager.publish(candidates);
  const updated = f.store.suggestions().find(s => s.id === saved.id);
  assert.equal(updated.remedy, 'setup');
  assert.ok(updated.clarification.reconsideredAt);
  assert.equal(updated.status, 'open', 'an answer and a new plan are not verification of repair');
  assert.equal(f.store.question(q.id).meta.plan.remedy, 'setup');
  assert.equal(f.store.suggestions().length, 3, 'reconsider the same finding rather than create a duplicate');
  assert.equal(f.calls.fixes, 0);
});

test('voice answers reach a remote clarification without a coding approval or queue', async t => {
  const f = fixture(t);
  f.explain({ ...seed, remedy: 'clarification' });
  await f.manager.publish(await f.manager.propose(f.report));
  const supervisor = new FleetSupervisor({ dataDir: f.dir, config: f.manager.config, deps: { now: () => NOW } });
  supervisor._store = f.store;
  supervisor._suggestionManager = f.manager;
  const capability = createFleetCapability(supervisor);
  const remote = new RemoteFleetSupervisor({ nodeId: 'synthetic-node', runtime: { nodeCapabilities: {
    dispatch: async (_id, _capability, operation, payload) => capability.invoke(operation, payload)
  } } });
  const registry = new ToolRegistry();
  registerVoiceTools(registry, remote);
  const saved = f.store.suggestions()[0];
  const result = await registry.invoke('suggestion_respond', { suggestionId: saved.id, choice: 'answer question', clarification: 'Synthetic owner answer' });
  assert.equal(result.ok, true);
  assert.equal(result.result.nonResolving, true);
  assert.equal(f.store.suggestions()[0].clarification.answer, 'Synthetic owner answer');
  const q = f.store.openQuestions()[0];
  const response = await remote.answerQuestion(q.id, 'Answer question', { clarification: 'Updated owner answer' });
  assert.equal(response.nonResolving, true);
  assert.equal(f.store.suggestions()[0].clarification.answer, 'Updated owner answer');
  assert.equal(f.store.suggestions()[0].status, 'open');
  assert.equal(f.calls.fixes, 0);
});

test('reconsidered native findings keep their fingerprint across publication order and restart', async t => {
  const f = fixture(t);
  const runtime = { cron: { listJobs: () => [{ id: 'synthetic-job', enabled: true, lastError: 'synthetic failure' }] } };
  const native = (await runDiagnosis({ store: f.store, dataDir: f.dir, now: NOW, models: f.manager, runtime })).suggestions[0];
  await f.manager.publish([native]);
  const original = f.store.suggestions()[0];
  await f.manager.respond(original.id, 'Answer question', { clarification: 'It requires setup.' });
  f.manager.models.explain = async input => ({ ...seed, area: 'sources', remedy: 'setup', rootCause: 'Different synthetic root cause', anomalyId: input.anomalies[0].id });
  const reconsidered = await f.manager.propose({ anomalies: [] });
  await f.manager.publish([...reconsidered, { ...native, score: -1 }]);
  assert.equal(f.store.suggestions().length, 1);
  assert.equal(f.store.suggestions()[0].fingerprint, original.fingerprint);
  f.manager.store = new FleetStore({ dir: f.store.dir, now: () => NOW });
  await f.manager.publish([native]);
  assert.equal(f.manager.store.suggestions().length, 1);
});

test('a bounded clarification batch processes later answers even when the first explanation fails', async t => {
  const f = fixture(t);
  for (const metric of ['first', 'second', 'third']) {
    await f.manager.publish([{ ...seed, metric, remedy: 'clarification', fingerprint: metric, score: 1 }]);
    const saved = f.store.suggestions().find(s => s.metric === metric);
    await f.manager.respond(saved.id, 'Answer question', { clarification: metric });
  }
  const calls = [];
  f.manager.models.explain = async input => {
    const answer = input.clarifications[0].answer;
    calls.push(answer);
    if (answer === 'first') throw new Error('synthetic explanation unavailable');
    return { ...seed, remedy: 'setup', anomalyId: input.anomalies[0].id };
  };
  await f.manager.publish(await f.manager.propose({ anomalies: [] }));
  assert.deepEqual(calls, ['first', 'second', 'third']);
  assert.equal(f.store.suggestions().find(s => s.metric === 'first').clarification.reconsideredAt, undefined);
  for (const metric of ['second', 'third']) assert.ok(f.store.suggestions().find(s => s.metric === metric).clarification.reconsideredAt);
  assert.equal(f.calls.fixes, 0);
});
