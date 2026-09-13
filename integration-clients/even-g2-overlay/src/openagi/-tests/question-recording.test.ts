import { expect, it, vi } from 'vitest'
import { OpenAGIG2App } from '../../app/openagi-g2-app'
import { OpenAGIStore } from '../store'

async function fixture() {
  const store = new OpenAGIStore({ get: () => Promise.resolve(null), set: () => Promise.resolve(), remove: () => Promise.resolve() })
  await store.update({ nodeToken: 'test-scoped-token-1234', connectionMode: 'direct', agentOrigin: 'https://main.example.com', conversationId: crypto.randomUUID() })
  let receive: (pcm: Uint8Array) => void = () => {}
  const ask = vi.fn(() => Promise.resolve({ question: 'Hello', reply: 'Hi' }))
  const set = vi.fn()
  const audio = { active: false, start: vi.fn((callback: typeof receive) => { receive = callback; return Promise.resolve() }), stop: vi.fn(() => Promise.resolve()) }
  const renderer = { home: vi.fn(), recent: vi.fn(), listening: vi.fn(), thinking: vi.fn(), message: vi.fn(), answer: vi.fn(), progress: vi.fn() }
  type Args = ConstructorParameters<typeof OpenAGIG2App>
  const app = new OpenAGIG2App(
    { ask } as unknown as Args[0], store,
    audio,
    renderer as unknown as Args[3],
    { set, paired: vi.fn(), ambient: vi.fn() } as unknown as Args[4], [],
  )
  await app.boot()
  return { app, ask, set, store, audio, renderer, receive: (pcm: Uint8Array) => receive(pcm) }
}

it('starts buffered follow-up on tap without deleting the saved answer', async () => {
  const { app, audio, store, renderer } = await fixture()
  await store.remember('Question', '# Answer\n**Plain** text')
  await app.recentAnswer()
  app.tap()
  expect(audio.start).toHaveBeenCalledOnce()
  expect(store.snapshot().history[0].reply).toBe('# Answer\n**Plain** text')
  expect(renderer.answer).toHaveBeenLastCalledWith('Answer Plain text', 0, 1)
  await app.systemExit()
})

it('returns from an answer to Ask and browses Recent on glasses without changing the conversation', async () => {
  const { app, store, renderer, audio } = await fixture()
  const conversation = store.snapshot().conversationId
  await store.remember('First question', 'First answer')
  await store.remember('Second question', 'Second answer')
  await app.recentAnswer()
  app.doubleTap()
  expect(renderer.home).toHaveBeenCalled()
  expect(store.snapshot().conversationId).toBe(conversation)
  app.scrollDown()
  expect(renderer.recent).toHaveBeenLastCalledWith('Second question', 1, 2)
  app.scrollDown()
  expect(renderer.recent).toHaveBeenLastCalledWith('First question', 2, 2)
  app.doubleTap()
  await app.startAsk()
  expect(audio.start).toHaveBeenCalledOnce()
  expect(store.snapshot().conversationId).toBe(conversation)
  await app.systemExit()
})

it('allows paging partial text and preserves it when cancelled', async () => {
  const { app, ask, store, receive, renderer } = await fixture()
  type Callback = (event: { type: string; text: string }) => void
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const implementation = (_blob: Blob, _id: string, progress: Callback, signal: AbortSignal): Promise<{ question: string; reply: string }> => {
    progress({ type: 'delta', text: 'Partial words '.repeat(100) }); started()
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Interrupted')), { once: true }))
  }
  ask.mockImplementation(implementation as unknown as () => Promise<{ question: string; reply: string }>)
  await app.startAsk(); receive(new Uint8Array(32000))
  const request = app.finishAsk(); await ready
  app.scrollDown()
  expect(renderer.progress).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), expect.stringContaining('2/'))
  app.cancelRequest(); await request
  expect(store.snapshot().history[0].reply).toContain('Incomplete answer:')
  expect(store.snapshot().history[0].reply).toContain('Partial words')
  await app.systemExit()
})

it('ignores repeated taps and finish while the microphone open is pending', async () => {
  const { app, audio, ask } = await fixture()
  let opened!: () => void
  audio.start.mockImplementationOnce(() => new Promise<void>(resolve => { opened = resolve }))
  const opening = app.startAsk()
  app.tap()
  await app.startAsk()
  await app.finishAsk()
  expect(audio.start).toHaveBeenCalledOnce()
  expect(audio.stop).not.toHaveBeenCalled()
  expect(ask).not.toHaveBeenCalled()
  opened(); await opening
  await app.systemExit()
})

it('keeps the ambient preference and wake phrase on a microphone failure', async () => {
  const { app, audio, store, set } = await fixture()
  audio.start.mockRejectedValueOnce(new Error('microphone unavailable'))
  await app.configureAmbient(true, 'Peri', false)
  expect(store.snapshot().ambientEnabled).toBe(true)
  expect(store.snapshot().wakePhrase).toBe('Peri')
  expect(set).toHaveBeenLastCalledWith('Listening paused', expect.stringContaining('not recording'))
  await app.systemExit()
})

it('selects an older conversation for follow-up and keeps a new conversation separate', async () => {
  const { app, ask, store, receive } = await fixture()
  const original = store.snapshot().conversationId
  await store.remember('Old question', 'Old answer')
  await app.newConversation()
  expect(store.snapshot().conversationId).not.toBe(original)
  await app.selectAnswer(0)
  expect(store.snapshot().conversationId).toBe(original)
  await app.startAsk()
  receive(new Uint8Array(32000))
  await app.finishAsk()
  expect((ask.mock.calls as unknown as [Blob, string][])[0][1]).toBe(original)
  expect(store.snapshot().history).toHaveLength(2)
  await app.systemExit()
})

it('does not submit an empty microphone capture and allows retry from the phone', async () => {
  const { app, ask, set } = await fixture()
  await app.startAsk()
  await app.startAsk()
  expect(ask).not.toHaveBeenCalled()
  expect(set).toHaveBeenLastCalledWith('Ask failed', expect.stringContaining('No microphone audio arrived'))
  await app.startAsk()
  expect(set).toHaveBeenLastCalledWith('Opening microphone…', expect.any(String))
  await app.systemExit()
})

it('rejects recordings shorter than the server minimum', async () => {
  const { app, ask, receive, set } = await fixture()
  await app.startAsk()
  receive(new Uint8Array(1600))
  await app.finishAsk()
  expect(ask).not.toHaveBeenCalled()
  expect(set).toHaveBeenLastCalledWith('Ask failed', expect.stringContaining('too short'))
  await app.systemExit()
})

it('shows received audio and sends a valid 16 kHz mono PCM WAV on the second phone press', async () => {
  const { app, ask, receive, set } = await fixture()
  await app.startAsk()
  receive(new Uint8Array(32000))
  expect(set).toHaveBeenLastCalledWith('Recording question', expect.stringContaining('1.0 seconds'))
  await app.startAsk()
  expect(ask).toHaveBeenCalledOnce()
  const blob = (ask.mock.calls as unknown as [Blob, string][])[0][0]
  const bytes = await blob.arrayBuffer()
  const header = new DataView(bytes)
  expect(bytes.byteLength).toBe(32044)
  expect(header.getUint16(20, true)).toBe(1)
  expect(header.getUint16(22, true)).toBe(1)
  expect(header.getUint32(24, true)).toBe(16000)
  expect(header.getUint16(34, true)).toBe(16)
  expect(header.getUint32(40, true)).toBe(32000)
  await app.systemExit()
})
