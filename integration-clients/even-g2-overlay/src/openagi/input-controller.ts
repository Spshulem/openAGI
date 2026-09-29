import { OsEventTypeList, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { eventTypeOf, type InputHandlers } from '../even/input-controller'

const GESTURES = [OsEventTypeList.CLICK_EVENT, OsEventTypeList.DOUBLE_CLICK_EVENT, OsEventTypeList.SCROLL_TOP_EVENT,
  OsEventTypeList.SCROLL_BOTTOM_EVENT, OsEventTypeList.LONG_PRESS_EVENT, OsEventTypeList.LONG_PRESS_RELEASE_EVENT]

/** The app routes double-tap: native exit confirmation at root, Back elsewhere. */
export class AgentsInputController {
  private unsubscribe: (() => void) | null = null
  private pendingTap: ReturnType<typeof setTimeout> | null = null
  private suppressTapUntil = 0
  private heldUntil = 0
  // This press started push-to-talk, so its release sends.
  private holding = false
  // input(): any glasses gesture proves the app is on the glasses now, even if
  // Even never delivered (or delivered late) its foreground-enter event.
  // holdStart: the app takes a press-and-hold as push-to-talk (true) where it
  // offers it (Supervisor home); otherwise the hold is one tap as before.
  constructor(private readonly bridge: Pick<EvenAppBridge, 'onEvenHubEvent'>, private readonly handlers: InputHandlers & { foreground?(active: boolean): void; input?(): void; holdStart?(): boolean; holdRelease?(): void; holdCancel?(): void }) {}
  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.bridge.onEvenHubEvent(event => {
      const types = [eventTypeOf(event.sysEvent), eventTypeOf(event.textEvent)]
      if (types.includes(OsEventTypeList.SYSTEM_EXIT_EVENT) || types.includes(OsEventTypeList.ABNORMAL_EXIT_EVENT)) {
        this.stop(); this.handlers.systemExit(); return
      }
      if (types.includes(OsEventTypeList.FOREGROUND_EXIT_EVENT)) {
        this.clearTap(); this.heldUntil = 0
        if (this.holding) { this.holding = false; this.handlers.holdCancel?.() }
        this.handlers.foreground?.(false); return
      }
      if (types.includes(OsEventTypeList.FOREGROUND_ENTER_EVENT)) { this.handlers.foreground?.(true); return }
      if (types.some(type => type !== null && GESTURES.includes(type))) this.handlers.input?.()
      // A press-and-hold is push-to-talk where the app offers it, else one tap
      // (start or stop talking); its release and any trailing click from the
      // same press are not a second tap. Repeated press events while still
      // holding are the same press.
      if (types.includes(OsEventTypeList.LONG_PRESS_EVENT)) {
        this.clearTap()
        if (Date.now() >= this.heldUntil && Date.now() >= this.suppressTapUntil) {
          this.holding = this.handlers.holdStart?.() === true
          if (!this.holding) this.handlers.tap()
        }
        this.heldUntil = Date.now() + 31_000; this.suppressTapUntil = Date.now() + 500; return
      }
      if (types.includes(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)) {
        this.clearTap(); this.heldUntil = 0; this.suppressTapUntil = Date.now() + 500
        if (this.holding) { this.holding = false; this.handlers.holdRelease?.() }
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
  stop(): void { this.clearTap(); this.unsubscribe?.(); this.unsubscribe = null }
}
