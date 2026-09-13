import { expect, it, vi } from 'vitest'
import { OpenAGIG2App } from '../../app/openagi-g2-app'
import { OpenAGIStore } from '../store'
import type { LiveSpeech, SpeechCallbacks } from '../live-speech'

async function fixture() {
  const storage = { get: vi.fn(() => Promise.resolve(null as string | null)), set: vi.fn(() => Promise.resolve()), remove: vi.fn(() => Promise.resolve()) }
  const store = new OpenAGIStore(storage)
  await store.update({ nodeToken: 'saved-scoped-token-123', connectionMode: 'direct', agentOrigin: 'https://main.example.com', conversationId: crypto.randomUUID(), speechModel: 'nova-3' })
  let receive: (pcm: Uint8Array) => void = () => {}
  let callbacks!: SpeechCallbacks
  const audio = { active: true, start: vi.fn((cb: typeof receive) => { receive = cb; return Promise.resolve() }), stop: vi.fn(() => Promise.resolve()) }
  const speech = { open: vi.fn(() => Promise.resolve()), push: vi.fn(), close: vi.fn(), finish: vi.fn(() => Promise.resolve('What time is it?')) }
  const api = { speechRelay: vi.fn(() => ({ url: 'wss://main.example.com/nodes/g2/speech?model=nova-3', token: 'saved-scoped-token-123' })), speechToken: vi.fn(() => Promise.resolve({ accessToken: 'short-lived-token', expiresIn: 30 })), askText: vi.fn(() => Promise.resolve({ question: 'What time is it?', reply: 'Noon' })), ask: vi.fn(), listen: vi.fn() }
  const renderer = { home: vi.fn(), ambient: vi.fn(), listening: vi.fn(), transcript: vi.fn(), progress: vi.fn(), answer: vi.fn(), message: vi.fn(), sleep: vi.fn() }
  const phone = { set: vi.fn(), paired: vi.fn(), ambient: vi.fn(), transcript: vi.fn(), speechModel: vi.fn(), activity: vi.fn() }
  type Args = ConstructorParameters<typeof OpenAGIG2App>
  const app = new OpenAGIG2App(api as unknown as Args[0], store, audio, renderer as unknown as Args[3], phone as unknown as Args[4], [], cb => { callbacks = cb; return speech as unknown as LiveSpeech })
  await app.boot()
  return { app, api, audio, renderer, phone, speech, store, storage, receive: (pcm: Uint8Array) => receive(pcm), callbacks: () => callbacks }
}

it('streams packets before Stop, then sends final text in the paired conversation without uploading a WAV', async () => {
  const f = await fixture(); await f.app.startAsk()
  expect(f.api.speechToken).not.toHaveBeenCalled()
  expect(f.speech.open).toHaveBeenCalledWith('saved-scoped-token-123', 'nova-3', 'open agi', expect.stringContaining('wss://main.example.com/nodes/g2/speech'))
  f.receive(new Uint8Array(640)); f.callbacks().transcript('What time', false, 100)
  expect(f.speech.push).toHaveBeenCalledOnce(); expect(f.api.askText).not.toHaveBeenCalled()
  expect(f.phone.transcript).toHaveBeenCalledWith('What time')
  await f.app.finishAsk()
  expect(f.api.askText).toHaveBeenCalledWith('What time is it?', f.store.snapshot().conversationId, expect.any(Function), expect.any(AbortSignal))
  expect(f.api.ask).not.toHaveBeenCalled(); expect(f.api.listen).not.toHaveBeenCalled()
  expect(JSON.stringify(f.storage.set.mock.calls)).not.toContain('short-lived-token')
  await f.app.systemExit()
})

it('triggers once from finalized wake speech, keeps interim words live during agent work and drops extra triggers', async () => {
  const f = await fixture()
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
    await f.app.startAsk(); await f.app.finishAsk()
    const conversationId = f.store.snapshot().conversationId
    const previous = f.store.snapshot().history[0]
    f.app.tap()
    await vi.waitFor(() => expect(f.audio.start).toHaveBeenCalledTimes(2))
    expect(f.store.snapshot().history[0]).toEqual(previous)
    await f.app.finishAsk()
    expect(f.api.askText).toHaveBeenLastCalledWith('What time is it?', conversationId, expect.any(Function), expect.any(AbortSignal))
    expect(f.store.snapshot().history).toHaveLength(2)
  } finally { await f.app.systemExit() }
})

it('tap on a reopened recent answer follows that original thread, not a newer one', async () => {
  const f = await fixture()
  try {
    await f.app.startAsk(); await f.app.finishAsk()
    const original = f.store.snapshot().conversationId
    await f.app.newConversation()
    expect(f.store.snapshot().conversationId).not.toBe(original)
    await f.app.selectAnswer(0)
    f.app.tap()
    await vi.waitFor(() => expect(f.audio.start).toHaveBeenCalledTimes(2))
    await f.app.finishAsk()
    expect(f.api.askText).toHaveBeenLastCalledWith('What time is it?', original, expect.any(Function), expect.any(AbortSignal))
  } finally { await f.app.systemExit() }
})
