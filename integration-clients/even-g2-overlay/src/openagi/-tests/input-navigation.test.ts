import { expect, it, vi } from 'vitest'
import { OsEventTypeList, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { AgentsInputController } from '../input-controller'

function setup() {
  let emit!: Parameters<EvenAppBridge['onEvenHubEvent']>[0]
  const shutDownPageContainer = vi.fn()
  const bridge = { onEvenHubEvent: (callback: typeof emit) => { emit = callback; return vi.fn() }, shutDownPageContainer }
  const actions = { input: vi.fn(), foreground: vi.fn(), tap: vi.fn(), doubleTap: vi.fn(), scrollUp: vi.fn(), scrollDown: vi.fn(), systemExit: vi.fn() }
  const input = new AgentsInputController(bridge, actions)
  input.start()
  return { input, actions, shutDownPageContainer, emit: (type: OsEventTypeList, eventSource?: number) => emit({ sysEvent: { eventType: type, eventSource } } as Parameters<typeof emit>[0]) }
}

it('a press-and-hold acts as one tap; repeats, its release and a trailing click are not extra taps', async () => {
  vi.useFakeTimers()
  const { input, actions, emit } = setup()
  try {
    emit(OsEventTypeList.LONG_PRESS_EVENT, 1); emit(OsEventTypeList.LONG_PRESS_EVENT, 1)
    expect(actions.tap).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(2000)
    emit(OsEventTypeList.LONG_PRESS_EVENT, 1)
    expect(actions.tap).toHaveBeenCalledOnce()
    emit(OsEventTypeList.LONG_PRESS_RELEASE_EVENT, 1); emit(OsEventTypeList.CLICK_EVENT)
    await vi.advanceTimersByTimeAsync(600)
    expect(actions.tap).toHaveBeenCalledOnce()
    // The next ordinary tap (stop talking) goes through.
    emit(OsEventTypeList.CLICK_EVENT); await vi.advanceTimersByTimeAsync(300)
    expect(actions.tap).toHaveBeenCalledTimes(2)
  } finally { input.stop(); vi.useRealTimers() }
})

it('reports every glasses gesture as glasses input before handling it, but not native foreground events', async () => {
  vi.useFakeTimers()
  const { input, actions, emit } = setup()
  try {
    emit(OsEventTypeList.FOREGROUND_EXIT_EVENT); emit(OsEventTypeList.FOREGROUND_ENTER_EVENT)
    expect(actions.input).not.toHaveBeenCalled()
    expect(actions.foreground.mock.calls).toEqual([[false], [true]])
    for (const type of [OsEventTypeList.CLICK_EVENT, OsEventTypeList.SCROLL_TOP_EVENT, OsEventTypeList.SCROLL_BOTTOM_EVENT, OsEventTypeList.DOUBLE_CLICK_EVENT]) emit(type)
    expect(actions.input).toHaveBeenCalledTimes(4)
    expect(actions.input.mock.invocationCallOrder[1]).toBeLessThan(actions.scrollUp.mock.invocationCallOrder[0])
    // A press still held when Agents leaves the foreground does not block the next press.
    emit(OsEventTypeList.LONG_PRESS_EVENT, 1); emit(OsEventTypeList.FOREGROUND_EXIT_EVENT)
    await vi.advanceTimersByTimeAsync(600)
    emit(OsEventTypeList.LONG_PRESS_EVENT, 1)
    expect(actions.tap).toHaveBeenCalledTimes(2)
  } finally { input.stop(); vi.useRealTimers() }
})

it('delegates double-tap to app navigation without firing a pending single tap or exiting directly', async () => {
  vi.useFakeTimers()
  const { input, actions, shutDownPageContainer, emit } = setup()
  try {
    emit(OsEventTypeList.CLICK_EVENT)
    emit(OsEventTypeList.DOUBLE_CLICK_EVENT)
    await vi.advanceTimersByTimeAsync(300)
    expect(actions.tap).not.toHaveBeenCalled()
    expect(actions.doubleTap).toHaveBeenCalledOnce()
    expect(shutDownPageContainer).not.toHaveBeenCalled()
  } finally { input.stop(); vi.useRealTimers() }
})

it('a real system exit cancels queued gestures and releases app resources', async () => {
  vi.useFakeTimers()
  const { input, actions, emit } = setup()
  try {
    emit(OsEventTypeList.CLICK_EVENT)
    emit(OsEventTypeList.SYSTEM_EXIT_EVENT)
    await vi.advanceTimersByTimeAsync(300)
    expect(actions.tap).not.toHaveBeenCalled()
    expect(actions.systemExit).toHaveBeenCalledOnce()
  } finally { input.stop(); vi.useRealTimers() }
})

it('a press-and-hold the app takes as push-to-talk sends on release; otherwise it is one tap', async () => {
  vi.useFakeTimers()
  const { input, actions, emit } = setup()
  const holdStart = vi.fn(() => true)
  const holdRelease = vi.fn()
  Object.assign(actions, { holdStart, holdRelease })
  try {
    emit(OsEventTypeList.LONG_PRESS_EVENT, 1); emit(OsEventTypeList.LONG_PRESS_EVENT, 1)
    expect(holdStart).toHaveBeenCalledOnce()
    expect(actions.tap).not.toHaveBeenCalled()
    emit(OsEventTypeList.LONG_PRESS_RELEASE_EVENT, 1); emit(OsEventTypeList.CLICK_EVENT)
    await vi.advanceTimersByTimeAsync(600)
    expect(holdRelease).toHaveBeenCalledOnce()
    expect(actions.tap).not.toHaveBeenCalled()
    // Where the app does not offer push-to-talk, the hold is a tap and its release does nothing.
    holdStart.mockReturnValue(false)
    emit(OsEventTypeList.LONG_PRESS_EVENT, 1); emit(OsEventTypeList.LONG_PRESS_RELEASE_EVENT, 1)
    expect(actions.tap).toHaveBeenCalledOnce()
    expect(holdRelease).toHaveBeenCalledOnce()
  } finally { input.stop(); vi.useRealTimers() }
})

it('leaving the glasses mid-hold cancels push-to-talk instead of sending', () => {
  const { input, actions, emit } = setup()
  const holdCancel = vi.fn()
  const holdRelease = vi.fn()
  Object.assign(actions, { holdStart: vi.fn(() => true), holdRelease, holdCancel })
  try {
    emit(OsEventTypeList.LONG_PRESS_EVENT, 1); emit(OsEventTypeList.FOREGROUND_EXIT_EVENT)
    expect(holdCancel).toHaveBeenCalledOnce()
    emit(OsEventTypeList.LONG_PRESS_RELEASE_EVENT, 1)
    expect(holdRelease).not.toHaveBeenCalled()
  } finally { input.stop() }
})
