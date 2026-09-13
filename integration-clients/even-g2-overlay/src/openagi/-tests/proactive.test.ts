import { afterEach, expect, it, vi } from 'vitest'
import { G2ProactiveClient } from '../proactive'

afterEach(() => vi.useRealTimers())

it('retains eleven separate utterances across bounded batches', async () => {
  vi.useFakeTimers(); const f = fixture(); f.client.start(); await f.client.enableMemory(true)
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
  vi.useFakeTimers(); const f = fixture(); f.client.start(); await f.client.enableMemory(true)
  const start = Date.now()
  for (let i = 0; i < 20; i++) f.client.capture('word', { at: start + i * 1000, endAt: start + (i + 1) * 1000, streamId: 'fixture-stream', speaker: 0 })
  await vi.advanceTimersByTimeAsync(30000)
  expect(f.api.proactive).toHaveBeenCalledWith(expect.objectContaining({ op: 'capture', texts: [Array(20).fill('word').join(' ')], segments: [expect.objectContaining({ speaker: 0, at: start, endAt: start + 20000 })] }), expect.any(AbortSignal))
  f.client.stop()
})
function fixture() {
  const api = { proactive: vi.fn((body: { op: string }) => Promise.resolve(body.op === 'consent' ? { consent: { id: 'session-consent', until: Date.now() + 3600_000 } } : ['notify', 'can-notify'].includes(body.op) ? { notify: true } : {
    settings: { enabled: true, categories: ['approvals'], retentionDays: 1, quietStart: 22, quietEnd: 8, timeZone: 'UTC', maxPerHour: 3 },
    quiet: false, items: [{ id: 'approval', title: 'Review needed', summary: 'Open main', important: true, seen: false, action: 'review-on-main', category: 'approvals' }],
  })) }
  const view = { activity: vi.fn(), memoryStatus: vi.fn(), inbox: vi.fn(), proactiveSettings: vi.fn() }, notify = vi.fn(), idle = vi.fn(() => false)
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
  vi.useFakeTimers(); const f = fixture(); f.client.start(); await f.client.enableMemory(true)
  f.client.capture("I'll send the plan")
  await vi.advanceTimersByTimeAsync(30000)
  expect(f.api.proactive).toHaveBeenCalledWith(expect.objectContaining({ op: 'capture', texts: ["I'll send the plan"], consentId: 'session-consent' }), expect.any(AbortSignal))
  f.client.capture('Another commitment'); f.client.pauseMemory()
  await vi.advanceTimersByTimeAsync(30000)
  expect(f.api.proactive.mock.calls.filter(([b]) => b.op === 'capture')).toHaveLength(1)
  f.client.stop()
})

it('native foreground exit drops unsent text and does not rearm memory on return', async () => {
  vi.useFakeTimers(); const f = fixture(); f.client.start(); await f.client.enableMemory(true)
  f.client.capture('Private speech'); f.client.setForeground(false)
  await vi.advanceTimersByTimeAsync(60000)
  f.client.setForeground(true); f.client.capture('More speech'); await vi.advanceTimersByTimeAsync(30000)
  expect(f.api.proactive.mock.calls.some(([b]) => b.op === 'capture')).toBe(false)
  expect(f.view.memoryStatus).toHaveBeenLastCalledWith(false, expect.any(String)); f.client.stop()
})

it('delivers an idle alert only after server permission and releases timers on exit', async () => {
  vi.useFakeTimers(); const f = fixture(); f.idle.mockReturnValue(true); f.client.start()
  await vi.advanceTimersByTimeAsync(1)
  expect(f.notify).toHaveBeenCalledWith(expect.objectContaining({ id: 'approval' }))
  f.client.stop(); const count = f.api.proactive.mock.calls.length
  await vi.advanceTimersByTimeAsync(180000)
  expect(f.api.proactive).toHaveBeenCalledTimes(count)
})

it('failed capture pauses memory without replaying audio or text', async () => {
  vi.useFakeTimers(); const f = fixture(); f.client.start(); await f.client.enableMemory(true)
  f.api.proactive.mockImplementation(body => body.op === 'capture' ? Promise.reject(new Error('offline')) : Promise.resolve({ items: [] } as never))
  f.client.capture('Remember to call the team'); await vi.advanceTimersByTimeAsync(120000)
  expect(f.api.proactive.mock.calls.filter(([b]) => b.op === 'capture')).toHaveLength(1)
  expect(f.view.memoryStatus).toHaveBeenLastCalledWith(false, expect.stringContaining('upload failed')); f.client.stop()
})
