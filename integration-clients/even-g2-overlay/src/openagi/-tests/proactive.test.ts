import { afterEach, expect, it, vi } from 'vitest'
import { G2ProactiveClient } from '../proactive'
import { OpenAGIApiError } from '../config'

afterEach(() => vi.useRealTimers())

it('retains eleven separate utterances across bounded batches', async () => {
  vi.useFakeTimers(); const f = fixture(); f.client.start(); await f.client.grantMemory(true); f.client.resumeMemory()
  for (let i = 0; i < 11; i++) f.client.capture(`Utterance ${i}`)
  await vi.advanceTimersByTimeAsync(47000)
  const batches = f.api.proactive.mock.calls.filter(([b]) => b.op === 'capture').map(([b]) => (b as { texts?: string[] }).texts!)
  expect(batches.map(b => b.length)).toEqual([10, 1]); f.client.stop()
})

it('does not acknowledge a notification when the app becomes busy during permission check', async () => {
  vi.useFakeTimers(); const f = fixture(); f.idle.mockReturnValue(true)
  const original = f.api.proactive.getMockImplementation()!
  f.api.proactive.mockImplementation(async body => {
    if (body.op === 'can-notify') f.idle.mockReturnValue(false)
    return original(body)
  })
  f.client.start(); await vi.advanceTimersByTimeAsync(1)
  expect(f.notify).not.toHaveBeenCalled()
  expect(f.api.proactive.mock.calls.some(([b]) => b.op === 'notify')).toBe(false); f.client.stop()
})

it('coalesces rapid final events from one speaker without losing stream metadata', async () => {
  vi.useFakeTimers(); const f = fixture(); f.client.start(); await f.client.grantMemory(true); f.client.resumeMemory()
  const start = Date.now()
  for (let i = 0; i < 20; i++) f.client.capture('word', { at: start + i * 1000, endAt: start + (i + 1) * 1000, streamId: 'fixture-stream', speaker: 0 })
  await vi.advanceTimersByTimeAsync(30000)
  expect(f.api.proactive).toHaveBeenCalledWith(expect.objectContaining({ op: 'capture', texts: [Array(20).fill('word').join(' ')], segments: [expect.objectContaining({ speaker: 0, at: start, endAt: start + 20000 })] }), expect.any(AbortSignal))
  f.client.stop()
})
function fixture() {
  const api = { proactive: vi.fn((body: { op: string }) => Promise.resolve(body.op === 'consent' ? { consent: { id: 'session-consent', grantedAt: Date.now(), until: null } } : ['notify', 'can-notify'].includes(body.op) ? { notify: true } : {
    settings: { enabled: true, categories: ['approvals'], retentionDays: 1, quietStart: 22, quietEnd: 8, timeZone: 'UTC', maxPerHour: 3 },
    quiet: false, items: [{ id: 'approval', title: 'Review needed', summary: 'Open main', important: true, seen: false, action: 'review-on-main', category: 'approvals' }],
  })) }
  const view = { activity: vi.fn(), memoryStatus: vi.fn(), inbox: vi.fn(), proactiveSettings: vi.fn(), saveStatus: vi.fn(), consentLost: vi.fn() }, notify = vi.fn(), idle = vi.fn(() => false)
  const client = new G2ProactiveClient(api as unknown as ConstructorParameters<typeof G2ProactiveClient>[0], view, idle, notify)
  return { api, view, client, notify, idle }
}

it('never uploads wake transcripts without explicit memory consent', async () => {
  vi.useFakeTimers(); const f = fixture(); f.client.start()
  f.client.capture("I'll send a proposal")
  await vi.advanceTimersByTimeAsync(61000)
  expect(f.api.proactive.mock.calls.some(([b]) => b.op === 'capture')).toBe(false)
  expect(f.api.proactive.mock.calls.some(([b]) => b.op === 'notify')).toBe(false)
  expect(f.notify).not.toHaveBeenCalled(); f.client.stop()
})

it('batches finalized text after opt-in and drops pending text when memory pauses', async () => {
  vi.useFakeTimers(); const f = fixture(); f.client.start(); await f.client.grantMemory(true); f.client.resumeMemory()
  f.client.capture("I'll send the plan")
  await vi.advanceTimersByTimeAsync(30000)
  expect(f.api.proactive).toHaveBeenCalledWith(expect.objectContaining({ op: 'capture', texts: ["I'll send the plan"], consentId: 'session-consent' }), expect.any(AbortSignal))
  f.client.capture('Another commitment'); f.client.revokeMemory()
  await vi.advanceTimersByTimeAsync(30000)
  expect(f.api.proactive.mock.calls.filter(([b]) => b.op === 'capture')).toHaveLength(1)
  expect(f.api.proactive).toHaveBeenCalledWith({ op: 'consent', enabled: false, consentId: 'session-consent' })
  expect(f.client.memoryActive).toBe(false)
  f.client.stop()
})

it('native foreground exit drops unsent text locally and keeps consent without revoking it', async () => {
  vi.useFakeTimers(); const f = fixture(); f.client.start(); await f.client.grantMemory(true); f.client.resumeMemory()
  f.client.capture('Private speech'); f.client.setForeground(false)
  await vi.advanceTimersByTimeAsync(60000)
  expect(f.client.memoryActive).toBe(true); expect(f.client.capturing).toBe(false)
  f.client.setForeground(true); f.client.capture('More speech'); await vi.advanceTimersByTimeAsync(30000)
  expect(f.api.proactive.mock.calls.some(([b]) => b.op === 'capture')).toBe(false)
  expect(f.api.proactive.mock.calls.some(([b]) => b.op === 'consent' && (b as { enabled?: boolean }).enabled === false)).toBe(false)
  // Capture restarts only when the app resumes listening.
  f.client.resumeMemory(); f.client.capture('Back again'); await vi.advanceTimersByTimeAsync(30000)
  expect(f.api.proactive).toHaveBeenCalledWith(expect.objectContaining({ op: 'capture', texts: ['Back again'], consentId: 'session-consent' }), expect.any(AbortSignal))
  f.client.stop()
  expect(f.api.proactive.mock.calls.some(([b]) => b.op === 'consent' && (b as { enabled?: boolean }).enabled === false)).toBe(false)
})

it('delivers an idle alert only after server permission and releases timers on exit', async () => {
  vi.useFakeTimers(); const f = fixture(); f.idle.mockReturnValue(true); f.client.start()
  await vi.advanceTimersByTimeAsync(1)
  expect(f.notify).toHaveBeenCalledWith(expect.objectContaining({ id: 'approval' }))
  f.client.stop(); const count = f.api.proactive.mock.calls.length
  await vi.advanceTimersByTimeAsync(180000)
  expect(f.api.proactive).toHaveBeenCalledTimes(count)
})

it('a failed upload drops that batch without replay and keeps lifelog on', async () => {
  vi.useFakeTimers(); const f = fixture(); f.client.start(); await f.client.grantMemory(true); f.client.resumeMemory()
  f.api.proactive.mockImplementation(body => body.op === 'capture' ? Promise.reject(new Error('offline')) : Promise.resolve({ items: [] } as never))
  f.client.capture('Remember to call the team'); await vi.advanceTimersByTimeAsync(120000)
  expect(f.api.proactive.mock.calls.filter(([b]) => b.op === 'capture')).toHaveLength(1)
  expect(f.client.capturing).toBe(true)
  expect(f.api.proactive.mock.calls.some(([b]) => b.op === 'consent' && (b as { enabled?: boolean }).enabled === false)).toBe(false)
  expect(f.view.saveStatus).toHaveBeenLastCalledWith(expect.stringContaining('not replayed')); f.client.stop()
})

it('main rejecting the grant (revoked there) stops capture and reports the lost consent', async () => {
  vi.useFakeTimers(); const f = fixture(); f.client.start(); await f.client.grantMemory(true); f.client.resumeMemory()
  f.api.proactive.mockImplementation(body => body.op === 'capture' ? Promise.reject(new OpenAGIApiError('revoked', 403, 'revoked')) : Promise.resolve({ items: [] } as never))
  f.client.capture('Words'); await vi.advanceTimersByTimeAsync(30000)
  expect(f.client.memoryActive).toBe(false); expect(f.view.consentLost).toHaveBeenCalledOnce(); f.client.stop()
})

it('reads, adopts and re-verifies a persistent grant without expiry', async () => {
  vi.useFakeTimers(); const f = fixture(); f.client.start()
  const grant = { id: 'kept', grantedAt: 1, until: null }
  f.api.proactive.mockImplementation(body => Promise.resolve((body.op === 'settings' ? { consent: grant } : { items: [] }) as never))
  expect(await f.client.readConsent()).toEqual(grant)
  f.client.adoptConsent(grant); expect(f.client.capturing).toBe(false)
  vi.setSystemTime(Date.now() + 30 * 86400_000)
  expect(f.client.resumeMemory()).toBe(true); expect(f.client.capturing).toBe(true)
  f.client.stop()
})

it('Supervisor mode pings a supervisor question without the general updates opt-in', async () => {
  vi.useFakeTimers(); const f = fixture(); f.idle.mockReturnValue(true)
  const question = { id: 'fleet-q', title: 'Merge?', summary: '', important: true, seen: false, action: 'answer-fleet', category: 'approvals', supervisor: true, options: ['yes'] }
  f.api.proactive.mockImplementation(body => Promise.resolve((['notify', 'can-notify'].includes(body.op) ? { notify: true } : { settings: { enabled: false, supervisorOnly: true }, quiet: false, items: [question] }) as never))
  f.client.start(); await vi.advanceTimersByTimeAsync(1)
  expect(f.notify).toHaveBeenCalledWith(expect.objectContaining({ id: 'fleet-q' })); f.client.stop()
})

it('an answer drops a feed read that started before it and fetches a fresh one', async () => {
  vi.useFakeTimers(); const f = fixture()
  const question = { id: 'fleet-q', title: 'Which plan?', summary: '', important: false, seen: true, action: 'answer-fleet', category: 'approvals', supervisor: true, options: ['Starter'] }
  let answered = false
  let releaseStale: (() => void) | null = null
  const proactive = f.api.proactive as unknown as { mockImplementation: (fn: (body: { op: string }) => Promise<unknown>) => void }
  proactive.mockImplementation((body: { op: string }) => {
    if (body.op === 'answer') { answered = true; return Promise.resolve({ ok: true, detail: 'typed' }) }
    const snapshot = { settings: { enabled: false }, quiet: false, items: answered ? [] : [question] }
    // The first read is slow and returns the pre-answer snapshot.
    if (!releaseStale && !answered) return new Promise(resolve => { releaseStale = () => resolve(snapshot) })
    return Promise.resolve(snapshot)
  })
  f.client.start(); await vi.advanceTimersByTimeAsync(1)
  const result = await f.client.answer('fleet-q', 'Starter')
  expect(result.ok).toBe(true)
  expect(f.client.items).toEqual([])
  releaseStale!(); await vi.advanceTimersByTimeAsync(1)
  expect(f.client.items).toEqual([])
  expect(f.api.proactive.mock.calls.filter(([b]) => b.op === 'feed').length).toBe(2)
  f.client.stop()
})
