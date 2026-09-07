import { expect, it, vi } from 'vitest'
import { OpenAGIG2App } from '../../app/openagi-g2-app'
import { OpenAGIStore } from '../store'

async function fixture() {
  const store = new OpenAGIStore({ get: () => Promise.resolve(null), set: () => Promise.resolve(), remove: () => Promise.resolve() })
  await store.update({ nodeToken: 'test-scoped-token-1234', connectionMode: 'direct', agentOrigin: 'https://main.example.com', conversationId: crypto.randomUUID() })
  let receive: (pcm: Uint8Array) => void = () => {}
  const ask = vi.fn(() => Promise.resolve({ question: 'Hello', reply: 'Hi' }))
  const listen = vi.fn(() => Promise.resolve({ question: 'Hello', triggered: false, armed: false }))
  const set = vi.fn()
  const audio = { active: false, start: vi.fn((callback: typeof receive) => { receive = callback; return Promise.resolve() }), stop: vi.fn(() => Promise.resolve()) }
  const renderer = { home: vi.fn(), recent: vi.fn(), review: vi.fn(), confirmCancel: vi.fn(), listening: vi.fn(), thinking: vi.fn(), message: vi.fn(), answer: vi.fn(), progress: vi.fn() }
  type Args = ConstructorParameters<typeof OpenAGIG2App>
  const app = new OpenAGIG2App(
    { askText: ask, listen } as unknown as Args[0], store,
    audio,
    renderer as unknown as Args[3],
    { set, paired: vi.fn(), ambient: vi.fn() } as unknown as Args[4], [],
  )
  await app.boot()
  return { app, ask, listen, set, store, audio, renderer, receive: (pcm: Uint8Array) => receive(pcm) }
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
  await app.finishAsk()
  const request = app.sendDraft(); await ready
  app.scrollDown()
  expect(renderer.progress).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), expect.stringContaining('2/'), expect.any(String))
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
  await app.sendDraft()
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

it('transcribes a valid WAV on Stop but only sends the reviewed text on confirmation', async () => {
  const { app, ask, listen, receive, set } = await fixture()
  await app.startAsk()
  receive(new Uint8Array(32000))
  expect(set).toHaveBeenLastCalledWith('Recording question', expect.stringContaining('1.0 seconds'))
  await app.startAsk()
  expect(ask).not.toHaveBeenCalled()
  expect(listen).toHaveBeenCalledOnce()
  const blob = (listen.mock.calls as unknown as [Blob, string][])[0][0]
  const bytes = await blob.arrayBuffer()
  const header = new DataView(bytes)
  expect(bytes.byteLength).toBe(32044)
  expect(header.getUint16(20, true)).toBe(1)
  expect(header.getUint16(22, true)).toBe(1)
  expect(header.getUint32(24, true)).toBe(16000)
  expect(header.getUint16(34, true)).toBe(16)
  expect(header.getUint32(40, true)).toBe(32000)
  await app.sendDraft()
  expect(ask).toHaveBeenCalledWith('Hello', expect.any(String), expect.any(Function), expect.any(AbortSignal))
  await app.systemExit()
})

it('discards a reviewed question without sending or losing the previous answer', async () => {
  const { app, ask, receive, store } = await fixture()
  await store.remember('Previous question', 'Previous answer')
  await app.startAsk(); receive(new Uint8Array(32000)); await app.finishAsk()
  app.doubleTap(); await Promise.resolve()
  await app.sendDraft()
  expect(ask).not.toHaveBeenCalled()
  expect(store.snapshot().history).toHaveLength(1)
  await app.systemExit()
})

it('keeps a draft in its original conversation until discarded or sent', async () => {
  const { app, ask, receive, store } = await fixture()
  const id = store.snapshot().conversationId
  await app.startAsk(); receive(new Uint8Array(32000)); await app.finishAsk()
  await app.newConversation(); await app.configureAmbient(true, 'Peri', false)
  expect(store.snapshot().conversationId).toBe(id)
  expect(store.snapshot().ambientEnabled).toBe(false)
  await app.rerecordDraft(); receive(new Uint8Array(32000)); await app.finishAsk(); await app.sendDraft()
  expect(ask).toHaveBeenCalledOnce()
  await app.systemExit()
})

it('does not resurrect a cancelled transcription when a late response arrives', async () => {
  const { app, ask, listen, receive } = await fixture()
  let complete!: (value: { question: string; triggered: boolean; armed: boolean }) => void
  listen.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  await app.startAsk(); receive(new Uint8Array(32000))
  const pending = app.finishAsk()
  await vi.waitFor(() => expect(listen).toHaveBeenCalledOnce())
  app.cancelRequest(); complete({ question: 'Do something', triggered: false, armed: false }); await pending
  await app.sendDraft()
  expect(ask).not.toHaveBeenCalled()
  await app.systemExit()
})

it('streams tool history without stealing answer pages and confirms cancellation on glasses', async () => {
  vi.useFakeTimers()
  const { app, ask, receive, renderer } = await fixture()
  let progress!: (event: { type: string; stage?: string; tool?: string; text?: string }) => void
  let signal!: AbortSignal
  ask.mockImplementation(((_text: string, _id: string, cb: typeof progress, abort: AbortSignal) => {
    progress = cb; signal = abort
    return new Promise((_resolve, reject) => abort.addEventListener('abort', () => reject(new Error('Interrupted')), { once: true }))
  }) as typeof ask)
  try {
    await app.startAsk(); receive(new Uint8Array(32000)); await app.finishAsk()
    const request = app.sendDraft()
    progress({ type: 'progress', stage: 'tool', tool: 'computer_list_apps' })
    progress({ type: 'progress', stage: 'model' })
    expect(renderer.progress).toHaveBeenLastCalledWith('Thinking', expect.any(String), '', expect.stringContaining('Tool: computer_list_apps'))
    progress({ type: 'delta', text: 'Visible answer '.repeat(70) })
    app.scrollDown()
    expect(renderer.progress).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), expect.stringContaining('2/'), expect.any(String))
    app.tap()
    expect(renderer.progress).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), '', expect.stringContaining('computer_list_apps'))
    app.doubleTap()
    expect(renderer.confirmCancel).toHaveBeenCalledOnce()
    expect(signal.aborted).toBe(false)
    const count = renderer.progress.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(renderer.progress).toHaveBeenCalledTimes(count)
    app.doubleTap() // Keep waiting; does not cancel.
    expect(signal.aborted).toBe(false)
    app.doubleTap(); await vi.advanceTimersByTimeAsync(401); app.tap()
    expect(signal.aborted).toBe(true)
    await request
  } finally { await app.systemExit(); vi.useRealTimers() }
})
