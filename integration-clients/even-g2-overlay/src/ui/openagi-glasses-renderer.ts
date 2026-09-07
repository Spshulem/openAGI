import type { DisplaySurface } from '../even/display-controller'

export class OpenAGIGlassesRenderer {
  private sleeping = false
  private sendOnStop = true
  private memoryActive = false
  private pendingInbox = 0
  private pulse = 0
  passive(retaining: boolean, wake: boolean, phrase: string): void {
    const dots = '.'.repeat(this.pulse++ % 3 + 1)
    this.show(retaining && !wake ? `Listening ${dots}` : `Listening ${dots}\n\n${wake ? `Say “${phrase}” or tap to ask` : 'Tap to ask'}`, false)
  }
  inboxCount(count: number): void { this.pendingInbox = count }
  memory(active: boolean): void { this.memoryActive = active }
  autoSend(enabled: boolean): void { this.sendOnStop = enabled }
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
  transcript(text: string, ambient: boolean): void { this.show(`LIVE SPEECH${ambient ? this.memoryActive ? ' · memory ON' : ' · wake listening' : ''}\n\n${tail(text, 260)}\n\n${ambient ? 'Tap: pause listening' : this.sendOnStop ? 'Tap: stop and send' : 'Tap: stop and review'}`, false) }
  unpaired(): void { this.show('Agents\n\nPair or add an agent\nfrom the phone screen.', true) }
  pairing(): void { this.show('Agents\n\nPair OpenAGI or add\nan agent URL + token\non the phone screen.', true) }
  home(device?: string): void { this.show(`Agent${device ? ` · ${device}` : ''}\n\nTap to ask / follow up\nin this conversation.\n\n${this.pendingInbox ? `Swipe up: Inbox (${this.pendingInbox})\nSwipe down / double-tap: Recent` : 'Swipe or double-tap: Recent'}`, true) }
  recent(question: string, position: number, total: number): void { this.show(`Recent answers · ${position}/${total}\n\n${question.slice(0, 220)}\n\nSwipe: choose · Tap: open\nDouble-tap: back`, true) }
  inbox(text: string, item: number, total: number, page: number, pages: number): void {
    this.show(`Inbox ${item}/${total}\n\n${text}\n\nPage ${page}/${pages} · Swipe: read\nTap: actions · Double-tap: list`, true)
  }
  inboxList(title: string, item: number, total: number): void { this.show(`Inbox ${item}/${total}\n\n${title.slice(0, 180)}\n\nSwipe: choose · Tap: open\nDouble-tap: back`, true) }
  notice(label: string, title: string): void { this.show(`${label}\n\n${title.slice(0, 150)}`, false) }
  inboxAction(label: string, title: string, confirming = false): void { this.show(`${confirming ? 'Confirm: ' : ''}${label}\n\n${title.slice(0, 160)}\n\n${confirming ? 'Tap: confirm · Double-tap: cancel' : 'Swipe: choose action · Tap: select\nDouble-tap: details'}`, true) }
  ambient(wakePhrase: string): void { this.show(`AGENT · ALWAYS LISTENING${this.memoryActive ? ' · MEMORY ON' : ''}\n\nSay “${wakePhrase}” then ask.\nTap to pause.\n\nForeground only`, true) }
  listening(): void { this.show(`Ask agent\n\nListening…\n\n${this.sendOnStop ? 'Tap: stop and send' : 'Tap: stop and review'}\nMaximum 30 seconds.`, true) }
  thinking(question?: string): void { this.show(`Ask agent\n\n${question ? tail(question, 300) : 'Transcribing your question…'}\n\nThinking…`, true) }
  review(text: string, page: number, pages: number): void {
    this.show(`Review question · not sent\n\n${text}\n\n${page + 1}/${pages} · Swipe to read\nTap: send · Double-tap: discard`, true)
  }
  confirmCancel(): void {
    this.show('Stop this request?\n\nCompleted actions cannot be undone.\n\nTap: stop request\nDouble-tap: keep waiting', true)
  }
  progress(stage: string, detail: string, partial = '', activity = ''): void {
    const content = partial || `\n${stage.slice(0, 58)}\n\n${activity || 'Waiting for the next update…'}`
    this.show(`Agent · ${detail.split(' · ')[0]}\n${content}\n\nSwipe: read · Tap: text/activity\nDouble-tap: stop? · Cancel on phone`, false)
  }
  answer(page: string, pageIndex: number, pages: number): void { this.show(`Agent\n\n${page}\n\n${pageIndex + 1}/${pages} · swipe pages\nTap: follow up · Double-tap: back`, true) }
  message(title: string, detail: string): void { this.show(`${title}\n\n${tail(detail, 420)}\n\nTap to continue`, true) }
}

function tail(text: string, max: number): string { return text.length <= max ? text : `…${text.slice(-(max - 1))}` }
