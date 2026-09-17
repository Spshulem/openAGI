import type { AgentsDisplaySurface } from '../openagi/display-controller'

export class OpenAGIGlassesRenderer {
  private sleeping = false
  private sendOnStop = true
  private memoryActive = false
  private pendingInbox = 0
  private pulse = 0
  private holding = false
  private holdFollowup = false
  followupHold(active: boolean): void { this.holdFollowup = active }
  holdToTalk(active: boolean): void { this.holding = active }
  private stopHint(): string { return this.holding ? this.sendOnStop ? 'Release: send' : 'Release: review' : this.sendOnStop ? 'Tap: stop and send' : 'Tap: stop and review' }
  passive(retaining: boolean, wake: boolean, phrase: string): void {
    const dots = '.'.repeat(this.pulse++ % 3 + 1)
    if (retaining && !wake) this.show('●', false, true)
    else this.show(`Listening ${dots}\n\n${wake ? `Say “${phrase}” or tap to ask` : 'Tap to ask'}`, false)
  }
  paused(lifelog: boolean, confirm = false): void {
    this.show(confirm
      ? 'Resume lifelog?\n\nI have consent to save this conversation,\nincluding from other participants.\n\nTap: confirm and resume\nDouble-tap: cancel'
      : `${lifelog ? 'Lifelog' : 'Listening'} paused\n\nMicrophone off\n\nTap: resume · Double-tap: back`, true)
  }
  inboxCount(count: number): void { this.pendingInbox = count }
  memory(active: boolean): void { this.memoryActive = active }
  autoSend(enabled: boolean): void { this.sendOnStop = enabled }
  private latest: [string, boolean, boolean?] = ['', false]
  constructor(private readonly surface: AgentsDisplaySurface) {}
  requestExit(): Promise<boolean> { return this.surface.requestExit() }
  private show(text: string, reset: boolean, recording?: boolean): void {
    this.latest = recording ? [text, reset, true] : [text, reset]
    if (!this.sleeping) this.surface.show(...this.latest)
  }
  sleep(value: boolean): void {
    this.sleeping = value
    // Retain the native page and its gestures; this is not hardware power-off.
    this.surface.show(...(value ? [' ', false] as [string, boolean] : this.latest))
  }
  transcript(text: string, ambient: boolean): void { this.show(`LIVE SPEECH${ambient ? this.memoryActive ? ' · memory ON' : ' · wake listening' : ''}\n\n${tail(text, 260)}\n\n${ambient ? 'Double-tap: exit · Swipe down: controls' : this.stopHint()}`, false) }
  unpaired(): void { this.show('Agents\n\nPair or add an agent\nfrom the phone screen.\n\nDouble-tap: exit', true) }
  pairing(): void { this.show('Agents\n\nPair OpenAGI or add\nan agent URL + token\non the phone screen.', true) }
  home(device?: string): void { this.show(`Agent${device ? ` · ${device}` : ''}\n\nTap to ask / follow up\nin this conversation.\n\n${this.pendingInbox ? `Swipe up: Inbox (${this.pendingInbox})\nSwipe down: Recent` : 'Swipe: Recent'}\nDouble-tap: exit`, true) }
  recent(question: string, position: number, total: number): void { this.show(`Recent answers · ${position}/${total}\n\n${question.slice(0, 220)}\n\nSwipe: choose · Tap: open\nDouble-tap: back`, true) }
  inbox(text: string, item: number, total: number, page: number, pages: number): void {
    this.show(`Inbox ${item}/${total}\n\n${text}\n\nPage ${page}/${pages} · Swipe: read\nTap: actions · Double-tap: list`, true)
  }
  inboxList(title: string, item: number, total: number): void { this.show(`Inbox ${item}/${total}\n\n${title.slice(0, 180)}\n\nSwipe: choose · Tap: open\nDouble-tap: back`, true) }
  notice(label: string, title: string): void { this.show(`${label}\n\n${title.slice(0, 150)}`, false) }
  inboxAction(label: string, title: string, confirming = false): void { this.show(`${confirming ? 'Confirm: ' : ''}${label}\n\n${title.slice(0, 160)}\n\n${confirming ? 'Tap: confirm · Double-tap: cancel' : 'Swipe: choose action · Tap: select\nDouble-tap: details'}`, true) }
  ambient(wakePhrase: string): void { this.show(`AGENT · ALWAYS LISTENING${this.memoryActive ? ' · MEMORY ON' : ''}\n\nSay “${wakePhrase}” then ask.\nSwipe down: pause controls.\nDouble-tap: exit`, true) }
  listening(): void { this.show(`Ask agent\n\nListening…\n\n${this.stopHint()}\nMaximum 30 seconds.`, true) }
  thinking(question?: string): void { this.show(`Ask agent\n\n${question ? tail(question, 300) : 'Transcribing your question…'}\n\nThinking…`, true) }
  review(text: string, page: number, pages: number, recovery?: 'speech' | 'delivery'): void {
    const title = recovery === 'delivery' ? 'Delivery uncertain · may repeat actions' : recovery === 'speech' ? 'Recovered · check missing words · not sent' : 'Review question · not sent'
    this.show(`${title}\n\n${text}\n\n${page + 1}/${pages} · Swipe to read\nTap: ${recovery === 'delivery' ? 'send again' : 'send'} · Double-tap: back (keeps draft)`, true)
  }
  confirmCancel(): void {
    this.show('Stop this request?\n\nCompleted actions cannot be undone.\n\nTap: stop request\nDouble-tap: keep waiting', true)
  }
  progress(stage: string, detail: string, partial = '', activity = ''): void {
    const content = partial || `\n${stage.slice(0, 58)}\n\n${activity || 'Waiting for the next update…'}`
    this.show(`Agent · ${detail.split(' · ')[0]}\n${content}\n\nSwipe: read · Tap: text/activity\nDouble-tap: stop? · Cancel on phone`, false)
  }
  answer(page: string, pageIndex: number, pages: number): void { this.show(`Agent\n\n${page}\n\n${pageIndex + 1}/${pages} · swipe pages\n${this.holdFollowup ? 'Hold' : 'Tap'}: follow up · Double-tap: back`, true) }
  message(title: string, detail: string): void { this.show(`${title}\n\n${tail(detail, 420)}\n\nTap to continue`, true) }
}

function tail(text: string, max: number): string { return text.length <= max ? text : `…${text.slice(-(max - 1))}` }
