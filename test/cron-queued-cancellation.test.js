import test from 'node:test';
import assert from 'node:assert/strict';
import { CronScheduler } from '../src/cron-scheduler.js';

const now = new Date('2026-01-01T12:00:00.000Z');
const due = '2026-01-01T11:00:00.000Z';
for (const [clockKind, tick] of [['Date', now], ['ISO string', now.toISOString()], ['epoch milliseconds', now.getTime()]]) {
  for (const action of ['disable', 'remove', 'reschedule', 'replace']) {
    test(`scheduled dispatch honors ${action} with ${clockKind} while an earlier handler runs`, async () => {
      const cron = new CronScheduler();
      cron.addJob({ id: 'first', intervalMs: 60000, nextRunAt: due });
      cron.addJob({ id: 'queued', intervalMs: 60000, nextRunAt: due });
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const dispatched = [];
      const pass = cron.runDue(async job => {
        dispatched.push(job.id);
        if (job.id === 'first') await gate;
        return { ok: true };
      }, tick);
      if (action === 'disable') cron.enableJob('queued', false);
      if (action === 'remove') cron.removeJob('queued');
      if (action === 'reschedule') cron.updateJob('queued', { nextRunAt: '2026-01-02T12:00:00.000Z' });
      if (action === 'replace') cron.addJob({ id: 'queued', replace: true, intervalMs: 60000, nextRunAt: due });
      release();
      await pass;
      assert.deepEqual(dispatched, ['first'], 'cancelled or changed queued work must not execute from a stale snapshot');
      assert.equal(cron.listRuns().length, 1);
      if (action === 'reschedule') assert.equal(cron.jobs.get('queued').nextRunAt, '2026-01-02T12:00:00.000Z');
      // Changes apply to subsequent ticks too: rescheduled work waits, whereas
      // a replacement that is still due can run with its current definition.
      const next = [];
      await cron.runDue(async job => { next.push(job.id); }, tick);
      assert.deepEqual(next, action === 'replace' ? ['queued'] : []);
    });
  }

  test(`unchanged due jobs still run in order with ${clockKind}`, async () => {
    const cron = new CronScheduler();
    for (const id of ['first', 'second']) cron.addJob({ id, intervalMs: 60000, nextRunAt: due });
    const dispatched = [];
    await cron.runDue(async job => { dispatched.push(job.id); }, tick);
    assert.deepEqual(dispatched, ['first', 'second']);
    for (const job of cron.jobs.values()) {
      assert.equal(job.lastRunAt, now.toISOString());
      assert.equal(job.nextRunAt, '2026-01-01T12:01:00.000Z');
    }
  });

}
