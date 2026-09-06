import type { DisplaySurface } from '../even/display-controller'

export class OpenAGIGlassesRenderer {
  private sleeping = false
  private latest: [string, boolean] = ['', false]
  constructor(private readonly surface: DisplaySurface) {}
  private show(text: string, reset: boolean): void {
    this.latest = [text, reset]
    if (!this.sleeping) this.surface.show(text, reset)
  }
  sleep(value: boolean): void {
    this.sleeping = value
    // Retain the native page and its gestures; this is not hardware power-off.
    this.surface.show(...(value ? [' ', false] as [string, boolean] : this.latest))
  }
  transcript(text: string, ambient: boolean): void { this.show(`LIVE SPEECH${ambient ? ' · wake listening' : ''}\n\n${tail(text, 260)}\n\n${ambient ? 'Tap: pause listening' : 'Tap: stop and send'}`, false) }
  unpaired(): void { this.show('Agents\n\nPair or add an agent\nfrom the phone screen.', true) }
  pairing(): void { this.show('Agents\n\nPair OpenAGI or add\nan agent URL + token\non the phone screen.', true) }
  home(device?: string): void { this.show(`Agent${device ? ` · ${device}` : ''}\n\nTap to ask / follow up\nin this conversation.\n\nSwipe or double-tap: Recent`, true) }
  recent(question: string, position: number, total: number): void { this.show(`Recent answers · ${position}/${total}\n\n${question.slice(0, 220)}\n\nSwipe: choose · Tap: open\nDouble-tap: back`, true) }
  ambient(wakePhrase: string): void { this.show(`AGENT · ALWAYS LISTENING\n\nSay “${wakePhrase}” then ask.\nTap to pause.\n\nForeground only`, true) }
  listening(): void { this.show('Ask agent\n\nListening…\n\nTap when finished.\nMaximum 30 seconds.', true) }
  thinking(question?: string): void { this.show(`Ask agent\n\n${question ? tail(question, 300) : 'Transcribing your question…'}\n\nThinking…`, true) }
  progress(stage: string, detail: string, partial = ''): void {
    this.show(`${stage.slice(0, 65)}\n${detail}\n\n${partial || 'No public answer text yet.'}\n\nSwipe to read · Cancel on phone`, false)
  }
  answer(page: string, pageIndex: number, pages: number): void { this.show(`Agent\n\n${page}\n\n${pageIndex + 1}/${pages} · swipe pages\nTap: follow up · Double-tap: back`, true) }
  message(title: string, detail: string): void { this.show(`${title}\n\n${tail(detail, 420)}\n\nTap to continue`, true) }
}

function tail(text: string, max: number): string { return text.length <= max ? text : `…${text.slice(-(max - 1))}` }
