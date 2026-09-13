import { expect, it, vi } from 'vitest'
import { OsEventTypeList, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { AgentsInputController } from '../input-controller'

function setup() {
  let emit!: Parameters<EvenAppBridge['onEvenHubEvent']>[0]
  const shutDownPageContainer = vi.fn()
  const bridge = { onEvenHubEvent: (callback: typeof emit) => { emit = callback; return vi.fn() }, shutDownPageContainer }
  const actions = { tap: vi.fn(), doubleTap: vi.fn(), scrollUp: vi.fn(), scrollDown: vi.fn(), systemExit: vi.fn() }
  const input = new AgentsInputController(bridge, actions)
  input.start()
  return { input, actions, shutDownPageContainer, emit: (type: OsEventTypeList) => emit({ sysEvent: { eventType: type } } as Parameters<typeof emit>[0]) }
}

it('double-tap navigates without closing the page or firing a pending single tap', async () => {
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
