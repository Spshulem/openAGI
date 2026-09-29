import { expect, it, vi } from 'vitest'
import { OpenAGIG2App } from '../../app/openagi-g2-app'
import { OpenAGIStore, type OpenAGIState } from '../store'
import type { LiveSpeech, SpeechCallbacks } from '../live-speech'
import { SpeechStreamError } from '../live-speech'
import type { OpenAGIApiClient } from '../api-client'
import { OpenAGIApiError } from '../config'

type Consent = { id: string; grantedAt: number; until: number | null }
// A main that keeps one persistent grant per G2, like src/g2-proactive.js.
function mainConsent(initial: Consent | null = null) {
  const state = { consent: initial, grants: 0, revokes: 0, reachable: true }
  const proactive = vi.fn((body: { op: string; enabled?: boolean; consentId?: string }) => {
    if (!state.reachable && ['settings', 'consent'].includes(body.op)) return Promise.reject(new Error('Main offline'))
    if (body.op === 'consent') {
      if (body.enabled) { state.grants++; state.consent = { id: `grant-${state.grants}`, grantedAt: Date.now(), until: null } }
      else { state.revokes++; if (!body.consentId || body.consentId === state.consent?.id) state.consent = null }
      return Promise.resolve({ consent: state.consent })
    }
    if (body.op === 'settings') return Promise.resolve({ consent: state.consent })
    return Promise.resolve({ items: [] })
  })
  return { state, proactive }
}

async function fixture(initial: Partial<Omit<OpenAGIState, 'version'>> = {}, restored?: { saved?: string; proactive?: (body: { op: string }) => Promise<unknown> }) {
  const storage = { get: vi.fn(() => Promise.resolve(restored?.saved ?? null as string | null)), set: vi.fn(() => Promise.resolve()), remove: vi.fn(() => Promise.resolve()) }
  const store = new OpenAGIStore(storage)
  await store.update({ autoSend: false, ...initial })
  await store.update({ nodeToken: 'saved-scoped-token-123', connectionMode: 'direct', agentOrigin: 'https://main.example.com', conversationId: crypto.randomUUID(), speechModel: 'nova-3' })
  let receive: (pcm: Uint8Array) => void = () => {}
  let callbacks!: SpeechCallbacks
  const audio = { active: true, start: vi.fn((cb: typeof receive) => { receive = cb; return Promise.resolve() }), stop: vi.fn(() => Promise.resolve()) }
  const speech = { open: vi.fn(() => Promise.resolve()), push: vi.fn(), close: vi.fn(), snapshotText: vi.fn(() => ''), finish: vi.fn(() => Promise.resolve('What time is it?')) }
  const api = { speechRelay: vi.fn(() => ({ url: 'wss://main.example.com/nodes/g2/speech?model=nova-3', token: 'saved-scoped-token-123' })), speechToken: vi.fn(() => Promise.resolve({ accessToken: 'short-lived-token', expiresIn: 30 })), askText: vi.fn<OpenAGIApiClient['askText']>(() => Promise.resolve({ question: 'What time is it?', reply: 'Noon', sessionId: 'fixture-session' })), ask: vi.fn(), listen: vi.fn() }
  if (restored?.proactive) Object.assign(api, { proactive: restored.proactive })
  const renderer = { requestExit: vi.fn(() => Promise.resolve(true)), review: vi.fn(), inboxList: vi.fn(), inbox: vi.fn(), inboxAction: vi.fn(), notice: vi.fn(), home: vi.fn(), passive: vi.fn(), lifelogHome: vi.fn(), listening: vi.fn(), transcript: vi.fn(), progress: vi.fn(), answer: vi.fn(), message: vi.fn(), sleep: vi.fn(), supervisorHome: vi.fn(), fleetStatus: vi.fn(), recent: vi.fn(), flash: vi.fn(), speaker: vi.fn() }
  const phone = { draft: vi.fn(), set: vi.fn(), paired: vi.fn(), transcript: vi.fn(), speechModel: vi.fn(), activity: vi.fn(), recordingConsent: vi.fn(), lifelogState: vi.fn(), memoryStatus: vi.fn(), homeMode: vi.fn() }
  type Args = ConstructorParameters<typeof OpenAGIG2App>
  const app = new OpenAGIG2App(api as unknown as Args[0], store, audio, renderer as unknown as Args[3], phone as unknown as Args[4], [], cb => { callbacks = cb; return { ...speech } as unknown as LiveSpeech })
  await app.boot()
  return { app, api, audio, renderer, phone, speech, store, storage, receive: (pcm: Uint8Array) => receive(pcm), callbacks: () => callbacks }
}

// Lifelog mode with the owner's standing consent already given on the phone.
async function lifelogFixture(initial: Partial<Omit<OpenAGIState, 'version'>> = {}, main = mainConsent()) {
  const f = await fixture({ homeMode: 'lifelog', recordingConsent: true, ...initial }, { proactive: main.proactive })
  return { ...f, main }
}
const consentOps = (main: ReturnType<typeof mainConsent>) => main.proactive.mock.calls.filter(([b]) => b.op === 'consent')

it('retains failed finalization for explicit review with auto-send, without resuming lifelog over it', async () => {
  const f = await lifelogFixture()
  try {
    await f.app.configureAutoSend(true); await f.app.startAsk()
    f.speech.snapshotText.mockReturnValue('Please keep these words')
    const error = new SpeechStreamError('Finalization timed out', 'finalization_timeout')
    f.speech.finish.mockImplementationOnce(() => { f.callbacks().error(error); return Promise.reject(error) })
    await f.app.finishAsk()
    expect(f.api.askText).not.toHaveBeenCalled()
    expect(f.phone.draft).toHaveBeenLastCalledWith('Please keep these words', 'speech')
    expect(f.renderer.review).toHaveBeenLastCalledWith('Please keep these words', 0, 1, 'speech')
    expect(f.audio.start).toHaveBeenCalledTimes(2) // lifelog + question, no resume over review
    await f.app.sendDraft()
    expect(f.api.askText).toHaveBeenCalledExactlyOnceWith('Please keep these words', expect.any(String), expect.any(Function), expect.any(AbortSignal), 'agent')
  } finally { await f.app.systemExit() }
})

it('Talk: mic off at home, tap starts, tap again stops and sends to the shared agent thread', async () => {
  vi.useFakeTimers()
  const f = await fixture({ autoSend: true })
  try {
    expect(f.audio.start).not.toHaveBeenCalled()
    expect(f.renderer.home).toHaveBeenCalled()
    f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    expect(f.audio.start).toHaveBeenCalledOnce(); expect(f.renderer.listening).toHaveBeenCalled()
    // The stop tap is never swallowed as a bounce.
    await vi.advanceTimersByTimeAsync(100); f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    expect(f.api.askText).toHaveBeenCalledExactlyOnceWith('What time is it?', expect.any(String), expect.any(Function), expect.any(AbortSignal), 'agent')
    expect(f.renderer.answer).toHaveBeenLastCalledWith('Noon', 0, 1)
    expect(f.audio.start).toHaveBeenCalledOnce() // Talk never reopens the mic by itself.
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it('Talk: swipe down reads the shared agent conversation and opens an answer', async () => {
  const f = await fixture()
  try {
    const readThread = vi.fn(() => Promise.resolve({ thread: 'agent', messages: [
      { id: 'm1', role: 'user', text: 'Plan my week', at: '2026-09-27T10:00:00Z', sourceName: 'Pixel' },
      { id: 'm2', role: 'assistant', text: 'Monday: focus.', at: '2026-09-27T10:00:05Z' },
      { id: 'm3', role: 'user', text: 'And Tuesday?', at: '2026-09-27T10:01:00Z', sourceName: null },
      { id: 'm4', role: 'assistant', text: 'Tuesday: meetings.', at: '2026-09-27T10:01:05Z' },
    ], nextBefore: null }))
    Object.assign(f.api, { readThread })
    f.app.scrollDown()
    await vi.waitFor(() => expect(f.renderer.recent).toHaveBeenLastCalledWith('And Tuesday?', 1, 2))
    expect(readThread).toHaveBeenCalledWith('agent')
    f.app.scrollDown(); expect(f.renderer.recent).toHaveBeenLastCalledWith('Pixel: Plan my week', 2, 2)
    f.app.tap(); await vi.waitFor(() => expect(f.renderer.answer).toHaveBeenLastCalledWith('Monday: focus.', 0, 1))
    // A main without shared threads falls back to answers saved on this phone.
    readThread.mockResolvedValueOnce(null as never)
    await f.store.remember('Local question', 'Local answer')
    f.app.doubleTap(); await vi.waitFor(() => expect(f.renderer.home).toHaveBeenCalled())
    f.app.scrollDown()
    await vi.waitFor(() => expect(f.renderer.recent).toHaveBeenLastCalledWith('Local question', 1, 1))
  } finally { await f.app.systemExit() }
})

it('Supervisor: status page tap talks to the supervisor thread; an older main says so without a resend draft', async () => {
  vi.useFakeTimers()
  const f = await fixture({ autoSend: true })
  try {
    vi.spyOn(f.app.proactive, 'configure').mockResolvedValue()
    const status = { mode: 'auto', lastTickAt: null, needsYou: 0, counts: { red: 0, yellow: 0, green: 2, gray: 0 }, threads: [] }
    vi.spyOn(f.app.proactive, 'fleetStatus').mockResolvedValue(status)
    await f.app.configureHomeMode('supervisor')
    expect(f.renderer.speaker).toHaveBeenLastCalledWith('Supervisor')
    // No questions: tap shows status; tap on status starts talking to the supervisor.
    f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    expect(f.renderer.fleetStatus).toHaveBeenCalledWith(expect.stringContaining('2 green'), 0, 1)
    await vi.advanceTimersByTimeAsync(500); f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    expect(f.audio.start).toHaveBeenCalledOnce()
    f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    expect(f.api.askText).toHaveBeenLastCalledWith('What time is it?', expect.any(String), expect.any(Function), expect.any(AbortSignal), 'supervisor')
    f.api.askText.mockRejectedValueOnce(new OpenAGIApiError('threads_unsupported', 400, 'Update OpenAGI on your main to talk to the supervisor from the glasses. Nothing was sent.'))
    await vi.advanceTimersByTimeAsync(500); f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(500); f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    expect(f.renderer.message).toHaveBeenLastCalledWith('Could not ask agent', expect.stringContaining('Update OpenAGI'))
    expect(f.phone.draft).not.toHaveBeenCalledWith(expect.anything(), 'delivery')
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it('Supervisor home: press and hold talks to the supervisor, letting go sends without a review', async () => {
  vi.useFakeTimers()
  // Review is on (autoSend false): push-to-talk still sends on release.
  const f = await fixture({ autoSend: false })
  try {
    vi.spyOn(f.app.proactive, 'configure').mockResolvedValue()
    await f.app.configureHomeMode('supervisor')
    expect(f.app.holdStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.audio.start).toHaveBeenCalledOnce()
    f.app.holdRelease(); await vi.advanceTimersByTimeAsync(1)
    expect(f.api.askText).toHaveBeenLastCalledWith('What time is it?', expect.any(String), expect.any(Function), expect.any(AbortSignal), 'supervisor')
    expect(f.renderer.review).not.toHaveBeenCalled()
    // Outside Supervisor home a hold stays a plain tap.
    await f.app.configureHomeMode('talk')
    expect(f.app.holdStart()).toBe(false)
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it('Supervisor home: letting go before the microphone opened still sends once it has', async () => {
  vi.useFakeTimers()
  const f = await fixture({ autoSend: false })
  try {
    vi.spyOn(f.app.proactive, 'configure').mockResolvedValue()
    await f.app.configureHomeMode('supervisor')
    let opened!: () => void
    f.audio.start.mockImplementationOnce(() => new Promise<void>((resolve) => { opened = resolve }))
    expect(f.app.holdStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    f.app.holdRelease()
    expect(f.api.askText).not.toHaveBeenCalled()
    opened(); await vi.advanceTimersByTimeAsync(1)
    expect(f.api.askText).toHaveBeenLastCalledWith('What time is it?', expect.any(String), expect.any(Function), expect.any(AbortSignal), 'supervisor')
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it('Supervisor home: leaving the glasses mid-hold sends nothing and the next tap follows the review setting', async () => {
  vi.useFakeTimers()
  const f = await fixture({ autoSend: false })
  try {
    vi.spyOn(f.app.proactive, 'configure').mockResolvedValue()
    const status = { mode: 'auto', lastTickAt: null, needsYou: 0, counts: { red: 0, yellow: 0, green: 1, gray: 0 }, threads: [] }
    vi.spyOn(f.app.proactive, 'fleetStatus').mockResolvedValue(status)
    await f.app.configureHomeMode('supervisor')
    expect(f.app.holdStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    f.app.setForeground(false); await vi.advanceTimersByTimeAsync(1)
    f.app.setForeground(true); await vi.advanceTimersByTimeAsync(600)
    expect(f.api.askText).not.toHaveBeenCalled()
    // Status page, then a tapped recording: it goes to review, not straight out.
    f.app.tap(); await vi.advanceTimersByTimeAsync(600)
    f.app.tap(); await vi.advanceTimersByTimeAsync(600)
    f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    expect(f.api.askText).not.toHaveBeenCalled()
    expect(f.phone.draft).toHaveBeenLastCalledWith('What time is it?', undefined)
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it('Supervisor home: a hold past the 30-second live limit sends what was said and says why', async () => {
  vi.useFakeTimers()
  const f = await fixture({ autoSend: false })
  try {
    vi.spyOn(f.app.proactive, 'configure').mockResolvedValue()
    await f.app.configureHomeMode('supervisor')
    expect(f.app.holdStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(30_001)
    expect(f.phone.set).toHaveBeenCalledWith('30-second limit', expect.stringContaining('sending what you said'))
    expect(f.api.askText).toHaveBeenCalledOnce()
    f.app.holdRelease(); await vi.advanceTimersByTimeAsync(1)
    expect(f.api.askText).toHaveBeenCalledOnce()
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it('Supervisor home: a release just after the 30-second limit still sends, with review on', async () => {
  vi.useFakeTimers()
  const f = await fixture({ autoSend: false })
  try {
    vi.spyOn(f.app.proactive, 'configure').mockResolvedValue()
    await f.app.configureHomeMode('supervisor')
    let finish!: (text: string) => void
    f.speech.finish.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve }))
    expect(f.app.holdStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(30_001)
    // Released while the limit's finish is still waiting on the transcript.
    f.app.holdRelease(); await vi.advanceTimersByTimeAsync(1)
    finish('Resume my sessions'); await vi.advanceTimersByTimeAsync(1)
    expect(f.api.askText).toHaveBeenLastCalledWith('Resume my sessions', expect.any(String), expect.any(Function), expect.any(AbortSignal), 'supervisor')
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it('buffered speech: a recording that reaches 30 seconds is kept and finished, not lost', async () => {
  vi.useFakeTimers()
  const f = await fixture({ autoSend: false })
  try {
    await f.store.update({ speechModel: 'openai-buffered' })
    vi.spyOn(f.app.proactive, 'configure').mockResolvedValue()
    await f.app.configureHomeMode('supervisor')
    f.api.ask.mockResolvedValue({ question: 'Resume my sessions', reply: 'On it', sessionId: 's' })
    expect(f.app.holdStart()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    // 16 kHz, 16-bit mono: 32,000 bytes a second; 31 seconds of frames.
    for (let i = 0; i < 31; i += 1) f.receive(new Uint8Array(32_000))
    await vi.advanceTimersByTimeAsync(1)
    expect(f.phone.set).toHaveBeenCalledWith('30-second limit', expect.stringContaining('sending what you said'))
    expect(f.api.ask).toHaveBeenCalledOnce()
    expect(f.renderer.message).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('30 second limit'))
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it('a missed foreground-enter never strands the app: any glasses gesture resumes', async () => {
  vi.useFakeTimers()
  const f = await lifelogFixture()
  try {
    expect(f.app.proactive.capturing).toBe(true)
    f.app.setForeground(false); await vi.advanceTimersByTimeAsync(1)
    expect(f.app.proactive.capturing).toBe(false); expect(f.app.proactive.memoryActive).toBe(true)
    expect(f.renderer.message).not.toHaveBeenCalledWith('Listening paused', expect.anything())
    // Even never sends FOREGROUND_ENTER; the owner just swipes.
    f.app.glassesInput(); f.app.scrollUp()
    await vi.advanceTimersByTimeAsync(500)
    expect(f.audio.start).toHaveBeenCalledTimes(2); expect(f.app.proactive.capturing).toBe(true)
    expect(f.main.state.grants).toBe(1); expect(f.main.state.revokes).toBe(0)
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it('a locked phone never blocks glasses asks or lifelog; only a real audio gap suspends it locally', async () => {
  vi.useFakeTimers()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const f = await lifelogFixture({ autoSend: true })
  try {
    visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange'))
    for (let n = 0; n < 6; n++) { await vi.advanceTimersByTimeAsync(2000); f.receive(new Uint8Array(640)) }
    expect(f.app.proactive.capturing).toBe(true)
    f.callbacks().segment!('Remember to buy milk', { at: Date.now(), endAt: Date.now(), streamId: 'live-test', speaker: null })
    for (let n = 0; n < 16; n++) { await vi.advanceTimersByTimeAsync(2000); f.receive(new Uint8Array(640)) }
    expect(f.main.proactive).toHaveBeenCalledWith(expect.objectContaining({ op: 'capture', consentId: 'grant-1', texts: ['Remember to buy milk'] }), expect.anything())
    // No audio for 10 seconds while locked: local stop, consent untouched.
    const stops = f.audio.stop.mock.calls.length
    await vi.advanceTimersByTimeAsync(12000)
    expect(f.audio.stop.mock.calls.length).toBeGreaterThan(stops); expect(f.app.proactive.capturing).toBe(false)
    expect(consentOps(f.main)).toHaveLength(1)
    // A glasses tap still talks to the agent while the phone is locked.
    f.app.glassesInput(); f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    expect(f.renderer.listening).toHaveBeenCalled()
    f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    expect(f.api.askText).toHaveBeenCalledOnce()
    // ...and lifelog resumes afterwards with the same grant.
    await vi.advanceTimersByTimeAsync(500)
    expect(f.app.proactive.capturing).toBe(true); expect(f.main.state.grants).toBe(1)
  } finally { visibility.mockRestore(); await f.app.systemExit(); vi.useRealTimers() }
})

it('Lifelog: tap talks to the agent, tap again sends, and listening resumes with the same consent', async () => {
  vi.useFakeTimers()
  const f = await lifelogFixture({ autoSend: true })
  try {
    expect(f.renderer.passive).toHaveBeenLastCalledWith(true)
    f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    expect(f.renderer.listening).toHaveBeenCalled(); expect(f.app.proactive.capturing).toBe(false)
    f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    expect(f.api.askText).toHaveBeenCalledOnce()
    expect(f.renderer.answer).toHaveBeenLastCalledWith('Noon', 0, 1)
    expect(f.app.proactive.capturing).toBe(true)
    expect(f.audio.start).toHaveBeenCalledTimes(3)
    expect(consentOps(f.main)).toHaveLength(1)
    // Overheard speech never becomes a question.
    f.callbacks().utterance('Peri what time is it?'); f.callbacks().transcript('Peri what time is it?', true, 0)
    expect(f.api.askText).toHaveBeenCalledOnce(); expect(f.renderer.transcript).not.toHaveBeenCalled()
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it('Lifelog: swipe-down controls pause and resume locally without revoking or re-granting', async () => {
  vi.useFakeTimers()
  const f = await lifelogFixture()
  try {
    const tap = async () => { f.app.tap(); await vi.advanceTimersByTimeAsync(500) }
    f.app.scrollDown()
    expect(f.renderer.inboxAction).toHaveBeenLastCalledWith('Mark this moment', 'Lifelog', false)
    f.app.scrollUp(); expect(f.renderer.inboxAction).toHaveBeenLastCalledWith('Pause listening', 'Lifelog', false)
    await tap()
    expect(f.renderer.lifelogHome).toHaveBeenLastCalledWith('paused', '')
    expect(f.app.proactive.capturing).toBe(false); expect(f.app.proactive.memoryActive).toBe(true)
    // A pause is not undone by gestures or foreground changes.
    f.app.glassesInput(); f.app.setForeground(false); f.app.setForeground(true); await vi.advanceTimersByTimeAsync(1000)
    expect(f.audio.start).toHaveBeenCalledOnce()
    f.app.scrollDown(); expect(f.renderer.inboxAction).toHaveBeenLastCalledWith('Resume listening', 'Lifelog', false)
    await tap()
    expect(f.audio.start).toHaveBeenCalledTimes(2); expect(f.app.proactive.capturing).toBe(true)
    expect(consentOps(f.main)).toHaveLength(1)
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it('Lifelog consent is asked once: it survives hours, background, reopening, and never expires', async () => {
  vi.useFakeTimers()
  const main = mainConsent()
  const f = await lifelogFixture({}, main)
  let reopened: Awaited<ReturnType<typeof fixture>> | undefined
  try {
    expect(f.store.snapshot().lifelogConsent?.id).toBe('grant-1')
    vi.setSystemTime(Date.now() + 5 * 3600_000)
    f.app.setForeground(false); await vi.advanceTimersByTimeAsync(1); f.app.setForeground(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.audio.start).toHaveBeenCalledTimes(2); expect(f.app.proactive.capturing).toBe(true)
    const saved = JSON.stringify(f.store.snapshot())
    await f.app.systemExit()
    expect(main.state.consent?.id).toBe('grant-1')
    reopened = await fixture({}, { saved, proactive: main.proactive })
    expect(reopened.audio.start).toHaveBeenCalledOnce(); expect(reopened.app.proactive.capturing).toBe(true)
    expect(main.state.grants).toBe(1); expect(main.state.revokes).toBe(0)
  } finally { await f.app.systemExit(); await reopened?.app.systemExit(); vi.useRealTimers() }
})

it('leaving Lifelog revokes on main; choosing it again re-grants from the remembered checkbox', async () => {
  const f = await lifelogFixture()
  try {
    vi.spyOn(f.app.proactive, 'configure').mockResolvedValue()
    await f.app.configureHomeMode('talk')
    expect(f.main.state.consent).toBeNull(); expect(f.main.state.revokes).toBe(1)
    expect(f.store.snapshot()).toMatchObject({ homeMode: 'talk', recordingConsent: true, lifelogConsent: null })
    expect(f.audio.stop).toHaveBeenCalled(); expect(f.app.proactive.memoryActive).toBe(false)
    await f.app.configureHomeMode('lifelog')
    expect(f.main.state.grants).toBe(2); expect(f.app.proactive.capturing).toBe(true)
    expect(f.phone.recordingConsent).not.toHaveBeenCalledWith(false)
  } finally { await f.app.systemExit() }
})

it('unchecking consent revokes and stops; checking it again starts lifelog without any glasses prompt', async () => {
  const f = await lifelogFixture()
  try {
    await f.app.configureRecordingConsent(false)
    expect(f.main.state.consent).toBeNull(); expect(f.app.proactive.memoryActive).toBe(false)
    expect(f.renderer.lifelogHome).toHaveBeenLastCalledWith('consent', '')
    const starts = f.audio.start.mock.calls.length
    await f.app.configureRecordingConsent(true)
    expect(f.audio.start.mock.calls.length).toBe(starts + 1); expect(f.app.proactive.capturing).toBe(true)
  } finally { await f.app.systemExit() }
})

it('Lifelog without consent shows where to give it, and Talk still works', async () => {
  vi.useFakeTimers()
  const main = mainConsent()
  const f = await fixture({ homeMode: 'lifelog', recordingConsent: false, autoSend: true }, { proactive: main.proactive })
  try {
    expect(f.renderer.lifelogHome).toHaveBeenLastCalledWith('consent', '')
    expect(f.audio.start).not.toHaveBeenCalled(); expect(consentOps(main)).toHaveLength(0)
    f.app.tap(); await vi.advanceTimersByTimeAsync(1); f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    expect(f.api.askText).toHaveBeenCalledOnce(); expect(consentOps(main)).toHaveLength(0)
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it.each(['revoked', 'different', 'deleted'])('respects a grant main no longer holds (%s) instead of recording', async reason => {
  const main = mainConsent()
  const first = await lifelogFixture({}, main)
  const saved = JSON.stringify(first.store.snapshot())
  await first.app.systemExit()
  main.state.consent = reason === 'different' ? { id: 'replacement', grantedAt: 1, until: null } : null
  const reopened = await fixture({}, { saved, proactive: main.proactive })
  try {
    expect(reopened.audio.start).not.toHaveBeenCalled(); expect(reopened.app.proactive.memoryActive).toBe(false)
    expect(main.state.grants).toBe(1)
    expect(reopened.store.snapshot()).toMatchObject({ recordingConsent: false, lifelogConsent: null })
    expect(reopened.phone.recordingConsent).toHaveBeenLastCalledWith(false)
  } finally { await reopened.app.systemExit() }
})

it('an offline main keeps lifelog waiting and retries on its own; a legacy expiring grant is still honoured', async () => {
  vi.useFakeTimers()
  const main = mainConsent({ id: 'legacy', grantedAt: 0, until: Date.now() - 1000 })
  main.state.reachable = false
  const f = await fixture({ homeMode: 'lifelog', recordingConsent: true }, { proactive: main.proactive })
  try {
    expect(f.audio.start).not.toHaveBeenCalled()
    expect(f.renderer.lifelogHome).toHaveBeenLastCalledWith('waiting', expect.stringContaining('Main unreachable'))
    main.state.reachable = true
    await vi.advanceTimersByTimeAsync(15_000)
    expect(f.audio.start).toHaveBeenCalledOnce(); expect(f.app.proactive.consentId).toBe('legacy')
    expect(main.state.grants).toBe(0)
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it('rapid background and foreground switching settles on one listening session and one grant', async () => {
  const f = await lifelogFixture()
  try {
    f.app.setForeground(false); f.app.setForeground(true); f.app.setForeground(false); f.app.setForeground(true)
    await vi.waitFor(() => expect(f.app.proactive.capturing).toBe(true))
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(f.audio.start).toHaveBeenCalledTimes(2); expect(f.main.state.grants).toBe(1)
  } finally { await f.app.systemExit() }
})

it('withdrawing consent while main is granting never leaves a live grant or microphone', async () => {
  const main = mainConsent()
  let grant!: () => void
  const proactive = vi.fn((body: { op: string; enabled?: boolean }) => body.op === 'consent' && body.enabled
    ? new Promise(resolve => { grant = () => { resolve(main.proactive(body)) } }) : main.proactive(body))
  const booting = fixture({ homeMode: 'lifelog', recordingConsent: true }, { proactive })
  await vi.waitFor(() => expect(grant).toBeTypeOf('function'))
  const f = await Promise.race([booting, new Promise<null>(resolve => setTimeout(() => resolve(null), 50))])
  expect(f).toBeNull() // boot waits for lifelog start
  grant()
  const app = await booting
  try {
    await app.app.configureRecordingConsent(false)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(main.state.consent).toBeNull(); expect(app.app.proactive.memoryActive).toBe(false)
    expect(app.audio.stop).toHaveBeenCalled()
  } finally { await app.app.systemExit() }
})

it('clears main-specific consent when pairing credentials or main change, and all consent on unpair', async () => {
  const f = await fixture()
  try {
    await f.store.update({ recordingConsent: true, lifelogConsent: { id: 'saved', grantedAt: 1, until: null } })
    await f.store.update({ agentOrigin: 'https://other.example.com' })
    expect(f.store.snapshot().lifelogConsent).toBeNull(); expect(f.store.snapshot().recordingConsent).toBe(true)
    await f.store.update({ lifelogConsent: { id: 'new', grantedAt: 1, until: null } })
    await f.store.clearCredential()
    expect(f.store.snapshot().lifelogConsent).toBeNull(); expect(f.store.snapshot().recordingConsent).toBe(false)
  } finally { await f.app.systemExit() }
})

it('a failed question microphone shows the error and lifelog comes back by itself', async () => {
  const f = await lifelogFixture()
  try {
    f.audio.start.mockRejectedValueOnce(new Error('temporary microphone failure'))
    await f.app.startAsk()
    expect(f.renderer.message).toHaveBeenLastCalledWith('Could not ask agent', expect.stringContaining('temporary microphone failure'))
    expect(f.audio.start).toHaveBeenCalledTimes(3)
    expect(f.app.proactive.capturing).toBe(true)
  } finally { await f.app.systemExit() }
})

it('opening a recent answer and returning keeps lifelog listening', async () => {
  const f = await lifelogFixture()
  try {
    await f.store.remember('Earlier question', 'Earlier answer')
    f.audio.stop.mockClear(); await f.app.selectAnswer(0)
    expect(f.audio.stop).not.toHaveBeenCalled(); expect(f.app.proactive.capturing).toBe(true)
    f.app.doubleTap(); await vi.waitFor(() => expect(f.renderer.passive).toHaveBeenLastCalledWith(true))
    // Double-tap at the listening root asks Even for its exit dialog, nothing else.
    const before = f.store.snapshot(); f.audio.stop.mockClear()
    f.app.doubleTap(); await Promise.resolve()
    expect(f.renderer.requestExit).toHaveBeenCalledOnce(); expect(f.audio.stop).not.toHaveBeenCalled()
    expect(f.store.snapshot()).toEqual(before)
  } finally { await f.app.systemExit() }
})

it('returns from inbox to lifelog without restarting the microphone', async () => {
  const f = await lifelogFixture()
  try {
    f.app.proactive.items = [{ id: 'one', title: 'Test', summary: 'Update', important: false, seen: false, category: 'discoveries', action: 'review-on-main' }]
    f.app.openInbox(); f.app.doubleTap()
    await vi.waitFor(() => expect(f.renderer.passive).toHaveBeenLastCalledWith(true))
    expect(f.audio.start).toHaveBeenCalledOnce()
    const stop = vi.spyOn(f.app.proactive, 'stop')
    await f.app.connectAgent('not an origin', 'invalid')
    expect(stop).not.toHaveBeenCalled()
  } finally { await f.app.systemExit() }
})

it('buffered lifelog only transcribes and saves, never asks', async () => {
  const f = await lifelogFixture({ speechModel: 'openai-buffered' })
  try {
    await f.app.configureSpeech('openai-buffered')
    f.api.listen.mockResolvedValue({ question: 'Peri do something', triggered: true, armed: true, prompt: 'do something' })
    const capture = vi.spyOn(f.app.proactive, 'capture')
    const frame = (amplitude: number): Uint8Array => new Uint8Array(new Int16Array(1600).fill(amplitude).buffer)
    for (let i = 0; i < 4; i++) f.receive(frame(2000))
    for (let i = 0; i < 8; i++) f.receive(frame(0))
    await vi.waitFor(() => expect(capture).toHaveBeenCalledWith('Peri do something'))
    expect(f.api.askText).not.toHaveBeenCalled(); expect(f.api.ask).not.toHaveBeenCalled()
    expect(f.api.listen).toHaveBeenCalledWith(expect.any(Blob), expect.any(String), expect.objectContaining({ answerQuestions: false, forceAnswer: false }))
  } finally { await f.app.systemExit() }
})

it('a native foreground exit stops only locally and says so on the phone, not as a paused screen', async () => {
  const f = await lifelogFixture()
  try {
    f.renderer.message.mockClear()
    f.app.setForeground(false); await Promise.resolve()
    expect(f.speech.close).toHaveBeenCalled()
    expect(f.phone.set).toHaveBeenLastCalledWith('Agents in background', expect.stringContaining('consent stays on'))
    expect(f.renderer.message).not.toHaveBeenCalled()
    expect(consentOps(f.main).filter(([b]) => !(b as { enabled?: boolean }).enabled)).toHaveLength(0)
    expect(f.store.snapshot().lifelogConsent?.id).toBe('grant-1')
  } finally { await f.app.systemExit() }
})

it.each(['pause', 'background', 'consent'])('cancels lifelog recovery on %s', async action => {
  vi.useFakeTimers()
  const f = await lifelogFixture()
  try {
    f.callbacks().error(new SpeechStreamError('Queue stale', 'audio_backlog', true))
    await vi.advanceTimersByTimeAsync(0)
    if (action === 'pause') await f.app.pauseLifelog()
    if (action === 'background') f.app.setForeground(false)
    if (action === 'consent') await f.app.configureRecordingConsent(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.audio.start).toHaveBeenCalledOnce(); expect(f.app.proactive.capturing).toBe(false)
    expect(f.app.proactive.memoryActive).toBe(action !== 'consent')
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it('pause while a recovery connection is opening cannot restart the microphone later', async () => {
  vi.useFakeTimers()
  const f = await lifelogFixture()
  let opened!: () => void
  try {
    f.speech.open.mockImplementationOnce(() => new Promise<void>(resolve => { opened = resolve }))
    f.callbacks().error(new SpeechStreamError('Queue stale', 'audio_backlog', true))
    await vi.advanceTimersByTimeAsync(1000)
    expect(opened).toBeTypeOf('function')
    await f.app.pauseLifelog()
    opened(); await vi.advanceTimersByTimeAsync(5000)
    expect(f.app.proactive.capturing).toBe(false)
    expect(f.store.snapshot().homeMode).toBe('lifelog')
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it('a stream error waits locally and the next glasses gesture resumes with the same grant', async () => {
  vi.useFakeTimers()
  const f = await lifelogFixture()
  try {
    f.callbacks().error(new Error('Speech disconnected'))
    await vi.advanceTimersByTimeAsync(1)
    expect(f.app.proactive.capturing).toBe(false)
    expect(f.renderer.message).toHaveBeenLastCalledWith('Microphone stopped', expect.stringContaining('next glasses gesture'))
    f.app.glassesInput(); f.app.tap()
    await vi.advanceTimersByTimeAsync(500)
    expect(f.audio.start).toHaveBeenCalledTimes(2); expect(f.app.proactive.capturing).toBe(true)
    expect(consentOps(f.main)).toHaveLength(1)
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it('retains text when native microphone release fails, and discarding never sends it', async () => {
  const f = await fixture()
  try {
    await f.app.startAsk(); f.speech.snapshotText.mockReturnValue('Already transcribed')
    f.audio.stop.mockRejectedValueOnce(new Error('Microphone release failed'))
    await f.app.finishAsk()
    expect(f.phone.draft).toHaveBeenLastCalledWith('Already transcribed', 'speech')
    await f.app.discardDraft(); expect(f.api.askText).not.toHaveBeenCalled()
  } finally { await f.app.systemExit() }
})

it('keeps a failed text send with a duplicate-action warning and never retries automatically', async () => {
  const f = await fixture()
  try {
    await f.app.configureAutoSend(true); await f.app.startAsk()
    f.api.askText.mockRejectedValueOnce(new Error('Failed to fetch'))
    await f.app.finishAsk()
    expect(f.api.askText).toHaveBeenCalledOnce()
    expect(f.phone.draft).toHaveBeenLastCalledWith('What time is it?', 'delivery')
    expect(f.phone.set).toHaveBeenLastCalledWith('Delivery uncertain · question retained', expect.stringContaining('actions could run twice'))
    await f.app.sendDraft(); expect(f.api.askText).toHaveBeenCalledTimes(2)
  } finally { await f.app.systemExit() }
})

it('recovers the original long inbox question and preserves its target on explicit retry', async () => {
  const f = await fixture()
  try {
    const target = { id: 'task:original', title: 'Original item', summary: '', category: 'tasks', action: '', seen: false, important: true }
    f.app.proactive.items = [target]; f.app.openInbox()
    await f.app.configureAutoSend(true); await f.app.startAsk()
    const question = 'q'.repeat(4000)
    f.speech.finish.mockResolvedValueOnce(question)
    f.api.askText.mockRejectedValueOnce(new Error('Failed to fetch'))
    await f.app.finishAsk()
    expect(f.phone.draft).toHaveBeenLastCalledWith(question, 'delivery')
    f.app.proactive.items = [{ ...target, id: 'task:other', title: 'Other item' }]
    await f.app.sendDraft()
    expect(f.api.askText).toHaveBeenCalledTimes(2)
    const first = f.api.askText.mock.calls[0][0]
    expect(first).toContain('task:original')
    expect(first).toContain(question)
    expect(f.api.askText.mock.calls[1][0]).toBe(first)
  } finally { await f.app.systemExit() }
})

it('keeps the completed answer when local history fails, without offering a resend', async () => {
  const f = await fixture()
  try {
    await f.app.configureAutoSend(true); await f.app.startAsk()
    f.api.askText.mockImplementationOnce((_text, _conversation, progress) => {
      progress({ type: 'delta', text: 'Earlier partial words' })
      return Promise.resolve({ question: 'What time is it?', reply: 'Completed answer', sessionId: 'fixture-session' })
    })
    vi.spyOn(f.store, 'remember').mockRejectedValueOnce(new Error('Native storage unavailable'))
    await f.app.finishAsk()
    expect(f.renderer.answer).toHaveBeenLastCalledWith('Completed answer', 0, 1)
    expect(f.renderer.review).not.toHaveBeenCalled()
    expect(f.phone.set).toHaveBeenLastCalledWith('Answer received · local update failed', expect.stringContaining('already completed'))
    await f.app.sendDraft()
    expect(f.api.askText).toHaveBeenCalledOnce()
  } finally { await f.app.systemExit() }
})

it.each([false, true])('keeps a partial answer visible without a resend draft (history failure=%s)', async historyFailure => {
  const f = await fixture()
  try {
    await f.app.configureAutoSend(true); await f.app.startAsk()
    f.api.askText.mockImplementationOnce((_text, _conversation, progress) => {
      progress({ type: 'delta', text: 'Partial response received' })
      return Promise.reject(new Error('Stream interrupted'))
    })
    if (historyFailure) vi.spyOn(f.store, 'remember').mockRejectedValueOnce(new Error('Native storage unavailable'))
    await f.app.finishAsk()
    expect(f.renderer.answer).toHaveBeenLastCalledWith('Incomplete answer: Partial response received', 0, 1)
    expect(f.renderer.review).not.toHaveBeenCalled()
    if (!historyFailure) expect(f.store.snapshot().history.at(-1)?.reply).toBe('Incomplete answer:\nPartial response received')
    await f.app.sendDraft()
    f.app.tap(); await vi.waitFor(() => expect(f.audio.start).toHaveBeenCalledTimes(2))
    expect(f.api.askText).toHaveBeenCalledOnce() // Tap starts a new recording, not a resend.
  } finally { await f.app.systemExit() }
})

it('auto-sends finalized live text once after Stop when enabled', async () => {
  const f = await fixture()
  try {
    await f.app.configureAutoSend(true)
    await f.app.startAsk()
    f.callbacks().transcript('What time', false, 0)
    expect(f.api.askText).not.toHaveBeenCalled()
    await f.app.finishAsk()
    expect(f.api.askText).toHaveBeenCalledOnce()
    await f.app.sendDraft()
    expect(f.api.askText).toHaveBeenCalledOnce()
    expect(f.api.ask).not.toHaveBeenCalled()
  } finally { await f.app.systemExit() }
})

it('browses all 80 inbox items with swipes and returns from details to the same item', async () => {
  const f = await fixture()
  try {
    f.app.proactive.items = Array.from({ length: 80 }, (_, i) => ({ id: String(i), title: `Task ${i}`, summary: 'Details', category: 'tasks', action: 'review-on-main', seen: false, important: false }))
    f.app.openInbox()
    for (let i = 1; i < 80; i++) f.app.scrollUp()
    expect(f.renderer.inboxList).toHaveBeenLastCalledWith('Task 79', 80, 80)
    f.app.scrollUp(); expect(f.renderer.inboxList).toHaveBeenLastCalledWith('Task 79', 80, 80)
    f.app.tap(); expect(f.renderer.inbox).toHaveBeenCalled()
    f.app.doubleTap(); expect(f.renderer.inboxList).toHaveBeenLastCalledWith('Task 79', 80, 80)
    f.app.scrollDown(); expect(f.renderer.inboxList).toHaveBeenLastCalledWith('Task 78', 79, 80)
  } finally { await f.app.systemExit() }
})

it('supervisor home opens the supervisor questions and answers with a fixed choice', async () => {
  vi.useFakeTimers()
  const f = await fixture()
  try {
    const answer = vi.spyOn(f.app.proactive, 'answer').mockResolvedValue({ ok: true, detail: 'typed into Conductor' })
    const configure = vi.spyOn(f.app.proactive, 'configure').mockResolvedValue()
    Object.assign(f.renderer, { supervisorHome: vi.fn() })
    const question = { id: 'o-fleet', title: '#7 ready. Merge?', summary: 'CI green', category: 'approvals', action: 'answer-fleet', seen: false, important: true, supervisor: true, options: ['merged', 'later'] }
    f.app.proactive.items = [{ id: 'mail', title: 'Invoice', summary: '', category: 'email', action: 'review-on-main', seen: false, important: false }, question]
    // Taps closer than 400 ms apart are ignored as bounces.
    const tap = async () => { f.app.tap(); await vi.advanceTimersByTimeAsync(500) }
    await f.app.configureHomeMode('supervisor')
    expect(configure).toHaveBeenCalledWith({ supervisorOnly: true })
    expect(f.store.snapshot().homeMode).toBe('supervisor')
    // Tap at home: only supervisor items, not a new question.
    await tap()
    expect(f.renderer.inboxList).toHaveBeenLastCalledWith('#7 ready. Merge?', 1, 1)
    expect(f.api.askText).not.toHaveBeenCalled()
    await tap(); await tap()
    expect(f.renderer.inboxAction).toHaveBeenLastCalledWith('Answer: merged', '#7 ready. Merge?', false)
    // Like the inbox list, swipe up moves forward through the choices.
    f.app.scrollDown()
    expect(f.renderer.inboxAction).toHaveBeenLastCalledWith('Answer: merged', '#7 ready. Merge?', false)
    f.app.scrollUp()
    expect(f.renderer.inboxAction).toHaveBeenLastCalledWith('Answer: later', '#7 ready. Merge?', false)
    f.app.scrollDown()
    // Confirm, then send.
    await tap(); expect(f.renderer.inboxAction).toHaveBeenLastCalledWith('Answer: merged', '#7 ready. Merge?', true)
    await tap()
    expect(answer).toHaveBeenCalledWith('o-fleet', 'merged')
    expect(f.renderer.message).toHaveBeenLastCalledWith('Answered', 'merged. typed into Conductor')
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it('keeps Supervisor home through inbox refreshes and shows status on its own page', async () => {
  const f = await fixture()
  try {
    vi.spyOn(f.app.proactive, 'configure').mockResolvedValue()
    Object.assign(f.renderer, { supervisorHome: vi.fn(), fleetStatus: vi.fn() })
    await f.app.configureHomeMode('supervisor')
    f.renderer.home.mockClear()
    const view = (f.app.proactive as unknown as { view: { inbox: (items: unknown[]) => void } }).view
    view.inbox([{ id: 'q', title: 'Merge?', summary: '', category: 'approvals', action: 'answer-fleet', seen: false, important: true, supervisor: true, options: ['yes'] }])
    expect(f.renderer.home).not.toHaveBeenCalled()
    expect((f.renderer as unknown as { supervisorHome: ReturnType<typeof vi.fn> }).supervisorHome).toHaveBeenLastCalledWith(1)
    const status = { mode: 'auto', lastTickAt: null, needsYou: 1, counts: { red: 1, yellow: 0, green: 2, gray: 0 }, threads: [{ name: 'apia', health: 'red', state: 'needs-human', reason: 'asks' }] }
    // A slow status reply after the user moved on is dropped.
    let release: (value: typeof status) => void = () => {}
    vi.spyOn(f.app.proactive, 'fleetStatus').mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const showStatus = (f.app as unknown as { showFleetStatus: () => Promise<void> }).showFleetStatus.bind(f.app)
    const pending = showStatus()
    f.app.proactive.items = [{ id: 'q', title: 'Merge?', summary: '', category: 'approvals', action: 'answer-fleet', seen: false, important: true, supervisor: true, options: ['yes'] }]
    f.app.openInbox(undefined, true)
    release(status); await pending
    const fleetStatus = (f.renderer as unknown as { fleetStatus: ReturnType<typeof vi.fn> }).fleetStatus
    expect(fleetStatus).not.toHaveBeenCalled()
    expect(f.renderer.inboxList).toHaveBeenLastCalledWith('Merge?', 1, 1)
    // From home it renders on the status page, not the Agent answer page.
    f.app.doubleTap()
    vi.spyOn(f.app.proactive, 'fleetStatus').mockResolvedValueOnce(status)
    f.renderer.answer.mockClear()
    await showStatus()
    expect(fleetStatus).toHaveBeenCalledWith(expect.stringContaining('1 red'), 0, 1)
    expect(f.renderer.answer).not.toHaveBeenCalled()
  } finally { await f.app.systemExit() }
})

it('reapplies Supervisor mode to a main that does not have it yet', async () => {
  const f = await fixture()
  try {
    const configure = vi.spyOn(f.app.proactive, 'configure').mockResolvedValue()
    const view = (f.app.proactive as unknown as { view: { proactiveSettings: (s: Record<string, unknown>) => void } }).view
    const settings = { enabled: false, categories: [], retentionDays: 1, quietStart: 22, quietEnd: 8, timeZone: 'UTC', maxPerHour: 3 }
    view.proactiveSettings({ ...settings, supervisorOnly: false })
    expect(configure).not.toHaveBeenCalled()
    await f.store.update({ homeMode: 'supervisor' })
    view.proactiveSettings({ ...settings, supervisorOnly: false })
    expect(configure).toHaveBeenCalledWith({ supervisorOnly: true })
    configure.mockClear()
    view.proactiveSettings({ ...settings, supervisorOnly: true })
    expect(configure).not.toHaveBeenCalled()
  } finally { await f.app.systemExit() }
})

it('freezes the selected voice task and requires confirmation even with auto-send', async () => {
  vi.useFakeTimers()
  const f = await fixture()
  try {
    const action = vi.spyOn(f.app.proactive, 'action').mockResolvedValue(true)
    await f.app.configureAutoSend(true)
    const target = { id: 'due:one:date', title: 'Send proposal', taskId: 'one', dueDate: 'date', summary: 'Due', category: 'tasks', action: 'complete-task', seen: false, important: true }
    f.app.proactive.items = [target]; f.app.openInbox(); await f.app.startAsk()
    f.app.proactive.items = [{ ...target, id: 'other', title: 'Do not complete this' }]
    f.speech.finish.mockResolvedValue("This one's done")
    await f.app.finishAsk()
    expect(f.api.askText).not.toHaveBeenCalled()
    expect(action).not.toHaveBeenCalledWith('complete-task', expect.anything(), expect.anything())
    expect(f.renderer.inboxAction).toHaveBeenLastCalledWith('Complete task on main', 'Send proposal', true)
    f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    expect(action).toHaveBeenCalledWith('complete-task', target.id, { title: target.title, taskId: 'one', dueDate: 'date' })
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it('transient notices return to idle, but cannot overwrite a new question', async () => {
  vi.useFakeTimers()
  const f = await fixture()
  try {
    const item = { id: 'candidate', title: 'Send proposal', summary: '', category: 'memory', action: 'accept-task', seen: false, important: true }
    const app = f.app as unknown as { showNotice(value: typeof item): void }
    app.showNotice(item)
    expect(f.renderer.notice).toHaveBeenLastCalledWith('Action identified', 'Send proposal')
    f.renderer.home.mockClear(); await vi.advanceTimersByTimeAsync(4500)
    expect(f.renderer.home).toHaveBeenCalledOnce()
    app.showNotice(item); await f.app.startAsk(); f.renderer.home.mockClear()
    await vi.advanceTimersByTimeAsync(4500)
    expect(f.renderer.home).not.toHaveBeenCalled()
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it('recovers manual live capture after leaving and returning to the foreground', async () => {
  const f = await fixture()
  try {
    await f.app.startAsk(); f.app.setForeground(false); await Promise.resolve(); f.app.setForeground(true)
    await f.app.startAsk()
    expect(f.audio.start).toHaveBeenCalledTimes(2)
    await f.app.finishAsk(); await f.app.sendDraft(); expect(f.api.askText).toHaveBeenCalledOnce()
  } finally { await f.app.systemExit() }
})

it('safely discards buffered Stop when backgrounding clears the recording', async () => {
  const f = await fixture()
  try {
    await f.app.configureSpeech('openai-buffered'); await f.app.startAsk()
    f.receive(new Uint8Array(6400))
    let stopped!: () => void
    f.audio.stop.mockImplementationOnce(() => new Promise<void>(resolve => { stopped = resolve }))
    const finishing = f.app.finishAsk()
    f.app.setForeground(false); stopped(); await expect(finishing).resolves.toBeUndefined()
    expect(f.api.listen).not.toHaveBeenCalled(); expect(f.api.ask).not.toHaveBeenCalled()
    f.app.setForeground(true); await f.app.startAsk()
    expect(f.audio.start).toHaveBeenCalledTimes(2)
  } finally { await f.app.systemExit() }
})

it('recovers lifelog with fresh speech and existing consent, without replaying a question', async () => {
  vi.useFakeTimers()
  const f = await lifelogFixture()
  try {
    const old = f.callbacks(), enable = vi.spyOn(f.app.proactive, 'grantMemory')
    old.error(new SpeechStreamError('Queue stale', 'audio_backlog', true))
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.audio.start).toHaveBeenCalledTimes(2); expect(enable).not.toHaveBeenCalled()
    expect(f.app.proactive.capturing).toBe(true); expect(f.main.state.grants).toBe(1)
    expect(f.phone.activity).toHaveBeenCalledWith(expect.stringContaining('Audio gap'))
    old.utterance('Peri send an email'); expect(f.api.askText).not.toHaveBeenCalled()
    f.callbacks().utterance('Peri incomplete tail'); expect(f.api.askText).not.toHaveBeenCalled()
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it('stops after three recovery attempts per minute, keeping consent for the next gesture', async () => {
  vi.useFakeTimers()
  const f = await lifelogFixture()
  try {
    for (const delay of [1000, 2000, 4000]) {
      f.callbacks().error(new SpeechStreamError('Queue stale', 'audio_backlog', true))
      await vi.advanceTimersByTimeAsync(delay)
    }
    expect(f.audio.start).toHaveBeenCalledTimes(4)
    f.callbacks().error(new SpeechStreamError('Queue stale', 'audio_backlog', true))
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.audio.start).toHaveBeenCalledTimes(4); expect(f.app.proactive.capturing).toBe(false)
    expect(f.app.proactive.memoryActive).toBe(true)
    expect(f.renderer.message).toHaveBeenLastCalledWith('Microphone stopped', expect.stringContaining('consent stays on'))
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it('never retries malformed audio or auto-sends an interrupted manual question', async () => {
  vi.useFakeTimers()
  const f = await lifelogFixture()
  try {
    f.callbacks().error(new SpeechStreamError('Invalid PCM', 'invalid_pcm'))
    await vi.advanceTimersByTimeAsync(5000); expect(f.audio.start).toHaveBeenCalledOnce()
    await f.app.configureAutoSend(true); await f.app.startAsk()
    f.callbacks().transcript('A partial question', false, 0)
    f.callbacks().error(new SpeechStreamError('Queue stale', 'audio_backlog', true))
    await vi.advanceTimersByTimeAsync(5000); await f.app.finishAsk()
    expect(f.api.askText).not.toHaveBeenCalled(); expect(f.api.ask).not.toHaveBeenCalled()
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it('streams packets before Stop, then reviews without sending until confirmed', async () => {
  const f = await fixture(); await f.app.startAsk()
  expect(f.api.speechToken).not.toHaveBeenCalled()
  expect(f.speech.open).toHaveBeenCalledWith('saved-scoped-token-123', 'nova-3', 'open agi', expect.stringContaining('wss://main.example.com/nodes/g2/speech'))
  f.receive(new Uint8Array(640)); f.callbacks().transcript('What time', false, 100)
  expect(f.speech.push).toHaveBeenCalledOnce(); expect(f.api.askText).not.toHaveBeenCalled()
  expect(f.phone.transcript).toHaveBeenCalledWith('What time')
  await f.app.finishAsk()
  expect(f.api.askText).not.toHaveBeenCalled()
  await f.app.sendDraft()
  await f.app.sendDraft()
  expect(f.api.askText).toHaveBeenCalledOnce()
  expect(f.api.askText).toHaveBeenCalledWith('What time is it?', f.store.snapshot().conversationId, expect.any(Function), expect.any(AbortSignal), 'agent')
  expect(f.api.ask).not.toHaveBeenCalled(); expect(f.api.listen).not.toHaveBeenCalled()
  expect(JSON.stringify(f.storage.set.mock.calls)).not.toContain('short-lived-token')
  await f.app.systemExit()
})

it('keeps enrollment on grant failure, never opens the microphone and permits explicit buffered fallback', async () => {
  const f = await fixture(); await f.app.configureSpeech('nova-3', 'direct'); f.api.speechToken.mockRejectedValueOnce(new Error('Deepgram needs Member access'))
  await f.app.startAsk()
  expect(f.audio.start).not.toHaveBeenCalled(); expect(f.speech.close).toHaveBeenCalled()
  expect(f.store.snapshot().nodeToken).toBe('saved-scoped-token-123')
  await f.app.configureSpeech('openai-buffered')
  expect(f.store.snapshot().speechModel).toBe('openai-buffered')
  expect(f.store.snapshot().nodeToken).toBe('saved-scoped-token-123')
  await f.app.systemExit()
})

it('discards live capture on Back and wakes a blank display without exiting or changing pairing', async () => {
  const f = await fixture(); await f.app.startAsk(); f.app.doubleTap()
  await Promise.resolve(); await Promise.resolve()
  expect(f.speech.close).toHaveBeenCalled(); expect(f.api.askText).not.toHaveBeenCalled()
  f.app.toggleDisplay(); f.app.tap(); f.app.doubleTap()
  expect(f.renderer.sleep.mock.calls).toEqual([[true], [false]])
  expect(f.renderer.requestExit).toHaveBeenCalledOnce()
  expect(f.store.snapshot().nodeToken).toBe('saved-scoped-token-123')
  await f.app.systemExit()
})

it('tap on a completed answer records a follow-up in that conversation and keeps history', async () => {
  const f = await fixture()
  try {
    await f.app.startAsk(); await f.app.finishAsk(); await f.app.sendDraft()
    const conversationId = f.store.snapshot().conversationId
    const previous = f.store.snapshot().history[0]
    f.app.tap()
    await vi.waitFor(() => expect(f.audio.start).toHaveBeenCalledTimes(2))
    expect(f.store.snapshot().history[0]).toEqual(previous)
    await f.app.finishAsk()
    await f.app.sendDraft()
    expect(f.api.askText).toHaveBeenLastCalledWith('What time is it?', conversationId, expect.any(Function), expect.any(AbortSignal), 'agent')
    expect(f.store.snapshot().history).toHaveLength(2)
  } finally { await f.app.systemExit() }
})

it('tap on a reopened recent answer follows that original thread, not a newer one', async () => {
  const f = await fixture()
  try {
    await f.app.startAsk(); await f.app.finishAsk(); await f.app.sendDraft()
    const original = f.store.snapshot().conversationId
    await f.app.newConversation()
    expect(f.store.snapshot().conversationId).not.toBe(original)
    await f.app.selectAnswer(0)
    f.app.tap()
    await vi.waitFor(() => expect(f.audio.start).toHaveBeenCalledTimes(2))
    await f.app.finishAsk()
    await f.app.sendDraft()
    expect(f.api.askText).toHaveBeenLastCalledWith('What time is it?', original, expect.any(Function), expect.any(AbortSignal), 'agent')
  } finally { await f.app.systemExit() }
})
