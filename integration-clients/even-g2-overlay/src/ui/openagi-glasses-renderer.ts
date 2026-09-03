import type { DisplaySurface } from '../even/display-controller'

export class OpenAGIGlassesRenderer {
  constructor(private readonly surface: DisplaySurface) {}
  unpaired(): void { this.surface.show('OpenAGI\n\nPair this G2 from\nthe phone screen.\n\nDouble-tap to exit', true) }
  pairing(): void { this.surface.show('OpenAGI\n\nEnter the 6-digit code\nshown in OpenAGI\non the phone screen.', true) }
  home(device?: string): void { this.surface.show(`OpenAGI${device ? ` · ${device}` : ''}\n\nTap to ask a question.\nYour answer appears here.\n\nDouble-tap to exit`, true) }
  listening(): void { this.surface.show('Ask OpenAGI\n\nListening…\n\nTap when finished.\nMaximum 30 seconds.', true) }
  thinking(question?: string): void { this.surface.show(`Ask OpenAGI\n\n${question ? tail(question, 300) : 'Transcribing your question…'}\n\nThinking…`, true) }
  answer(page: string, pageIndex: number, pages: number): void { this.surface.show(`OpenAGI\n\n${tail(page, 400)}\n\n${pageIndex + 1}/${pages} · swipe pages · tap home`, true) }
  message(title: string, detail: string): void { this.surface.show(`${title}\n\n${tail(detail, 420)}\n\nTap to continue`, true) }
}

function tail(text: string, max: number): string { return text.length <= max ? text : `…${text.slice(-(max - 1))}` }
