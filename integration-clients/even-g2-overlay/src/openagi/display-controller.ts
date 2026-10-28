import { CreateStartUpPageContainer, StartUpPageCreateResult, TextContainerProperty, TextContainerUpgrade, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { DisplaySurface } from '../even/display-controller'

export type G2DisplayPhase = 'listening' | 'thinking' | 'checking' | 'paused'
export interface AgentsDisplaySurface extends DisplaySurface {
  show(content: string, immediate?: boolean, phase?: boolean | G2DisplayPhase): void
  requestExit(): Promise<boolean>
}

// Keep the original full-screen gesture owner. The indicator never captures input.
export class AgentsDisplayController implements AgentsDisplaySurface {
  private initialized = false
  private pending: { content: string; phase: G2DisplayPhase | null } = { content: '', phase: null }
  private lastContent = ''
  private lastIndicator = ' '
  private timer: ReturnType<typeof setTimeout> | null = null
  private rendering = false

  private pulse = 0
  constructor(private readonly bridge: EvenAppBridge, private readonly debounceMs = 160, private readonly now = () => new Date()) {}

  requestExit(): Promise<boolean> {
    // Mode 1 asks Even to show its native exit confirmation, not an immediate exit.
    return this.bridge.shutDownPageContainer(1)
  }

  async initialize(content: string): Promise<void> {
    const result = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
      containerTotalNum: 2,
      textObject: [
        new TextContainerProperty({ xPosition: 0, yPosition: 40, width: 576, height: 248,
          borderWidth: 0, borderColor: 5, paddingLength: 4, containerID: 1,
          containerName: 'buildbetter', content, isEventCapture: 1 }),
        new TextContainerProperty({ xPosition: 312, yPosition: 4, width: 260, height: 32,
          borderWidth: 0, borderColor: 5, paddingLength: 0, containerID: 2,
          containerName: 'status', content: ' ', isEventCapture: 0 }),
      ],
    }))
    if (result !== StartUpPageCreateResult.success) throw new Error(`Could not create G2 display (${result})`)
    this.initialized = true
    this.lastContent = content
    this.pending = { content, phase: null }
  }

  show(content: string, immediate = false, phase: boolean | G2DisplayPhase = false): void {
    this.pending = { content: content.slice(0, 500), phase: phase === true ? 'listening' : phase || null }
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
        if (!target.phase && this.lastIndicator !== ' ') {
          if (!await this.update(2, 'status', ' ')) return
          this.lastIndicator = ' '
        }
        if (target !== this.pending) continue
        if (target.content !== this.lastContent) {
          if (!await this.update(1, 'buildbetter', target.content)) return
          this.lastContent = target.content
        }
        if (target !== this.pending) continue
        if (target.phase) {
          const time = this.now().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
          const label = { listening: 'Listening', thinking: 'Thinking', checking: 'Checking', paused: 'Paused' }[target.phase]
          const indicator = `${time}  ${label}${target.phase === 'paused' ? '' : '.'.repeat(this.pulse++ % 3 + 1)}`
          if (indicator !== this.lastIndicator) {
            if (!await this.update(2, 'status', indicator)) return
            this.lastIndicator = indicator
          }
        }
        if (target === this.pending) return
      }
    } catch {
      // Leave the last successful state intact; a later render can retry.
      console.warn('G2 display update failed')
    } finally { this.rendering = false }
  }
}
