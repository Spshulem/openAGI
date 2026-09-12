import { CreateStartUpPageContainer, StartUpPageCreateResult, TextContainerProperty, TextContainerUpgrade, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { DisplaySurface } from '../even/display-controller'

export interface AgentsDisplaySurface extends DisplaySurface {
  show(content: string, immediate?: boolean, recording?: boolean): void
}

// Keep the original full-screen gesture owner. The indicator never captures input.
export class AgentsDisplayController implements AgentsDisplaySurface {
  private initialized = false
  private pending = { content: '', recording: false }
  private lastContent = ''
  private lastIndicator = ' '
  private timer: ReturnType<typeof setTimeout> | null = null
  private rendering = false

  constructor(private readonly bridge: EvenAppBridge, private readonly debounceMs = 160) {}

  async initialize(content: string): Promise<void> {
    const result = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
      containerTotalNum: 2,
      textObject: [
        new TextContainerProperty({ xPosition: 0, yPosition: 0, width: 576, height: 288,
          borderWidth: 0, borderColor: 5, paddingLength: 4, containerID: 1,
          containerName: 'buildbetter', content, isEventCapture: 1 }),
        new TextContainerProperty({ xPosition: 540, yPosition: 4, width: 32, height: 32,
          borderWidth: 0, borderColor: 5, paddingLength: 0, containerID: 2,
          containerName: 'recording', content: ' ', isEventCapture: 0 }),
      ],
    }))
    if (result !== StartUpPageCreateResult.success) throw new Error(`Could not create G2 display (${result})`)
    this.initialized = true
    this.lastContent = content
    this.pending = { content, recording: false }
  }

  show(content: string, immediate = false, recording = false): void {
    this.pending = { content: recording ? ' ' : content.slice(0, 500), recording }
    if (!this.initialized) return
    if (immediate) {
      if (this.timer !== null) clearTimeout(this.timer)
      this.timer = null
      void this.render()
    } else if (this.timer === null && !this.rendering) {
      this.timer = setTimeout(() => { this.timer = null; void this.render() }, this.debounceMs)
    }
  }

  private async update(id: number, name: string, content: string): Promise<boolean> {
    return Boolean(await this.bridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID: id, containerName: name, content,
    })))
  }

  private async render(): Promise<void> {
    if (this.rendering) return
    this.rendering = true
    try {
      for (;;) {
        const target = this.pending
        // Remove the dot before displaying a pause, answer, or sleeping screen.
        if (!target.recording && this.lastIndicator !== ' ') {
          if (!await this.update(2, 'recording', ' ')) return
          this.lastIndicator = ' '
        }
        if (target !== this.pending) continue
        if (target.content !== this.lastContent) {
          if (!await this.update(1, 'buildbetter', target.content)) return
          this.lastContent = target.content
        }
        if (target !== this.pending) continue
        if (target.recording && this.lastIndicator !== '●') {
          if (!await this.update(2, 'recording', '●')) return
          this.lastIndicator = '●'
        }
        if (target === this.pending) return
      }
    } catch {
      // Leave the last successful state intact; a later render can retry.
      console.warn('G2 display update failed')
    } finally { this.rendering = false }
  }
}
