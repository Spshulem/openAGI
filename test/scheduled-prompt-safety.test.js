import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scheduledPromptSpec } from '../src/scheduled-prompt.js';
import { ToolRegistry, registerCoreTools } from '../src/tool-registry.js';
import { FileBackedCronScheduler } from '../src/file-backed-cron-scheduler.js';
import { AbiRuntime } from '../src/abi-runtime.js';
import { ModelRouter, TASK_PROFILES, agentTurnTask } from '../src/model-router.js';

test('reminders require exactly one valid time and explicit safe recurrence', () => {
  for (const fields of [{}, { delaySeconds: 30, intervalSeconds: 30 }, { delaySeconds: 60, dailyAt: '09:00' },
    { intervalSeconds: 30 }, { intervalSeconds: -1 }, { delaySeconds: 0 }, { delaySeconds: '60' }, { dailyAt: '25:00' }]) {
    assert.throws(() => scheduledPromptSpec({ prompt: 'Fixture', ...fields }));
  }
  assert.equal(scheduledPromptSpec({ prompt: 'Fixture', delaySeconds: 60, dailyAt: null }).input.oneShot, true);
  assert.equal(scheduledPromptSpec({ prompt: 'Fixture', intervalSeconds: 300 }).input.oneShot, false);
  for (const context of [{ origin: 'cron' }, { scheduledJobId: 'fixture' }]) {
    assert.throws(() => scheduledPromptSpec({ prompt: 'Fixture', delaySeconds: 60 }, context), /cannot create more/);
  }
});

test('duplicate reminders reuse persisted jobs and never re-enable paused copies', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-safety-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cron = new FileBackedCronScheduler({ storePath: path.join(dir, 'jobs.json') });
  const registry = new ToolRegistry();
  registerCoreTools(registry, { cron });
  const args = { prompt: 'Fixture reminder', delaySeconds: 60 };
  const context = { channel: 'local', from: 'fixture', agentId: 'main', sessionId: 'fixture-session' };
  const first = await registry.invoke('schedule_message', args, context);
  assert.equal(first.ok, true);
  const duplicate = await registry.invoke('schedule_message', { ...args, name: 'Different label' }, context);
  assert.equal(duplicate.result.id, first.result.id);
  assert.equal(cron.listJobs().length, 1);
  cron.enableJob(first.result.id, false);
  const restarted = new FileBackedCronScheduler({ storePath: cron.storePath });
  const registry2 = new ToolRegistry();
  registerCoreTools(registry2, { cron: restarted });
  const paused = await registry2.invoke('schedule_message', args, context);
  assert.equal(paused.result.enabled, false);
  assert.equal(restarted.listJobs().length, 1);
  assert.equal((await registry2.invoke('schedule_message', { ...args, intervalSeconds: 30 }, context)).ok, false);
});

test('a failed one-shot stays paused across ticks and restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-once-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cron = new FileBackedCronScheduler({ storePath: path.join(dir, 'jobs.json') });
  let calls = 0;
  const self = { cron, agentHost: { async handleMessage(input) {
    calls++;
    assert.equal(input.origin, 'cron');
    assert.equal(new FileBackedCronScheduler({ storePath: cron.storePath }).listJobs()[0].enabled, false);
    throw new Error('Fixture provider failure');
  } } };
  cron.addJob({ id: 'fixture-job', task: 'prompt', intervalMs: 30000, nextRunAt: new Date(0).toISOString(), input: { prompt: 'Fixture', oneShot: true } });
  await cron.runDue(job => AbiRuntime.prototype.runScheduledPrompt.call(self, job));
  await cron.runDue(job => AbiRuntime.prototype.runScheduledPrompt.call(self, job), new Date(Date.now() + 60000));
  assert.equal(calls, 1);
  const saved = new FileBackedCronScheduler({ storePath: cron.storePath }).listJobs()[0];
  assert.equal(saved.enabled, false);
  assert.equal(saved.nextRunAt, null);
});

test('foreground stays on GPT-6; scheduled work uses Luna regardless of delivery channel', () => {
  const env = { OPENAI_MODEL_MINI: 'gpt-5.6-luna', OPENAI_MODEL_NANO: 'gpt-5.6-luna', OPENAI_MODEL_TASK_AUTOPILOT: 'gpt-5.6-luna' };
  const router = new ModelRouter({ baseModel: 'gpt-6-astra', env });
  for (const channel of ['local', '', 'g2', 'imessage', 'telegram']) {
    assert.equal(router.resolve(agentTurnTask({ channel })), 'gpt-6-astra');
    assert.equal(router.resolve(agentTurnTask({ channel, origin: 'cron' })), 'gpt-5.6-luna');
    assert.equal(router.resolve(agentTurnTask({ channel, metadata: { scheduledJobId: 'fixture' } })), 'gpt-5.6-luna');
  }
  for (const task of Object.keys(TASK_PROFILES).filter(task => task !== 'chat')) assert.equal(router.resolve(task), 'gpt-5.6-luna');
});
