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
  f.explain({ ...seed, remedy: 'bypass-permission' });
  await assert.rejects(f.manager.propose(f.report), /Invalid remedy/);
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
