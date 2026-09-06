import { AudioInputSource, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { AudioSource } from '../even/audio-source'

/** The native microphone has one owner. Never overlap open and close calls. */
export class SerializedAudioSource implements AudioSource {
  private tail: Promise<void> = Promise.resolve()
  private unsubscribe: (() => void) | null = null
  private isActive = false
  private nativeStateUnknown = false
  constructor(private readonly bridge: Pick<EvenAppBridge, 'audioControl' | 'onEvenHubEvent'>) {}
  get active(): boolean { return this.isActive || this.nativeStateUnknown }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.tail.then(operation)
    this.tail = next.catch(() => undefined)
    return next
  }
  start(onPcm: (pcm: Uint8Array) => void): Promise<void> {
    return this.enqueue(async () => {
      if (this.isActive) throw new Error('The microphone is already in use. Stop the current recording first.')
      if (this.nativeStateUnknown) await this.closeNative()
      this.unsubscribe = this.bridge.onEvenHubEvent(event => {
        if (event.audioEvent?.audioPcm && this.isActive) onPcm(event.audioEvent.audioPcm)
      })
      try {
        if (!await this.bridge.audioControl(true, AudioInputSource.Glasses)) {
          throw new Error('The Even app could not open the glasses microphone. Close and reopen Agents in the Even app to restore its glasses page, then try once. If it still fails, check the glasses connection and microphone access. No re-pairing needed.')
        }
        this.isActive = true
      } catch (error) {
        this.nativeStateUnknown = true
        this.unsubscribe?.(); this.unsubscribe = null
        throw error
      }
    })
  }
  stop(): Promise<void> {
    return this.enqueue(async () => {
      this.unsubscribe?.(); this.unsubscribe = null
      if (!this.isActive && !this.nativeStateUnknown) return
      this.isActive = false
      await this.closeNative()
    })
  }
  private async closeNative(): Promise<void> {
    this.nativeStateUnknown = true
    if (!await this.bridge.audioControl(false)) throw new Error('The Even app did not confirm microphone release. Close and reopen Agents before trying again; do not keep pressing Retry.')
    this.nativeStateUnknown = false
  }
}
