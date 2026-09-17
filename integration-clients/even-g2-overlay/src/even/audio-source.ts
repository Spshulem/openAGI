import { AudioInputSource, type EvenAppBridge } from '@evenrealities/even_hub_sdk'

export interface AudioSource {
  start(onPcm: (pcm: Uint8Array) => void): Promise<void>
  stop(): Promise<void>
  readonly active: boolean
}

export class EvenAudioSource implements AudioSource {
  private unsubscribe: (() => void) | null = null
  private isActive = false

  constructor(private readonly bridge: EvenAppBridge) {}

  async start(onPcm: (pcm: Uint8Array) => void): Promise<void> {
    if (this.isActive) throw new Error('G2 microphone is already active')
    this.unsubscribe = this.bridge.onEvenHubEvent(event => {
      const pcm = event.audioEvent?.audioPcm
      if (pcm && this.isActive) onPcm(pcm)
    })
    const opened = await this.bridge.audioControl(true, AudioInputSource.Glasses)
    if (!opened) {
      this.unsubscribe()
      this.unsubscribe = null
      throw new Error('G2 microphone permission or connection is unavailable')
    }
    this.isActive = true
  }

  async stop(): Promise<void> {
    this.isActive = false
    this.unsubscribe?.()
    this.unsubscribe = null
    await this.bridge.audioControl(false)
  }

  get active(): boolean { return this.isActive }
}
