import {
  CreateStartUpPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
  StartUpPageCreateResult,
} from '@evenrealities/even_hub_sdk'

export interface DisplaySurface {
  initialize(content: string): Promise<void>
  show(content: string, immediate?: boolean): void
}

export class EvenDisplayController implements DisplaySurface {
  private last = ''
  private pending = ''
  private timer: number | null = null
  private initialized = false

  constructor(private readonly bridge: EvenAppBridge, private readonly debounceMs = 160) {}

  async initialize(content: string): Promise<void> {
    const result = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
      containerTotalNum: 1,
      textObject: [new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        borderWidth: 0,
        borderColor: 5,
        paddingLength: 4,
        containerID: 1,
        containerName: 'buildbetter',
        content,
        isEventCapture: 1,
      })],
    }))
    if (result !== StartUpPageCreateResult.success) throw new Error(`Could not create G2 display (${result})`)
    this.initialized = true
    this.last = content
    this.pending = content
  }

  show(content: string, immediate = false): void {
    this.pending = content.slice(0, 500)
    if (!this.initialized || this.pending === this.last) return
    if (immediate) {
      if (this.timer !== null) window.clearTimeout(this.timer)
      this.timer = null
      void this.render()
      return
    }
    if (this.timer !== null) return
    this.timer = window.setTimeout(() => { this.timer = null; void this.render() }, this.debounceMs)
  }

  private async render(): Promise<void> {
    if (this.pending === this.last) return
    const content = this.pending
    const updated = await this.bridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID: 1,
      containerName: 'buildbetter',
      content,
    }))
    if (updated) this.last = content
  }
}
