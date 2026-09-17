import { expect, it, vi } from 'vitest'
import { OsEventTypeList, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { AgentsInputController } from '../input-controller'

function setup() {
  let emit!: Parameters<EvenAppBridge['onEvenHubEvent']>[0]
  const shutDownPageContainer = vi.fn()
  const bridge = { onEvenHubEvent: (callback: typeof emit) => { emit = callback; return vi.fn() }, shutDownPageContainer }
  const actions = { holdStart: vi.fn(), holdRelease: vi.fn(), holdCancel: vi.fn(), tap: vi.fn(), doubleTap: vi.fn(), scrollUp: vi.fn(), scrollDown: vi.fn(), systemExit: vi.fn() }
  const input = new AgentsInputController(bridge, actions)
  input.start()
  return { input, actions, shutDownPageContainer, emit: (type: OsEventTypeList, eventSource?: number) => emit({ sysEvent: { eventType: type, eventSource } } as Parameters<typeof emit>[0]) }
}

it('matches hold release to its source and suppresses repeat and trailing clicks', async () => {
  vi.useFakeTimers()
  const { input, actions, emit } = setup()
  try {
    emit(OsEventTypeList.CLICK_EVENT)
    emit(OsEventTypeList.LONG_PRESS_EVENT, 1); emit(OsEventTypeList.LONG_PRESS_EVENT, 1)
    emit(OsEventTypeList.LONG_PRESS_RELEASE_EVENT, 2)
    expect(actions.holdRelease).not.toHaveBeenCalled()
    emit(OsEventTypeList.CLICK_EVENT); await vi.advanceTimersByTimeAsync(600)
    expect(actions.tap).not.toHaveBeenCalled()
    emit(OsEventTypeList.LONG_PRESS_RELEASE_EVENT, 1)
    emit(OsEventTypeList.LONG_PRESS_RELEASE_EVENT, 1); emit(OsEventTypeList.CLICK_EVENT)
    await vi.advanceTimersByTimeAsync(600)
    expect(actions.holdStart).toHaveBeenCalledOnce(); expect(actions.holdRelease).toHaveBeenCalledOnce()
    expect(actions.tap).not.toHaveBeenCalled()
  } finally { input.stop(); vi.useRealTimers() }
})

it('ignores unknown hold sources and stale release after foreground exit', () => {
  const { input, actions, emit } = setup()
  try {
    emit(OsEventTypeList.LONG_PRESS_EVENT)
    expect(actions.holdStart).not.toHaveBeenCalled()
    emit(OsEventTypeList.LONG_PRESS_EVENT, 1)
    emit(OsEventTypeList.FOREGROUND_EXIT_EVENT)
    emit(OsEventTypeList.LONG_PRESS_RELEASE_EVENT, 1)
    expect(actions.holdRelease).not.toHaveBeenCalled()
  } finally { input.stop() }
})

it('recovers the gesture controller after a missing release', async () => {
  vi.useFakeTimers()
  const { input, actions, emit } = setup()
  try {
    emit(OsEventTypeList.LONG_PRESS_EVENT, 1)
    await vi.advanceTimersByTimeAsync(31000)
    expect(actions.holdCancel).toHaveBeenCalledOnce()
    expect(actions.holdRelease).not.toHaveBeenCalled()
    emit(OsEventTypeList.LONG_PRESS_EVENT, 1)
    expect(actions.holdStart).toHaveBeenCalledTimes(2)
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
