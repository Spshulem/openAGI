import type { AgentsDisplaySurface } from '../openagi/display-controller'

export type LifelogHomeState = 'off' | 'consent' | 'starting' | 'listening' | 'paused' | 'waiting'

export class OpenAGIGlassesRenderer {
  private sleeping = false
  private sendOnStop = true
  private pendingInbox = 0
  private who = 'Agent'
  private flashTimer: ReturnType<typeof setTimeout> | undefined
  private stopHint(): string { return this.sendOnStop ? 'Tap: stop and send' : 'Tap: stop and review' }
  private inboxLine(): string { return this.pendingInbox ? `Swipe up: Inbox (${this.pendingInbox})\n` : '' }
  // Retained lifelog stays minimal: only the recording dot.
  passive(retaining: boolean): void {
    if (retaining) this.show('●', false, true)
    else this.show('Lifelog\n\nListening…\n\nTap: talk to agent', false)
  }
  inboxCount(count: number): void { this.pendingInbox = count }
  autoSend(enabled: boolean): void { this.sendOnStop = enabled }
  /** Who answers in this mode: the agent, or the supervisor. */
  speaker(name: string): void { this.who = name }
  private latest: [string, boolean, boolean?] = ['', false]
  constructor(private readonly surface: AgentsDisplaySurface) {}
  requestExit(): Promise<boolean> { return this.surface.requestExit() }
  private show(text: string, reset: boolean, recording?: boolean): void {
    clearTimeout(this.flashTimer); this.flashTimer = undefined
    this.latest = recording ? [text, reset, true] : [text, reset]
    if (!this.sleeping) this.surface.show(...this.latest)
  }
  sleep(value: boolean): void {
    this.sleeping = value
    // Retain the native page and its gestures; this is not hardware power-off.
    this.surface.show(...(value ? [' ', false] as [string, boolean] : this.latest))
  }
  /** A short notice for an ignored gesture; the previous screen comes back. */
  flash(title: string, detail: string, ms = 2500): void {
    const previous = this.latest
    this.show(`${title}\n\n${tail(detail, 200)}`, true)
    const shown = this.latest
    this.flashTimer = setTimeout(() => {
      this.flashTimer = undefined
      if (this.latest !== shown) return
      this.latest = previous
      if (!this.sleeping) this.surface.show(...previous)
    }, ms)
  }
  transcript(text: string): void { this.show(`LIVE SPEECH\n\n${tail(text, 260)}\n\n${this.stopHint()}`, false) }
  unpaired(): void { this.show('Agents\n\nPair or add an agent\nfrom the phone screen.\n\nDouble-tap: exit', true) }
  pairing(): void { this.show('Agents\n\nPair OpenAGI or add\nan agent URL + token\non the phone screen.', true) }
  supervisorHome(questions: number): void { this.show(`Supervisor\n\nTap: ${questions ? `${questions} question${questions === 1 ? '' : 's'} for you` : 'thread status'}\nHold: talk, let go to send\nSwipe down: thread status\n${this.inboxLine()}Double-tap: exit`, true) }
  home(device?: string): void { this.show(`Talk${device ? ` · ${device}` : ''}\n\nTap: talk to agent\nTap again: ${this.sendOnStop ? 'send' : 'review'}\n\n${this.inboxLine()}Swipe down: Recent\nDouble-tap: exit`, true) }
  lifelogHome(state: LifelogHomeState, detail = ''): void {
    const title = state === 'consent' ? 'Lifelog · needs consent' : state === 'paused' ? 'Lifelog paused' : state === 'waiting' ? 'Lifelog · waiting' : 'Lifelog · starting'
    const body = state === 'consent' ? 'Give recording consent once\nin Agents on the phone.'
      : state === 'paused' ? 'Microphone off. Consent stays on.'
        : state === 'waiting' ? tail(detail || 'Resumes automatically.', 140) : 'Opening the microphone…'
    this.show(`${title}\n\n${body}\n\nTap: talk to agent\n${state === 'paused' ? 'Swipe down: resume' : 'Swipe down: controls'}\n${this.inboxLine()}Double-tap: exit`, true)
  }
  recent(question: string, position: number, total: number): void { this.show(`Recent · ${position}/${total}\n\n${question.slice(0, 220)}\n\nSwipe: choose · Tap: open\nDouble-tap: back`, true) }
  inbox(text: string, item: number, total: number, page: number, pages: number): void {
    this.show(`Inbox ${item}/${total}\n\n${text}\n\nPage ${page}/${pages} · Swipe: read\nTap: actions · Double-tap: list`, true)
  }
  inboxList(title: string, item: number, total: number): void { this.show(`Inbox ${item}/${total}\n\n${title.slice(0, 180)}\n\nSwipe: choose · Tap: open\nDouble-tap: back`, true) }
  notice(label: string, title: string): void { this.show(`${label}\n\n${title.slice(0, 150)}`, false) }
  inboxAction(label: string, title: string, confirming = false): void { this.show(`${confirming ? 'Confirm: ' : ''}${label}\n\n${title.slice(0, 160)}\n\n${confirming ? 'Tap: confirm · Double-tap: cancel' : 'Swipe: choose · Tap: select\nDouble-tap: back'}`, true) }
  listening(): void { this.show(`${this.who}\n\nListening…\n\n${this.stopHint()}\nMaximum 30 seconds.`, true) }
  thinking(question?: string): void { this.show(`${this.who}\n\n${question ? tail(question, 300) : 'Transcribing your question…'}\n\nThinking…`, true) }
  review(text: string, page: number, pages: number, recovery?: 'speech' | 'delivery'): void {
    const title = recovery === 'delivery' ? 'Delivery uncertain · may repeat actions' : recovery === 'speech' ? 'Recovered · check missing words · not sent' : 'Review question · not sent'
    this.show(`${title}\n\n${text}\n\n${page + 1}/${pages} · Swipe to read\nTap: ${recovery === 'delivery' ? 'send again' : 'send'} · Double-tap: back (keeps draft)`, true)
  }
  confirmCancel(): void {
    this.show('Stop this request?\n\nCompleted actions cannot be undone.\n\nTap: stop request\nDouble-tap: keep waiting', true)
  }
  progress(stage: string, detail: string, partial = '', activity = ''): void {
    const content = partial || `\n${stage.slice(0, 58)}\n\n${activity || 'Waiting for the next update…'}`
    this.show(`${this.who} · ${detail.split(' · ')[0]}\n${content}\n\nSwipe: read · Tap: text/activity\nDouble-tap: stop? · Cancel on phone`, false)
  }
  fleetStatus(page: string, pageIndex: number, pages: number): void { this.show(`Supervisor status\n\n${page}\n\n${pageIndex + 1}/${pages} · swipe pages\nTap: talk to supervisor\nDouble-tap: back`, true) }
  answer(page: string, pageIndex: number, pages: number): void { this.show(`${this.who}\n\n${page}\n\n${pageIndex + 1}/${pages} · swipe pages\nTap: follow up · Double-tap: back`, true) }
  message(title: string, detail: string): void { this.show(`${title}\n\n${tail(detail, 420)}\n\nTap to continue`, true) }
}

function tail(text: string, max: number): string { return text.length <= max ? text : `…${text.slice(-(max - 1))}` }
