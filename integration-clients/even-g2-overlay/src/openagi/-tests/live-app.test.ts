import { expect, it, vi } from 'vitest'
import { OpenAGIG2App } from '../../app/openagi-g2-app'
import { OpenAGIStore } from '../store'
import type { LiveSpeech, SpeechCallbacks } from '../live-speech'

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

async function fixture(initial: { ambientEnabled?: boolean } = {}) {
  const storage = { get: vi.fn(() => Promise.resolve(null as string | null)), set: vi.fn(() => Promise.resolve()), remove: vi.fn(() => Promise.resolve()) }
  const store = new OpenAGIStore(storage)
  await store.update({ autoSend: false, ...initial })
  await store.update({ nodeToken: 'saved-scoped-token-123', connectionMode: 'direct', agentOrigin: 'https://main.example.com', conversationId: crypto.randomUUID(), speechModel: 'nova-3' })
  let receive: (pcm: Uint8Array) => void = () => {}
  let callbacks!: SpeechCallbacks
  const audio = { active: true, start: vi.fn((cb: typeof receive) => { receive = cb; return Promise.resolve() }), stop: vi.fn(() => Promise.resolve()) }
  const speech = { open: vi.fn(() => Promise.resolve()), push: vi.fn(), close: vi.fn(), finish: vi.fn(() => Promise.resolve('What time is it?')) }
  const api = { speechRelay: vi.fn(() => ({ url: 'wss://main.example.com/nodes/g2/speech?model=nova-3', token: 'saved-scoped-token-123' })), speechToken: vi.fn(() => Promise.resolve({ accessToken: 'short-lived-token', expiresIn: 30 })), askText: vi.fn(() => Promise.resolve({ question: 'What time is it?', reply: 'Noon' })), ask: vi.fn(), listen: vi.fn() }
  const renderer = { paused: vi.fn(), inboxList: vi.fn(), inbox: vi.fn(), inboxAction: vi.fn(), notice: vi.fn(), home: vi.fn(), passive: vi.fn(), ambient: vi.fn(), listening: vi.fn(), transcript: vi.fn(), progress: vi.fn(), answer: vi.fn(), message: vi.fn(), sleep: vi.fn() }
  const phone = { set: vi.fn(), paired: vi.fn(), ambient: vi.fn(), transcript: vi.fn(), speechModel: vi.fn(), activity: vi.fn() }
  type Args = ConstructorParameters<typeof OpenAGIG2App>
  const app = new OpenAGIG2App(api as unknown as Args[0], store, audio, renderer as unknown as Args[3], phone as unknown as Args[4], [], cb => { callbacks = cb; return speech as unknown as LiveSpeech })
  await app.boot()
  return { app, api, audio, renderer, phone, speech, store, storage, receive: (pcm: Uint8Array) => receive(pcm), callbacks: () => callbacks }
}

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

it('rolls back auto-started listening when retention consent fails', async () => {
  const f = await fixture()
  Object.assign(f.api, { proactive: vi.fn(async (body: { op: string }) => { if (body.op === 'consent') throw new Error('consent denied'); return { items: [] } }) })
  try {
    await f.app.configureMemory(true, true)
    expect(f.app.proactive.memoryActive).toBe(false); expect(f.store.snapshot().ambientEnabled).toBe(false)
    expect(f.audio.stop).toHaveBeenCalled(); expect(f.speech.close).toHaveBeenCalled()
  } finally { await f.app.systemExit() }
})

it('drops a passive buffered transcription after wake opt-in', async () => {
  const f = await fixture()
  try {
    await f.app.configureSpeech('openai-buffered'); await f.app.configureAmbient(true, 'Peri', true)
    let resolve!: (value: unknown) => void
    f.api.listen.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const frame = (n: number) => new Uint8Array(new Int16Array(1600).fill(n).buffer)
    for (let i = 0; i < 4; i++) f.receive(frame(2000))
    for (let i = 0; i < 8; i++) f.receive(frame(0))
    await f.app.configureListeningMode('wake')
    resolve({ question: 'Peri send it', triggered: true, prompt: 'send it' }); await Promise.resolve(); await Promise.resolve()
    expect(f.api.askText).not.toHaveBeenCalled()
  } finally { await f.app.systemExit() }
})

it('drops the old live utterance after wake opt-in', async () => {
  const f = await fixture()
  try {
    await f.app.configureAmbient(true, 'Peri', true)
    const previous = f.callbacks()
    // The factory must return a distinct transport for a restarted session.
    const app = f.app as unknown as { speechFactory: (cb: SpeechCallbacks) => LiveSpeech }
    app.speechFactory = () => ({ ...f.speech }) as unknown as LiveSpeech
    await f.app.configureListeningMode('wake'); previous.utterance('Peri send it')
    expect(f.api.askText).not.toHaveBeenCalled()
  } finally { await f.app.systemExit() }
})

it('opening a recent answer preserves active lifelog consent and microphone', async () => {
  const f = await fixture()
  Object.assign(f.api, { proactive: vi.fn(async (b: { op: string; enabled?: boolean }) => b.op === 'consent' && b.enabled ? { consent: { id: 'retention', until: Date.now() + 60000 } } : { items: [] }) })
  try {
    await f.store.remember('Earlier question', 'Earlier answer'); await f.app.configureMemory(true, true)
    f.audio.stop.mockClear(); await f.app.selectAnswer(0)
    expect(f.audio.stop).not.toHaveBeenCalled(); expect(f.app.proactive.memoryActive).toBe(true)
    f.app.doubleTap(); await Promise.resolve(); expect(f.renderer.passive).toHaveBeenLastCalledWith(true, false, 'open agi')
  } finally { await f.app.systemExit() }
})

it('resumes paused lifelog on glasses only after explicit participant consent', async () => {
  vi.useFakeTimers()
  const f = await fixture()
  const proactive = vi.fn(async (b: { op: string; enabled?: boolean }) => b.op === 'consent' && b.enabled ? { consent: { id: 'retention', until: Date.now() + 60000 } } : { items: [] })
  Object.assign(f.api, { proactive })
  try {
    await f.app.configureMemory(true, true)
    f.app.doubleTap(); await vi.advanceTimersByTimeAsync(500)
    expect(f.renderer.paused).toHaveBeenLastCalledWith(true)
    expect(f.app.proactive.memoryActive).toBe(false)
    f.audio.start.mockClear(); proactive.mockClear()
    f.app.tap()
    expect(f.renderer.paused).toHaveBeenLastCalledWith(true, true)
    expect(f.audio.start).not.toHaveBeenCalled()
    f.app.doubleTap(); await vi.advanceTimersByTimeAsync(500)
    expect(f.renderer.paused).toHaveBeenLastCalledWith(true)
    expect(proactive.mock.calls.some(([b]) => b.op === 'consent' && b.enabled)).toBe(false)
    f.app.tap(); await vi.advanceTimersByTimeAsync(500); f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    expect(f.audio.start).toHaveBeenCalledOnce()
    expect(f.app.proactive.memoryActive).toBe(true)
    expect(f.renderer.passive).toHaveBeenLastCalledWith(true, false, 'open agi')
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it('phone return to active lifelog leaves the consent and microphone intact', async () => {
  const f = await fixture()
  const proactive = vi.fn(async (b: { op: string; enabled?: boolean }) => b.op === 'consent' && b.enabled ? { consent: { id: 'retention', until: Date.now() + 60000 } } : { items: [] })
  Object.assign(f.api, { proactive })
  try {
    await f.store.remember('Earlier question', 'Earlier answer'); await f.app.configureMemory(true, true)
    await f.app.selectAnswer(0); f.audio.start.mockClear(); proactive.mockClear()
    await f.app.returnToLifelog(false)
    expect(f.renderer.passive).toHaveBeenLastCalledWith(true, false, 'open agi')
    expect(f.audio.start).not.toHaveBeenCalled()
    expect(proactive.mock.calls.some(([b]) => b.op === 'consent')).toBe(false)
  } finally { await f.app.systemExit() }
})

it('does not revive retention after backgrounding without a new confirmation', async () => {
  const f = await fixture()
  Object.assign(f.api, { proactive: vi.fn(async (b: { op: string; enabled?: boolean }) => b.op === 'consent' && b.enabled ? { consent: { id: 'retention', until: Date.now() + 60000 } } : { items: [] }) })
  try {
    await f.app.configureMemory(true, true)
    f.app.setForeground(false); await Promise.resolve(); f.app.setForeground(true)
    expect(f.renderer.paused).toHaveBeenLastCalledWith(true)
    await f.app.configureMemory(true, false)
    expect(f.app.proactive.memoryActive).toBe(false)
    expect(f.audio.start).toHaveBeenCalledOnce()
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

async function lifelogHoldFixture() {
  const f = await fixture()
  Object.assign(f.api, { proactive: vi.fn(async (b: { op: string; enabled?: boolean }) => b.op === 'consent' && b.enabled ? { consent: { id: 'retention', until: Date.now() + 60000 } } : { items: [] }) })
  await f.app.configureMemory(true, true); await f.app.configureLifelogTalkMode('hold')
  return f
}

it.each([true, false])('hold ignores quick taps and release respects auto-send=%s', async autoSend => {
  const f = await lifelogHoldFixture()
  try {
    await f.app.configureAutoSend(autoSend)
    f.audio.start.mockClear(); f.app.tap(); await Promise.resolve()
    expect(f.audio.start).not.toHaveBeenCalled()
    await f.app.holdStart(); f.app.tap()
    expect(f.api.askText).not.toHaveBeenCalled()
    await f.app.holdRelease()
    expect(f.api.askText).toHaveBeenCalledTimes(autoSend ? 1 : 0)
    if (!autoSend) { await f.app.sendDraft(); expect(f.api.askText).toHaveBeenCalledOnce() }
    await f.app.holdRelease(); expect(f.api.askText).toHaveBeenCalledOnce()
    expect(f.app.proactive.memoryActive).toBe(true)
  } finally { await f.app.systemExit() }
})

it('release during microphone setup cancels instead of sending later', async () => {
  const f = await lifelogHoldFixture()
  let opened!: () => void
  try {
    await f.app.configureAutoSend(true)
    f.speech.open.mockImplementationOnce(() => new Promise<void>(resolve => { opened = resolve }))
    const starting = f.app.holdStart()
    await vi.waitFor(() => expect(opened).toBeTypeOf('function'))
    await f.app.holdRelease(); opened(); await starting
    expect(f.api.askText).not.toHaveBeenCalled(); expect(f.speech.finish).not.toHaveBeenCalled()
    expect(f.app.proactive.memoryActive).toBe(true)
    await f.app.holdStart(); await f.app.holdRelease()
    expect(f.api.askText).toHaveBeenCalledOnce()
  } finally { await f.app.systemExit() }
})

it('hold release also sends buffered audio once', async () => {
  const f = await lifelogHoldFixture()
  try {
    await f.app.configureSpeech('openai-buffered'); await f.app.configureMemory(true, true)
    await f.app.configureAutoSend(true)
    f.api.ask.mockResolvedValue({ question: 'Buffered question', reply: 'Answer' })
    await f.app.holdStart(); f.receive(new Uint8Array(6400))
    expect(f.api.ask).not.toHaveBeenCalled()
    await f.app.holdRelease(); await f.app.holdRelease()
    expect(f.api.ask).toHaveBeenCalledOnce()
    expect(f.app.proactive.memoryActive).toBe(true)
  } finally { await f.app.systemExit() }
})

it('missing release times out without sending and foreground loss never sends', async () => {
  vi.useFakeTimers()
  const f = await lifelogHoldFixture()
  try {
    await f.app.configureAutoSend(true); await f.app.holdStart()
    await vi.advanceTimersByTimeAsync(30000)
    expect(f.api.askText).not.toHaveBeenCalled()
    await f.app.holdRelease(); expect(f.api.askText).not.toHaveBeenCalled()
    await f.app.holdStart(); f.app.setForeground(false); await f.app.holdRelease()
    expect(f.api.askText).not.toHaveBeenCalled()
    expect(f.app.proactive.memoryActive).toBe(false)
    f.app.setForeground(true); await f.app.configureMemory(true, true)
    await f.app.holdStart(); await f.app.holdRelease()
    expect(f.api.askText).toHaveBeenCalledOnce()
  } finally { await f.app.systemExit(); vi.useRealTimers() }
})

it('lifelog hold preference persists and does not reset pairing', async () => {
  const f = await fixture()
  try {
    await f.app.configureLifelogTalkMode('hold')
    const saved = f.storage.set.mock.calls.at(-1) as unknown as [string, string]
    const reloaded = new OpenAGIStore({ get: async () => saved[1], set: async () => {}, remove: async () => {} })
    const state = await reloaded.load()
    expect(state.lifelogTalkMode).toBe('hold'); expect(state.nodeToken).toBe(f.store.snapshot().nodeToken)
    await reloaded.clearCredential(); expect(reloaded.snapshot().lifelogTalkMode).toBe('hold')
  } finally { await f.app.systemExit() }
})

it('renders paired home when boot happens while hidden without starting capture', async () => {
  const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  const f = await fixture({ ambientEnabled: true })
  try { expect(f.renderer.home).toHaveBeenCalled(); expect(f.phone.paired).toHaveBeenCalledWith(true); expect(f.audio.start).not.toHaveBeenCalled() }
  finally { hidden.mockRestore(); await f.app.systemExit() }
})

it.each(['live', 'buffered'])('resumes ambient listening after failed manual %s setup', async transport => {
  const f = await fixture()
  try {
    if (transport === 'buffered') await f.app.configureSpeech('openai-buffered')
    await f.app.configureAmbient(true, 'Peri', false)
    f.audio.start.mockRejectedValueOnce(new Error('temporary microphone failure'))
    await f.app.startAsk()
    expect(f.audio.start).toHaveBeenCalledTimes(3)
    expect(f.renderer.passive).toHaveBeenLastCalledWith(false, false, 'Peri')
  } finally { await f.app.systemExit() }
})

it('returns from inbox to listening, redraws new counts, and preserves services on invalid agent input', async () => {
  const f = await fixture()
  const stop = vi.spyOn(f.app.proactive, 'stop')
  await f.app.connectAgent('not an origin', 'invalid')
  expect(stop).not.toHaveBeenCalled()
  await f.app.configureAmbient(true, 'Peri', false)
  f.app.proactive.items = [{ id: 'one', title: 'Test', summary: 'Update', important: false, seen: false, category: 'discoveries', action: 'review-on-main' }]
  f.app.openInbox(); f.app.doubleTap()
  await Promise.resolve()
  expect(f.store.snapshot().ambientEnabled).toBe(true)
  expect(f.renderer.passive).toHaveBeenLastCalledWith(false, false, 'Peri')
  await f.app.systemExit()
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
  expect(f.api.askText).toHaveBeenCalledWith('What time is it?', f.store.snapshot().conversationId, expect.any(Function), expect.any(AbortSignal))
  expect(f.api.ask).not.toHaveBeenCalled(); expect(f.api.listen).not.toHaveBeenCalled()
  expect(JSON.stringify(f.storage.set.mock.calls)).not.toContain('short-lived-token')
  await f.app.systemExit()
})

it('triggers once from finalized wake speech, keeps interim words live during agent work and drops extra triggers', async () => {
  const f = await fixture()
  await f.app.configureListeningMode('wake')
  let complete!: (value: { question: string; reply: string }) => void
  f.api.askText.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  await f.app.configureAmbient(true, 'Peri', false)
  f.callbacks().transcript('Peri what time', false, 50)
  expect(f.api.askText).not.toHaveBeenCalled()
  f.callbacks().utterance('Peri'); f.callbacks().utterance('What time is it?')
  expect(f.api.askText).toHaveBeenCalledOnce()
  f.callbacks().transcript('More speech', false, 30); f.callbacks().utterance('Peri do another thing')
  expect(f.phone.transcript).toHaveBeenLastCalledWith('More speech')
  expect(f.api.askText).toHaveBeenCalledOnce()
  complete({ question: 'What time is it?', reply: 'Noon' }); await Promise.resolve(); await Promise.resolve()
  await f.app.systemExit()
})

it('quiet listening captures no automatic questions and keeps words off the glasses', async () => {
  const f = await fixture()
  try {
    expect(f.store.snapshot().listeningMode).toBe('passive')
    await f.app.configureAmbient(true, 'Peri', true)
    f.callbacks().transcript('Peri what time is it?', true, 0)
    f.callbacks().utterance('Peri what time is it?')
    expect(f.api.askText).not.toHaveBeenCalled(); expect(f.renderer.transcript).not.toHaveBeenCalled()
    expect(f.renderer.passive).toHaveBeenCalledWith(false, false, 'Peri')
    f.app.tap(); await vi.waitFor(() => expect(f.audio.start).toHaveBeenCalledTimes(2))
    await f.app.finishAsk(); await f.app.sendDraft()
    expect(f.api.askText).toHaveBeenCalledOnce()
    expect(f.audio.start).toHaveBeenCalledTimes(3)
    expect(f.store.snapshot().ambientEnabled).toBe(true)
    expect(f.renderer.answer).toHaveBeenLastCalledWith('Noon', 0, 1)
  } finally { await f.app.systemExit() }
})

it('buffered quiet listening ignores trigger results while still capturing final text', async () => {
  const f = await fixture()
  try {
    await f.app.configureSpeech('openai-buffered')
    f.api.listen.mockResolvedValue({ question: 'Peri do something', triggered: true, armed: true, prompt: 'do something' })
    const capture = vi.spyOn(f.app.proactive, 'capture')
    await f.app.configureAmbient(true, 'Peri', true)
    const frame = (amplitude: number): Uint8Array => new Uint8Array(new Int16Array(1600).fill(amplitude).buffer)
    for (let i = 0; i < 4; i++) f.receive(frame(2000))
    for (let i = 0; i < 8; i++) f.receive(frame(0))
    await vi.waitFor(() => expect(capture).toHaveBeenCalledWith('Peri do something'))
    expect(f.api.askText).not.toHaveBeenCalled(); expect(f.api.ask).not.toHaveBeenCalled()
    expect(f.api.listen).toHaveBeenCalledWith(expect.any(Blob), expect.any(String), expect.objectContaining({ answerQuestions: false, forceAnswer: false }))
  } finally { await f.app.systemExit() }
})

it('start lifelog opens the microphone automatically and foreground exit revokes retention', async () => {
  const f = await fixture()
  const proactive = vi.fn(async (body: { op: string; enabled?: boolean }) => body.op === 'consent' && body.enabled ? { consent: { id: 'fixture-consent', until: Date.now() + 60000 } } : { items: [] })
  Object.assign(f.api, { proactive })
  try {
    await f.app.configureMemory(true, true)
    expect(f.audio.start).toHaveBeenCalledOnce(); expect(f.app.proactive.memoryActive).toBe(true)
    f.app.setForeground(false); await Promise.resolve()
    expect(f.app.proactive.memoryActive).toBe(false); expect(f.speech.close).toHaveBeenCalled()
    expect(proactive).toHaveBeenCalledWith(expect.objectContaining({ op: 'consent', enabled: false, consentId: 'fixture-consent' }))
    f.app.setForeground(true); await Promise.resolve()
    expect(f.audio.start).toHaveBeenCalledOnce(); expect(f.app.proactive.memoryActive).toBe(false)
  } finally { await f.app.systemExit() }
})

it('withdrawn consent during microphone startup never enables retention', async () => {
  const f = await fixture()
  const proactive = vi.fn(async (_body: { op: string }) => ({ items: [] }))
  Object.assign(f.api, { proactive })
  let opened!: () => void
  f.speech.open.mockImplementationOnce(() => new Promise<void>(resolve => { opened = resolve }))
  const pending = f.app.configureMemory(true, true)
  await vi.waitFor(() => expect(opened).toBeTypeOf('function'))
  await f.app.configureMemory(false, false); opened(); await pending
  expect(f.app.proactive.memoryActive).toBe(false)
  expect(proactive.mock.calls.some(args => (args[0] as { op?: string } | undefined)?.op === 'consent')).toBe(false)
  expect(f.store.snapshot().ambientEnabled).toBe(false)
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
    expect(f.api.askText).toHaveBeenLastCalledWith('What time is it?', conversationId, expect.any(Function), expect.any(AbortSignal))
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
    expect(f.api.askText).toHaveBeenLastCalledWith('What time is it?', original, expect.any(Function), expect.any(AbortSignal))
  } finally { await f.app.systemExit() }
})
