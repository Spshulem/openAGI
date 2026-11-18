import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OpenAGIG2App } from '../../app/openagi-g2-app'
import { OpenAGIStore } from '../store'
import { G2VoiceSession } from '../voice-session'
import { FakeVoiceSocket } from './voice-socket'

async function fixture() {
  const store = new OpenAGIStore({ get: () => Promise.resolve(null), set: () => Promise.resolve(), remove: () => Promise.resolve() })
  await store.update({ homeMode: 'supervisor', nodeToken: 'g2-test-token-123456', connectionMode: 'direct', agentOrigin: 'https://main.example', autoSend: false })
  const sockets: FakeVoiceSocket[] = []
  let receive: (pcm: Uint8Array) => void = () => {}
  const audio = { active: false, start: vi.fn((callback: typeof receive) => { receive = callback; audio.active = true; return Promise.resolve() }), stop: vi.fn(() => { audio.active = false; return Promise.resolve() }) }
  const api = { voiceRelay: vi.fn(() => ({ url: 'wss://main.example/nodes/voice?rate=16000&mode=ptt', token: 'g2-test-token-123456' })), ask: vi.fn(), askText: vi.fn(), listen: vi.fn(), hubVoiceEnabled: vi.fn(() => Promise.resolve<boolean | null>(null)) }
  const renderer = { supervisorHome: vi.fn(), home: vi.fn(), listening: vi.fn(), thinking: vi.fn(), progress: vi.fn(), answer: vi.fn(), message: vi.fn(), inboxList: vi.fn(), autoSend: vi.fn() }
  const phone = { set: vi.fn(), paired: vi.fn(), preview: vi.fn(), transcript: vi.fn() }
  type Args = ConstructorParameters<typeof OpenAGIG2App>
  const app = new OpenAGIG2App(api as unknown as Args[0], store, audio, renderer as unknown as Args[3], phone as unknown as Args[4], [], undefined,
    callbacks => new G2VoiceSession(audio, callbacks, () => { const socket = new FakeVoiceSocket(); sockets.push(socket); return socket }))
  await app.boot()
  const ready = async () => { sockets.at(-1)!.open(); sockets.at(-1)!.event({ type: 'ready', output: 'text' }); await vi.advanceTimersByTimeAsync(1) }
  return { app, api, store, audio, renderer, phone, sockets, ready, receive: (pcm: Uint8Array) => receive(pcm) }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('Supervisor tap opens the voice relay, stop tap commits with review on, and text uses answer cards', async () => {
  const f = await fixture()
  try {
    f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    expect(f.api.voiceRelay).toHaveBeenCalledOnce(); expect(f.audio.start).not.toHaveBeenCalled()
    await f.ready(); f.receive(new Uint8Array(6400)); f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    expect(f.sockets[0].frames()).toContainEqual({ type: 'commit' })
    f.sockets[0].event({ type: 'reply.delta', text: '**Ready**' })
    expect(f.renderer.answer).toHaveBeenLastCalledWith('Ready', 0, 1)
    f.sockets[0].event({ type: 'reply.done', text: 'Card words '.repeat(100) })
    expect(f.renderer.answer.mock.calls.at(-1)![2]).toBeGreaterThan(1)
    f.app.scrollDown(); expect(f.renderer.answer.mock.calls.at(-1)![1]).toBe(1)
    expect(f.api.askText).not.toHaveBeenCalled(); expect(f.api.ask).not.toHaveBeenCalled(); expect(f.api.listen).not.toHaveBeenCalled()
    expect(f.audio.active).toBe(false)
  } finally { await f.app.systemExit() }
})

it('Supervisor hold commits on release, including release before ready, once', async () => {
  const f = await fixture()
  try {
    expect(f.app.holdStart()).toBe(true); f.app.holdRelease()
    await f.ready(); f.app.holdRelease(); await vi.advanceTimersByTimeAsync(1)
    expect(f.sockets[0].frames().filter(frame => 'type' in frame && frame.type === 'commit')).toHaveLength(1)
    expect(f.api.askText).not.toHaveBeenCalled()
  } finally { await f.app.systemExit() }
})

it('ignores connecting clicks and bounces after sending but accepts a quick listening stop', async () => {
  const f = await fixture()
  try {
    f.app.tap(); await vi.advanceTimersByTimeAsync(500); f.app.tap()
    await f.ready()
    expect(f.sockets[0].frames()).not.toContainEqual({ type: 'commit' })
    f.receive(new Uint8Array(6400)); f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    expect(f.sockets[0].frames()).toContainEqual({ type: 'commit' })
    f.app.tap(); await vi.advanceTimersByTimeAsync(399)
    expect(f.sockets[0].frames()).not.toContainEqual({ type: 'barge' })
    f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    expect(f.sockets[0].frames()).toContainEqual({ type: 'barge' })
  } finally { await f.app.systemExit() }
})

it('an interrupt tap during native stop resumes listening once stop finishes', async () => {
  const f = await fixture()
  try {
    f.app.tap(); await f.ready(); f.receive(new Uint8Array(6400))
    let stopped!: () => void
    f.audio.stop.mockImplementationOnce(() => new Promise<void>(resolve => { stopped = resolve }))
    f.app.tap(); await vi.advanceTimersByTimeAsync(500); f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    expect(f.audio.start).toHaveBeenCalledOnce()
    stopped(); await vi.advanceTimersByTimeAsync(1)
    expect(f.audio.start).toHaveBeenCalledTimes(2)
    expect(f.renderer.listening).toHaveBeenCalledTimes(2)
    expect(f.sockets[0].frames()).toContainEqual({ type: 'barge' })
  } finally { await f.app.systemExit() }
})

it('a new tap while reply text streams barges and resumes capture on the same session', async () => {
  const f = await fixture()
  try {
    await f.app.startAsk(); await f.ready(); await f.app.finishAsk(); await vi.advanceTimersByTimeAsync(500)
    f.sockets[0].event({ type: 'reply.delta', text: 'First reply' })
    f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    expect(f.sockets[0].frames()).toContainEqual({ type: 'barge' })
    expect(f.audio.start).toHaveBeenCalledTimes(2); expect(f.sockets).toHaveLength(1)
  } finally { await f.app.systemExit() }
})

it('talking about a selected inbox card maps its question and displayed thread into start and context', async () => {
  const f = await fixture()
  try {
    f.app.proactive.items = [{ id: 'outreach-7', questionId: 'fq_1', threadKey: 'codex:one', supervisor: true, title: 'Merge?', summary: '', category: 'approvals', important: true, seen: true, action: 'answer-fleet' }]
    f.app.openInbox(undefined, true); await f.app.startAsk(); await f.ready()
    const focus = { view: 'supervisor', questionId: 'fq_1', threadKey: 'codex:one' }
    expect(f.sockets[0].frames()).toContainEqual({ type: 'start', gesture: 'tap', mode: 'ptt', focus })
    expect(f.sockets[0].frames()).toContainEqual({ type: 'context', focus })
  } finally { await f.app.systemExit() }
})

it('leaving the foreground cancels a hold without commit; the next tap creates a fresh session', async () => {
  const f = await fixture()
  try {
    f.app.holdStart(); await f.ready(); f.receive(new Uint8Array(3200))
    f.app.setForeground(false); f.app.holdRelease(); await vi.advanceTimersByTimeAsync(1)
    expect(f.sockets[0].close).toHaveBeenCalledOnce()
    expect(f.sockets[0].frames()).not.toContainEqual({ type: 'commit' })
    f.app.setForeground(true); await vi.advanceTimersByTimeAsync(500); f.app.tap(); await f.ready()
    expect(f.sockets).toHaveLength(2); expect(f.audio.active).toBe(true)
  } finally { await f.app.systemExit() }
})

it('an unavailable relay reports the problem and sends no legacy fallback request', async () => {
  const f = await fixture()
  try {
    f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    f.sockets[0].onerror?.(new Event('error'))
    expect(f.renderer.message).toHaveBeenLastCalledWith('Supervisor voice unavailable', expect.stringContaining('enabled'))
    expect(f.api.ask).not.toHaveBeenCalled(); expect(f.api.askText).not.toHaveBeenCalled(); expect(f.audio.start).not.toHaveBeenCalled()
  } finally { await f.app.systemExit() }
})

it('says voice is off on the hub when main reports OPENAGI_VOICE off, still with no fallback request', async () => {
  const f = await fixture()
  try {
    f.api.hubVoiceEnabled.mockResolvedValue(false)
    f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    f.sockets[0].onerror?.(new Event('error')); await vi.advanceTimersByTimeAsync(1)
    expect(f.api.hubVoiceEnabled).toHaveBeenCalledOnce()
    expect(f.renderer.message).toHaveBeenLastCalledWith('Supervisor voice unavailable', 'Voice is off on your hub. Set OPENAGI_VOICE=1.')
    expect(f.phone.set).toHaveBeenLastCalledWith('Supervisor voice unavailable', 'Voice is off on your hub. Set OPENAGI_VOICE=1.')
    expect(f.api.ask).not.toHaveBeenCalled(); expect(f.api.askText).not.toHaveBeenCalled(); expect(f.audio.start).not.toHaveBeenCalled()
    f.api.hubVoiceEnabled.mockResolvedValue(true)
    await vi.advanceTimersByTimeAsync(500); f.app.tap(); await vi.advanceTimersByTimeAsync(500); f.app.tap(); await vi.advanceTimersByTimeAsync(1)
    expect(f.sockets).toHaveLength(2)
    f.sockets[1].onerror?.(new Event('error')); await vi.advanceTimersByTimeAsync(1)
    expect(f.renderer.message).toHaveBeenLastCalledWith('Supervisor voice unavailable', expect.stringContaining('enabled'))
  } finally { await f.app.systemExit() }
})

it('the 30-second cap commits once and system exit closes the microphone and socket', async () => {
  const f = await fixture()
  f.app.holdStart(); await f.ready(); await vi.advanceTimersByTimeAsync(30_000); f.app.holdRelease(); await vi.advanceTimersByTimeAsync(1)
  expect(f.sockets[0].frames().filter(frame => 'type' in frame && frame.type === 'commit')).toHaveLength(1)
  expect(f.phone.set).toHaveBeenCalledWith('Supervisor voice', expect.stringContaining('30-second limit'))
  await f.app.systemExit(); expect(f.sockets[0].close).toHaveBeenCalledOnce(); expect(f.audio.active).toBe(false)
})

it('talking on Supervisor home focuses the lead PM card automatically without opening menus', async () => {
  const f = await fixture()
  try {
    f.app.proactive.items = [{
      id: 'o-pr-88',
      cardId: 'q:fq_88',
      cardKind: 'pr_ready',
      questionId: 'fq_88',
      threadKey: 'codex:auth',
      prRef: 'acme/api#88',
      pmBrief: 'Auth refresh green · Rec: Merge PR #88',
      primaryLabel: 'Merge PR',
      supervisor: true,
      title: 'PR #88 ready',
      summary: 'Auth refresh green',
      category: 'approvals',
      important: true,
      seen: false,
      action: 'act-fleet-card',
    }]
    expect(f.app.holdStart()).toBe(true)
    await f.ready()
    const focus = { view: 'supervisor', cardId: 'q:fq_88', questionId: 'fq_88', threadKey: 'codex:auth', prRef: 'acme/api#88' }
    expect(f.sockets[0].frames()).toContainEqual({ type: 'start', gesture: 'tap', mode: 'ptt', focus })
    expect(f.sockets[0].frames()).toContainEqual({ type: 'context', focus })
  } finally { await f.app.systemExit() }
})
