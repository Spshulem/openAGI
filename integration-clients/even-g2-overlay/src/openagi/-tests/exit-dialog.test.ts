import { afterEach, expect, it, vi } from 'vitest'
import { OsEventTypeList, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { OpenAGIG2App } from '../../app/openagi-g2-app'
import { OpenAGIGlassesRenderer } from '../../ui/openagi-glasses-renderer'
import { AgentsDisplayController } from '../display-controller'
import { AgentsInputController } from '../input-controller'
import { OpenAGIStore } from '../store'

afterEach(() => vi.useRealTimers())

async function fixture(paired = true) {
  vi.useFakeTimers()
  const store = new OpenAGIStore({ get: () => Promise.resolve(null), set: async () => {}, remove: async () => {} })
  if (paired) await store.update({ connectionMode: 'direct', nodeToken: 'exit-test-scoped-token', agentOrigin: 'https://main.example.com', conversationId: crypto.randomUUID() })
  let emit!: Parameters<EvenAppBridge['onEvenHubEvent']>[0]
  const unsubscribe = vi.fn()
  const bridge = {
    onEvenHubEvent: (callback: typeof emit) => { emit = callback; return unsubscribe },
    shutDownPageContainer: vi.fn<(mode: number) => Promise<boolean>>().mockResolvedValue(true),
    createStartUpPageContainer: vi.fn(() => Promise.resolve(0)),
    textContainerUpgrade: vi.fn(() => Promise.resolve(true)),
  }
  const display = new AgentsDisplayController(bridge as unknown as EvenAppBridge)
  await display.initialize('Starting')
  const renderer = new OpenAGIGlassesRenderer(display)
  const audio = { active: false, start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const phone = { set: vi.fn(), paired: vi.fn(), ambient: vi.fn() }
  type Args = ConstructorParameters<typeof OpenAGIG2App>
  const app = new OpenAGIG2App({} as Args[0], store, audio, renderer, phone as unknown as Args[4], [])
  const systemExit = vi.spyOn(app, 'systemExit')
  const input = new AgentsInputController(bridge, {
    tap: () => app.tap(), doubleTap: () => app.doubleTap(), scrollUp: () => app.scrollUp(), scrollDown: () => app.scrollDown(),
    systemExit: () => { void app.systemExit() }, foreground: active => app.setForeground(active),
  })
  input.start()
  await app.boot()
  return { app, store, bridge, audio, phone, renderer, systemExit, unsubscribe,
    emit: (type: OsEventTypeList, source: 'sysEvent' | 'textEvent' = 'sysEvent') => emit({ [source]: { eventType: type } }),
    close: async () => { input.stop(); await app.systemExit(); await vi.advanceTimersByTimeAsync(200) },
  }
}

it.each([true, false])('requests the native mode-1 exit dialog at root (paired=%s), without shutting down', async paired => {
  const f = await fixture(paired)
  try {
    f.emit(OsEventTypeList.CLICK_EVENT)
    f.emit(OsEventTypeList.DOUBLE_CLICK_EVENT)
    await vi.advanceTimersByTimeAsync(501)
    expect(f.bridge.shutDownPageContainer.mock.calls).toEqual([[1]])
    expect(f.systemExit).not.toHaveBeenCalled()
    expect(f.audio.start).not.toHaveBeenCalled()
    expect(f.unsubscribe).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it('remains usable when the dialog is dismissed without a native exit event', async () => {
  const f = await fixture()
  try {
    await f.store.remember('Saved question', 'Saved answer')
    const before = f.store.snapshot()
    f.emit(OsEventTypeList.DOUBLE_CLICK_EVENT, 'textEvent')
    await vi.advanceTimersByTimeAsync(501)
    expect(f.store.snapshot()).toEqual(before)
    f.emit(OsEventTypeList.CLICK_EVENT)
    await vi.advanceTimersByTimeAsync(251)
    expect(f.audio.start).toHaveBeenCalledOnce()
    expect(f.systemExit).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it('keeps Recent on swipe and Back on child pages; only the next root double-tap requests exit', async () => {
  const f = await fixture()
  try {
    await f.store.remember('Saved question', 'Saved answer')
    const recent = vi.spyOn(f.renderer, 'recent')
    const home = vi.spyOn(f.renderer, 'home')
    f.app.scrollDown()
    expect(recent).toHaveBeenCalledWith('Saved question', 1, 1)
    f.emit(OsEventTypeList.DOUBLE_CLICK_EVENT)
    await vi.advanceTimersByTimeAsync(501)
    expect(home).toHaveBeenCalled()
    expect(f.bridge.shutDownPageContainer).not.toHaveBeenCalled()
    f.emit(OsEventTypeList.DOUBLE_CLICK_EVENT)
    expect(f.bridge.shutDownPageContainer).toHaveBeenCalledWith(1)
  } finally { await f.close() }
})

it.each([OsEventTypeList.SYSTEM_EXIT_EVENT, OsEventTypeList.ABNORMAL_EXIT_EVENT])('cleans up only after native exit event %s', async type => {
  const f = await fixture()
  try {
    await f.app.requestExit() // The phone Exit button uses the same path.
    expect(f.systemExit).not.toHaveBeenCalled()
    f.emit(type)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.systemExit).toHaveBeenCalledOnce()
    expect(f.unsubscribe).toHaveBeenCalledOnce()
    expect(f.audio.stop).toHaveBeenCalledOnce()
    f.app.doubleTap()
    expect(f.bridge.shutDownPageContainer).toHaveBeenCalledOnce()
  } finally { await f.close() }
})

it('coalesces exit requests while the SDK call is pending', async () => {
  const f = await fixture()
  try {
    let resolve!: (shown: boolean) => void
    f.bridge.shutDownPageContainer.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    f.app.doubleTap(); f.app.doubleTap(); await f.app.requestExit()
    expect(f.bridge.shutDownPageContainer).toHaveBeenCalledOnce()
    resolve(true)
    await vi.advanceTimersByTimeAsync(501)
    f.app.doubleTap()
    expect(f.bridge.shutDownPageContainer.mock.calls).toEqual([[1], [1]])
  } finally { await f.close() }
})

it.each(['false', 'error'])('reports an exit-dialog %s and permits retry without losing the app', async result => {
  const f = await fixture()
  try {
    if (result === 'false') f.bridge.shutDownPageContainer.mockResolvedValueOnce(false)
    else f.bridge.shutDownPageContainer.mockRejectedValueOnce(new Error('SDK unavailable'))
    await f.app.requestExit()
    expect(f.phone.set).toHaveBeenLastCalledWith('Exit dialog unavailable', expect.any(String))
    expect(f.systemExit).not.toHaveBeenCalled()
    await f.app.requestExit()
    expect(f.bridge.shutDownPageContainer.mock.calls).toEqual([[1], [1]])
  } finally { await f.close() }
})
