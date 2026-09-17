import { OsEventTypeList, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { eventTypeOf, type InputHandlers } from '../even/input-controller'

/** The app routes double-tap: native exit confirmation at root, Back elsewhere. */
export class AgentsInputController {
  private unsubscribe: (() => void) | null = null
  private pendingTap: ReturnType<typeof setTimeout> | null = null
  private heldSource: number | null = null
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  private suppressTapUntil = 0
  constructor(private readonly bridge: Pick<EvenAppBridge, 'onEvenHubEvent'>, private readonly handlers: InputHandlers & { foreground?(active: boolean): void; holdStart?(): void; holdRelease?(): void; holdCancel?(): void }) {}
  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.bridge.onEvenHubEvent(event => {
      const types = [eventTypeOf(event.sysEvent), eventTypeOf(event.textEvent)]
      if (types.includes(OsEventTypeList.SYSTEM_EXIT_EVENT) || types.includes(OsEventTypeList.ABNORMAL_EXIT_EVENT)) {
        this.stop(); this.handlers.systemExit(); return
      }
      if (types.includes(OsEventTypeList.FOREGROUND_EXIT_EVENT)) { this.clearTap(); this.clearHold(); this.handlers.foreground?.(false); return }
      if (types.includes(OsEventTypeList.FOREGROUND_ENTER_EVENT)) { this.handlers.foreground?.(true); return }
      const press = [event.sysEvent, event.textEvent].find(e => e?.eventType === OsEventTypeList.LONG_PRESS_EVENT)
      const release = [event.sysEvent, event.textEvent].find(e => e?.eventType === OsEventTypeList.LONG_PRESS_RELEASE_EVENT)
      if (press || release) {
        this.clearTap(); this.suppressTapUntil = Date.now() + 500
        // A ring or the other temple must not release a press it did not start.
        const envelope = press ?? release
        const source = envelope && 'eventSource' in envelope ? envelope.eventSource : undefined
        if (typeof source !== 'number') return
        if (press && this.heldSource === null) {
          this.heldSource = source
          this.holdTimer = setTimeout(() => { this.clearHold(); this.suppressTapUntil = Date.now() + 500; this.handlers.holdCancel?.() }, 31_000)
          this.handlers.holdStart?.()
        }
        else if (release && this.heldSource === source) { this.clearHold(); this.handlers.holdRelease?.() }
        return
      }
      if (this.heldSource !== null) {
        if (types.includes(OsEventTypeList.DOUBLE_CLICK_EVENT)) { this.clearHold(); this.suppressTapUntil = Date.now() + 500; this.handlers.holdCancel?.() }
        return
      }
      if (types.includes(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
        this.clearTap(); this.handlers.doubleTap(); return
      }
      if (types.includes(OsEventTypeList.CLICK_EVENT)) {
        if (Date.now() < this.suppressTapUntil) return
        if (this.pendingTap === null) this.pendingTap = setTimeout(() => { this.pendingTap = null; this.handlers.tap() }, 250)
      } else if (types.includes(OsEventTypeList.SCROLL_TOP_EVENT)) { this.clearTap(); this.handlers.scrollUp() }
      else if (types.includes(OsEventTypeList.SCROLL_BOTTOM_EVENT)) { this.clearTap(); this.handlers.scrollDown() }
    })
  }
  private clearTap(): void { if (this.pendingTap !== null) clearTimeout(this.pendingTap); this.pendingTap = null }
  private clearHold(): void { if (this.holdTimer !== null) clearTimeout(this.holdTimer); this.holdTimer = null; this.heldSource = null }
  stop(): void { this.clearTap(); this.clearHold(); this.unsubscribe?.(); this.unsubscribe = null }
}
