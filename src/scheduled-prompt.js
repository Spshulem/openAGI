// Validate at the tool boundary: model schemas alone do not enforce this.
export function scheduledPromptSpec(args, context = {}) {
  if (context.origin === 'cron' || context.scheduledJobId) {
    throw new Error('A scheduled reminder cannot create more reminders. Ask the user to create or change the schedule.');
  }
  const keys = ['delaySeconds', 'intervalSeconds', 'dailyAt'].filter(key => args[key] !== undefined && args[key] !== null);
  if (keys.length !== 1) throw new Error('Provide exactly one of delaySeconds, intervalSeconds, or dailyAt.');
  const prompt = String(args.prompt ?? '').trim();
  if (!prompt || prompt.length > 4000) throw new Error('Provide a reminder prompt of 1–4000 characters.');
  const key = keys[0];
  if (key === 'dailyAt') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(args.dailyAt)) throw new Error('dailyAt must be HH:MM in 24-hour time.');
  } else if (!Number.isSafeInteger(args[key]) || args[key] < (key === 'delaySeconds' ? 30 : 300)
      || args[key] > 365 * 86400) {
    throw new Error('Use a delay of at least 30 seconds or a recurring interval of at least 5 minutes, up to one year.');
  }
  const channel = String(args.channel ?? '').trim() || context.channel || 'local';
  const input = {
    prompt, channel,
    target: args.target || context.from || context.target || null,
    agentId: context.agentId ?? 'main', sessionId: context.sessionId,
    oneShot: key === 'delaySeconds'
  };
  return {
    input,
    ...(key === 'dailyAt' ? { dailyAt: args.dailyAt } : { intervalMs: args[key] * 1000 }),
    ...(key === 'delaySeconds' ? { nextRunAt: new Date(Date.now() + args.delaySeconds * 1000).toISOString() } : {})
  };
}

export function sameScheduledPrompt(job, spec) {
  const normalize = value => String(value ?? '').trim().replace(/\s+/g, ' ');
  return job.task === 'prompt'
    && normalize(job.input?.prompt) === normalize(spec.input.prompt)
    && ['channel', 'target', 'agentId', 'sessionId'].every(key => (job.input?.[key] ?? null) === (spec.input[key] ?? null))
    && Boolean(job.input?.oneShot) === spec.input.oneShot
    && (job.intervalMs ?? null) === (spec.intervalMs ?? null)
    && (job.dailyAt ?? null) === (spec.dailyAt ?? null);
}
