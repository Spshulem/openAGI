import { OsEventTypeList, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { eventTypeOf, type InputHandlers } from '../even/input-controller'

/** Agents owns navigation. A double tap must not destroy its native page. */
export class AgentsInputController {
  private unsubscribe: (() => void) | null = null
  private pendingTap: ReturnType<typeof setTimeout> | null = null
  constructor(private readonly bridge: Pick<EvenAppBridge, 'onEvenHubEvent'>, private readonly handlers: InputHandlers) {}
  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.bridge.onEvenHubEvent(event => {
      const types = [eventTypeOf(event.sysEvent), eventTypeOf(event.textEvent)]
      if (types.includes(OsEventTypeList.SYSTEM_EXIT_EVENT) || types.includes(OsEventTypeList.ABNORMAL_EXIT_EVENT)) {
        this.stop(); this.handlers.systemExit(); return
      }
      if (types.includes(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
        this.clearTap(); this.handlers.doubleTap(); return
      }
      if (types.includes(OsEventTypeList.CLICK_EVENT)) {
        if (this.pendingTap === null) this.pendingTap = setTimeout(() => { this.pendingTap = null; this.handlers.tap() }, 250)
      } else if (types.includes(OsEventTypeList.SCROLL_TOP_EVENT)) { this.clearTap(); this.handlers.scrollUp() }
      else if (types.includes(OsEventTypeList.SCROLL_BOTTOM_EVENT)) { this.clearTap(); this.handlers.scrollDown() }
    })
  }
  private clearTap(): void { if (this.pendingTap !== null) clearTimeout(this.pendingTap); this.pendingTap = null }
  stop(): void { this.clearTap(); this.unsubscribe?.(); this.unsubscribe = null }
}
