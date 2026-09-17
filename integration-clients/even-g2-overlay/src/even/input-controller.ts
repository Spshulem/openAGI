import { OsEventTypeList, type EvenAppBridge } from '@evenrealities/even_hub_sdk'

export interface InputHandlers {
  tap(): void
  scrollUp(): void
  scrollDown(): void
  doubleTap(): void
  systemExit(): void
}

export class EvenInputController {
  private unsubscribe: (() => void) | null = null

  constructor(private readonly bridge: EvenAppBridge, private readonly handlers: InputHandlers) {}

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.bridge.onEvenHubEvent(event => {
      const types = [eventTypeOf(event.sysEvent), eventTypeOf(event.textEvent)].filter((value): value is OsEventTypeList => value !== null)
      if (types.includes(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
        this.handlers.doubleTap()
        void this.bridge.shutDownPageContainer(1)
        return
      }
      if (types.includes(OsEventTypeList.CLICK_EVENT)) this.handlers.tap()
      else if (types.includes(OsEventTypeList.SCROLL_TOP_EVENT)) this.handlers.scrollUp()
      else if (types.includes(OsEventTypeList.SCROLL_BOTTOM_EVENT)) this.handlers.scrollDown()
      else if (types.includes(OsEventTypeList.SYSTEM_EXIT_EVENT) || types.includes(OsEventTypeList.ABNORMAL_EXIT_EVENT)) this.handlers.systemExit()
    })
  }

  stop(): void { this.unsubscribe?.(); this.unsubscribe = null }
}

export function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}
