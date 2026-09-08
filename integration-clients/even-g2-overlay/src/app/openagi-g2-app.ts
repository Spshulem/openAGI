import type { AudioSource } from '../even/audio-source'
import { QuestionAudioBuffer } from '../buildbetter/question-audio'
import { paginateText } from '../state/ask-state-machine'
import type { OpenAGIApiClient } from '../openagi/api-client'
import { AgentOriginSchema, OpenAGIApiError, safeOpenAGIError } from '../openagi/config'
import { AmbientAudioSegmenter } from '../openagi/ambient-listener'
import { progressDetail, progressLabel } from '../openagi/progress'
import { plainAnswer } from '../openagi/answer-format'
import { LiveSpeech, SpeechStreamError, speechTrigger, type SpeechModel, type SpeechCallbacks } from '../openagi/live-speech'
import type { OpenAGIStore } from '../openagi/store'
import type { OpenAGIGlassesRenderer } from '../ui/openagi-glasses-renderer'
import type { OpenAGIPhoneCompanion } from '../ui/openagi-phone-companion'
import { G2ProactiveClient, type InboxItem } from '../openagi/proactive'

type Mode = 'unpaired' | 'pairing' | 'home' | 'recent' | 'inbox' | 'inbox-detail' | 'inbox-action' | 'inbox-confirm' | 'ambient' | 'reconnecting' | 'paused' | 'resume-consent' | 'listening' | 'review' | 'thinking' | 'answer' | 'message'

export class OpenAGIG2App {
  readonly proactive: G2ProactiveClient
  private inboxIndex = 0
  private inboxItems: InboxItem[] = []
  private noticeTimer: ReturnType<typeof setTimeout> | null = null
  private actionIndex = 0
  private actionTarget: InboxItem | null = null
  private voiceTarget: InboxItem | null = null
  private clearNotice(): void { if (this.noticeTimer) clearTimeout(this.noticeTimer); this.noticeTimer = null }
  private showNotice(item: InboxItem): void {
    this.clearNotice()
    const label = item.reminder ? 'Reminder suggested' : /^Follow up:/i.test(item.title) ? 'Follow-up suggested' : item.category === 'memory' ? 'Action identified' : 'Update from main'
    this.renderer.notice?.(label, plainAnswer(item.title))
    this.noticeTimer = setTimeout(() => { this.noticeTimer = null; if (['home', 'ambient'].includes(this.mode) && this.foregroundActive && !this.exited) this.showHome() }, 4500)
  }
  private mode: Mode = 'unpaired'
  private audioBuffer: QuestionAudioBuffer | null = null
  private pages: string[] = []
  private page = 0
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private ambientRunning = false
  private memoryRequest = 0
  private pausedLifelog = false
  private heldQuestion: { ready: boolean; cancelled: boolean; released: boolean } | null = null
  private recoveringSpeech = false
  private recoveryEpoch = 0
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined
  private recoveryAttempts: number[] = []
  private recoveryFailure: Error | null = null
  private discardRecoveryUtterance = false
  private cancelSpeechRecovery(): void { this.recoveryEpoch++; clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined; this.recoveringSpeech = false }
  private resumeAfterAsk = false
  private lastListeningPulse = 0
  private foregroundActive = true
  private lifelogRequest = 0
  private onVisibility = (): void => { this.setForeground(document.visibilityState !== 'hidden') }
  setForeground(active: boolean): void {
    if (!active && this.proactive.memoryActive) this.pausedLifelog = true
    this.foregroundActive = active; this.proactive.setForeground(active)
    if (active && this.pausedLifelog && this.mode === 'home') this.showPaused()
    if (!active) {
      if (this.heldQuestion) {
        this.heldQuestion.cancelled = true
        if (this.heldQuestion.ready) { this.heldQuestion = null; this.renderer.holdToTalk?.(false) }
      }
      this.clearNotice()
      this.renderer.message('Listening paused', 'App is not in the foreground. Resume on phone.')
      this.memoryRequest++; this.resumeAfterAsk = false; this.lifelogRequest++; this.voiceTarget = null
      this.audioBuffer = null
      if (this.preparingDraft) this.cancelRequest()
      this.stopLiveSpeech(); void this.stopAmbient()
      if (this.mode === 'ambient' || this.mode === 'listening' || (this.mode === 'thinking' && !this.requestController)) this.mode = 'home'
      this.phone.memoryStatus?.(false, 'Lifelog stopped when the app left the foreground. Start it again with current participant consent.')
    }
  }
  private ambientEpoch = 0
  private lastAmbientSpeechAt = Date.now()
  private ambientSegmenter: AmbientAudioSegmenter | null = null
  private ambientQueue: Blob[] = []
  private ambientProcessing = false
  private ambientArmedUntil = 0
  private microphoneOpening = false
  private ambientConfiguration: Promise<void> = Promise.resolve()
  private lastTapAt = -Infinity
  private requestController: AbortController | null = null
  private renderActiveProgress: (() => void) | null = null
  private recentIndex = 0
  private navigationBusy = false
  private exited = false
  private liveSpeech: LiveSpeech | null = null
  private speechStart: AbortController | null = null
  private liveCaptureTimer: ReturnType<typeof setTimeout> | undefined
  private displaySleeping = false
  private draft = ''
  private preparingDraft = false
  private cancelConfirmation = false
  private activityView = false
  private activityLines: string[] = []
  private activityOffset = 0
  constructor(
    private readonly api: OpenAGIApiClient,
    private readonly store: OpenAGIStore,
    private readonly audio: AudioSource,
    private readonly renderer: OpenAGIGlassesRenderer,
    private readonly phone: OpenAGIPhoneCompanion,
    private readonly allowedOrigins: string[],
    private readonly speechFactory: (callbacks: SpeechCallbacks) => LiveSpeech = callbacks => new LiveSpeech(callbacks),
  ) {
    this.proactive = new G2ProactiveClient(api, {
      proactiveSettings: settings => phone.proactiveSettings?.(settings),
      inbox: items => {
        phone.inbox?.(items); renderer.inboxCount?.(items.length)
        if (this.mode === 'home' && !this.noticeTimer) renderer.home(this.store.snapshot().node?.name)
        // Browsing keeps a stable snapshot. Reopen to see arrivals; main
        // revalidates the exact target before accepting any action.
      },
      activity: text => phone.activity?.(text),
      saveStatus: text => phone.saveStatus?.(text),
      memoryStatus: (active, detail) => { phone.memoryStatus?.(active, detail); renderer.memory?.(active); this.listeningPulse(true) },
    },
      () => (this.mode === 'home' || (this.mode === 'ambient' && !this.ambientProcessing && Date.now() - this.lastAmbientSpeechAt > 15_000)) && !this.noticeTimer && !this.exited && !this.navigationBusy && !this.microphoneOpening && !this.displaySleeping && !this.requestController,
      item => this.showNotice(item))
  }
  openInbox(id?: string): void {
    if (this.exited || this.navigationBusy || this.microphoneOpening || this.requestController || this.displaySleeping || ['listening', 'review', 'pairing'].includes(this.mode)) return
    this.clearNotice(); this.inboxItems = [...this.proactive.items]
    if (!this.inboxItems.length) { this.phone.set('Inbox empty', 'Enable proactive updates on the phone, then Refresh.'); return }
    this.inboxIndex = Math.max(0, this.inboxItems.findIndex(i => i.id === id)); this.showInboxItem()
  }
  private showInboxItem(): void {
    const item = this.inboxItems[this.inboxIndex]; if (!item) return
    this.mode = 'inbox'; this.pages = paginateText(plainAnswer(`${item.title}\n\n${item.summary}`), 220); this.page = 0
    this.renderer.inboxList?.(plainAnswer(item.title), this.inboxIndex + 1, this.inboxItems.length)
  }
  private showInboxPage(): void {
    this.renderer.inbox?.(this.pages[this.page] ?? '', this.inboxIndex + 1, this.inboxItems.length, this.page + 1, this.pages.length)
  }
  private inboxActions(): { label: string; op: 'talk' | 'dismiss' | 'snooze' | 'accept-task' | 'complete-task' | 'mark' }[] {
    const item = this.actionTarget
    return [{ label: 'Talk about this item', op: 'talk' },
      ...(item?.action === 'complete-task' ? [{ label: 'Complete task on main', op: 'complete-task' as const }] : []),
      ...(item?.action === 'accept-task' && !item.reminder ? [{ label: 'Add as my task', op: 'accept-task' as const }] : []),
      ...(item?.id ? [{ label: 'Dismiss alert only', op: 'dismiss' as const }, { label: 'Snooze alert 1 hour', op: 'snooze' as const }] : []),
      ...(this.proactive.memoryActive ? [{ label: 'Mark current moment', op: 'mark' as const }] : [])]
  }
  private showInboxAction(): void {
    this.renderer.inboxAction?.(this.inboxActions()[this.actionIndex]?.label ?? '', plainAnswer(this.actionTarget?.title ?? ''), this.mode === 'inbox-confirm')
  }
  private async chooseInboxAction(): Promise<void> {
    const target = this.actionTarget, action = this.inboxActions()[this.actionIndex]; if (!target || !action) return
    if (action.op === 'talk') { this.voiceTarget = target.id ? { ...target } : null; this.showHome(); await this.startAsk(); return }
    if (action.op === 'mark') { await this.markMoment(); return }
    if (this.mode !== 'inbox-confirm') { this.mode = 'inbox-confirm'; this.showInboxAction(); return }
    this.navigationBusy = true
    try {
      const ok = await this.proactive.action(action.op, target.id, { title: target.title, taskId: target.taskId, dueDate: target.dueDate })
      await this.resumeListening()
      if (this.exited || !this.foregroundActive) return
      this.mode = 'message'; this.renderer.message(ok ? 'Saved on main' : 'Action not confirmed', ok ? action.op === 'complete-task' ? 'Completed in OpenAGI. External source unchanged.' : action.label : 'Check Activity on phone. Nothing is assumed complete.')
    } finally { this.navigationBusy = false }
  }
  async markMoment(): Promise<void> {
    const ok = await this.proactive.markMoment()
    if (ok && ['ambient', 'home', 'inbox-action'].includes(this.mode) && this.foregroundActive && !this.exited) { this.showHome(); this.showNotice({ id: '', title: 'Moment marked on main', summary: '', category: 'highlight', action: '', important: false, seen: true }) }
  }
  async configureIdleTap(action: 'talk' | 'highlight'): Promise<void> {
    await this.store.update({ idleTapAction: action }); this.phone.idleTapAction?.(action)
  }
  async configureLifelogTalkMode(mode: 'tap' | 'hold'): Promise<void> {
    if (this.heldQuestion || this.microphoneOpening || this.requestController || ['listening', 'review'].includes(this.mode)) { this.phone.lifelogTalkMode?.(this.store.snapshot().lifelogTalkMode); return }
    await this.store.update({ lifelogTalkMode: mode }); this.phone.lifelogTalkMode?.(mode)
  }
  async holdStart(): Promise<void> {
    if (this.heldQuestion || this.store.snapshot().lifelogTalkMode !== 'hold' || !this.proactive.memoryActive || !this.ambientRunning || !['ambient', 'answer'].includes(this.mode) || this.exited || !this.foregroundActive || this.displaySleeping || this.navigationBusy || this.microphoneOpening || this.requestController) return
    const held = { ready: false, cancelled: false, released: false }
    this.heldQuestion = held; this.renderer.holdToTalk?.(true)
    try {
      await this.startAsk(true)
      if (this.mode !== 'listening' || held.cancelled || this.exited || !this.foregroundActive) { await this.cancelHold(true); return }
      held.ready = true
      clearTimeout(this.liveCaptureTimer)
      this.liveCaptureTimer = setTimeout(() => { void this.cancelHold() }, 30_000)
    } catch (error) { await this.cancelHold(true); if (!this.exited) this.fail(error) }
  }
  async holdRelease(): Promise<void> {
    const held = this.heldQuestion
    if (!held || held.released) return
    // Letting go during setup cancels, rather than recording after release.
    if (!held.ready) { held.cancelled = true; return }
    held.released = true
    try { await this.finishAsk() }
    finally { if (this.heldQuestion === held) this.heldQuestion = null; this.renderer.holdToTalk?.(false) }
  }
  async cancelHold(startupSettled = false): Promise<void> {
    const held = this.heldQuestion; if (!held) return
    held.cancelled = true
    if ((!held.ready && !startupSettled) || this.microphoneOpening) return // Startup owns cleanup once it settles.
    this.heldQuestion = null; this.renderer.holdToTalk?.(false)
    clearTimeout(this.liveCaptureTimer)
    if (this.mode === 'listening') {
      this.stopLiveSpeech(); await this.audio.stop().catch(() => undefined); this.audioBuffer = null
      if (!this.exited && this.foregroundActive) { this.showHome(); await this.resumeListening(); this.phone.set('Question not sent', 'Hold ended before capture was ready, was cancelled, or reached the 30-second limit. Lifelog resumes when available.') }
    }
  }
  async returnToLifelog(consent: boolean): Promise<void> {
    if (this.exited || !this.foregroundActive || document.visibilityState === 'hidden' || this.navigationBusy || this.requestController || this.microphoneOpening || ['review', 'listening', 'pairing'].includes(this.mode)) return
    if (this.proactive.memoryActive && this.ambientRunning) { this.showHome(); return }
    await this.configureMemory(true, consent)
  }
  async configureMemory(enabled: boolean, consent: boolean): Promise<void> {
    const request = ++this.memoryRequest
    if (!enabled || !consent) {
      if (this.recoveringSpeech) { this.cancelSpeechRecovery(); await this.stopAmbient(); this.showPaused() }
      this.phone.memoryPending?.(false); this.proactive.pauseMemory()
      if (enabled) this.phone.memoryStatus?.(false, 'Confirm participant consent above, then tap Return / resume lifelog.')
      return
    }
    if (!this.foregroundActive || document.visibilityState === 'hidden') { this.proactive.pauseMemory(); return }
    if (this.navigationBusy || this.requestController || this.microphoneOpening || ['review', 'listening', 'pairing'].includes(this.mode)) {
      this.phone.memoryStatus?.(false, 'Finish the current microphone operation, then start lifelog.'); return
    }
    if (this.proactive.memoryActive && this.ambientRunning) { this.showHome(); return }
    this.phone.memoryPending?.(true)
    this.phone.memoryStatus?.(false, 'Starting lifelog… opening the microphone, then requesting retention consent.')
    try {
      const startedHere = !this.ambientRunning
      if (startedHere) await this.configureAmbient(true, this.store.snapshot().wakePhrase, this.store.snapshot().answerQuestions)
      if (request !== this.memoryRequest || this.exited) {
        if (startedHere && this.ambientRunning) await this.configureAmbient(false, this.store.snapshot().wakePhrase, this.store.snapshot().answerQuestions)
        return
      }
      if (!this.ambientRunning) { this.phone.memoryStatus?.(false, 'Lifelog could not start: microphone unavailable. Check the connection, then retry.'); return }
      if (!this.proactive.memoryActive) await this.proactive.enableMemory(true)
      if (startedHere && !this.proactive.memoryActive) {
        await this.configureAmbient(false, this.store.snapshot().wakePhrase, this.store.snapshot().answerQuestions)
        this.phone.memoryStatus?.(false, 'Lifelog did not start. Microphone stopped because retention consent was not granted. Retry Start lifelog.')
      }
      if (this.proactive.memoryActive && this.ambientRunning && this.foregroundActive && !this.exited) { this.pausedLifelog = false; this.showHome() }
    } catch (error) { this.proactive.pauseMemory(`Could not start lifelog: ${safeOpenAGIError(error)}`) }
    finally { this.phone.memoryPending?.(false) }
  }
  async configureListeningMode(mode: 'passive' | 'wake'): Promise<void> {
    if (this.navigationBusy || this.requestController || this.microphoneOpening || ['review', 'listening'].includes(this.mode)) {
      this.phone.listeningMode?.(this.store.snapshot().listeningMode); return
    }
    const running = this.ambientRunning
    this.navigationBusy = true
    try {
      // Invalidate buffered work and close the live utterance before opt-in.
      // Retention consent survives the transport restart, but old speech cannot trigger.
      if (running) await this.stopAmbient(true)
      await this.store.update({ listeningMode: mode }); this.ambientArmedUntil = 0
      this.phone.listeningMode?.(mode)
      if (running) await this.startAmbient()
    } catch (error) { await this.pauseAmbientWithError(error) }
    finally { this.navigationBusy = false }
  }
  async readLifelog(query = '', offset = 0): Promise<void> {
    const request = ++this.lifelogRequest
    const state = this.store.snapshot()
    this.phone.lifelogStatus?.('Loading saved conversations from your main…')
    try {
      const result = await this.api.proactive({ op: 'lifelog', query: query.slice(0, 200), offset })
      if (this.exited || request !== this.lifelogRequest || state.agentOrigin !== this.store.snapshot().agentOrigin || state.nodeToken !== this.store.snapshot().nodeToken) return
      this.phone.lifelog?.(result)
    } catch (error) { if (request === this.lifelogRequest) this.phone.lifelogStatus?.(`Could not load lifelog: ${safeOpenAGIError(error)}`) }
  }
  private listeningPulse(force = false): void {
    if (this.mode !== 'ambient' || this.noticeTimer || this.displaySleeping || this.requestController || !this.ambientRunning) return
    if (!force && Date.now() - this.lastListeningPulse < 2000) return
    this.lastListeningPulse = Date.now()
    const state = this.store.snapshot()
    this.renderer.passive?.(this.proactive.memoryActive, state.listeningMode === 'wake', state.wakePhrase)
  }

  async boot(): Promise<void> {
    document.addEventListener('visibilitychange', this.onVisibility)
    const stored = await this.store.load()
    this.phone.listeningMode?.(stored.listeningMode)
    this.phone.idleTapAction?.(stored.idleTapAction)
    this.phone.lifelogTalkMode?.(stored.lifelogTalkMode)
    this.phone.speechModel?.(stored.speechModel)
    this.phone.speechTransport?.(stored.speechTransport)
    this.phone.autoSend?.(stored.autoSend)
    this.renderer.autoSend?.(stored.autoSend)
    if (stored.nodeToken) {
      try {
        if (stored.connectionMode === 'enrollment') {
          await this.heartbeatWithoutLosingEnrollment(stored.node?.name)
          this.startHeartbeat()
        }
        this.phone.ambient(stored.ambientEnabled, stored.wakePhrase, stored.answerQuestions)
        if (stored.ambientEnabled) {
          try { await this.startAmbient() }
          catch (error) { this.showHome(); this.phone.set('Always listening unavailable', safeOpenAGIError(error)) }
        } else {
          this.showHome()
          let index = -1
          stored.history.forEach((entry, position) => { if (entry.conversationId === stored.conversationId) index = position })
          if (index >= 0) await this.selectAnswer(index)
        }
        return
      }
      catch (error) {
        if (!(error instanceof OpenAGIApiError) || (error.status !== 401 && error.status !== 403)) throw error
        await this.store.clearCredential()
      }
    }
    this.showUnpaired()
  }
  tap(): void {
    if (this.recoveringSpeech) return
    if (this.heldQuestion && !this.heldQuestion.released) return
    if (this.displaySleeping) return
    if (this.exited || this.navigationBusy || this.microphoneOpening || Date.now() - this.lastTapAt < 400) return
    this.lastTapAt = Date.now()
    this.clearNotice()
    if (this.requestController) {
      if (this.cancelConfirmation) this.cancelRequest()
      else if (!this.preparingDraft) { this.activityView = !this.activityView; this.renderActiveProgress?.() }
      return
    }
    if (this.mode === 'paused') {
      if (this.pausedLifelog) { this.mode = 'resume-consent'; this.renderer.paused?.(true, true) }
      else void this.configureAmbient(true, this.store.snapshot().wakePhrase, this.store.snapshot().answerQuestions)
    }
    else if (this.mode === 'resume-consent') void this.configureMemory(true, true)
    else if (this.mode === 'review') void this.sendDraft()
    else if (this.mode === 'inbox') { this.mode = 'inbox-detail'; this.showInboxPage(); void this.proactive.action('seen', this.inboxItems[this.inboxIndex]?.id) }
    else if (this.mode === 'inbox-detail') { this.actionTarget = { ...this.inboxItems[this.inboxIndex] }; this.actionIndex = 0; this.mode = 'inbox-action'; this.showInboxAction() }
    else if (this.mode === 'inbox-action' || this.mode === 'inbox-confirm') void this.chooseInboxAction()
    else if (this.mode === 'home') void this.startAsk()
    else if (this.mode === 'listening') void this.finishAsk()
    else if (this.mode === 'ambient') { if (this.proactive.memoryActive && this.store.snapshot().idleTapAction === 'highlight') void this.markMoment(); else if (!(this.proactive.memoryActive && this.store.snapshot().lifelogTalkMode === 'hold')) void this.startAsk() }
    else if (this.mode === 'answer') { if (!(this.proactive.memoryActive && this.ambientRunning && this.store.snapshot().lifelogTalkMode === 'hold')) void this.startAsk() }
    else if (this.mode === 'recent') void this.selectAnswer(this.recentIndex).catch(error => this.fail(error))
    else if (this.mode === 'message') this.showHome()
    else if (this.mode === 'unpaired') this.renderer.pairing()
  }
  scrollUp(): void { this.movePage(-1) }
  scrollDown(): void { this.movePage(1) }
  private movePage(direction: number): void {
    if (this.exited || this.navigationBusy || this.displaySleeping) return
    this.clearNotice()
    if (this.mode === 'inbox') { this.inboxIndex = Math.max(0, Math.min(this.inboxItems.length - 1, this.inboxIndex - direction)); this.showInboxItem() }
    else if (this.mode === 'inbox-detail') { this.page = Math.max(0, Math.min(this.pages.length - 1, this.page + direction)); this.showInboxPage() }
    else if (this.mode === 'inbox-action') { this.actionIndex = Math.max(0, Math.min(this.inboxActions().length - 1, this.actionIndex - direction)); this.showInboxAction() }
    else if (this.mode === 'review') { this.page = Math.max(0, Math.min(this.pages.length - 1, this.page + direction)); this.showDraftPage() }
    else if (this.requestController) {
      if (this.activityView || !this.pages.length) this.activityOffset = Math.max(0, Math.min(Math.max(0, this.activityLines.length - 3), this.activityOffset - direction))
      else this.page = Math.max(0, Math.min(this.pages.length - 1, this.page + direction))
      this.renderActiveProgress?.()
    }
    else if (this.mode === 'answer') this.showAnswer(Math.max(0, Math.min(this.pages.length - 1, this.page + direction)))
    else if (this.mode === 'home' || this.mode === 'ambient') {
      if (direction < 0 && this.proactive.items.length) this.openInbox()
      else if (this.mode === 'ambient' && direction > 0) { this.actionTarget = { id: '', title: 'Listening controls', summary: '', category: '', important: false, seen: true, action: '' }; this.actionIndex = 0; this.mode = 'inbox-action'; this.showInboxAction() }
      else this.showRecent(this.store.snapshot().history.length - 1)
    }
    else if (this.mode === 'recent') this.showRecent(this.recentIndex - direction)
  }
  cancelRequest(): void { this.cancelConfirmation = false; this.requestController?.abort(); if (this.preparingDraft) this.stopLiveSpeech() }
  async discardDraft(): Promise<void> {
    if (this.mode !== 'review') return
    this.voiceTarget = null; this.draft = ''; this.phone.draft?.(null); this.showHome(); await this.resumeListening()
  }
  async rerecordDraft(): Promise<void> { if (this.mode !== 'review') return; await this.discardDraft(); await this.startAsk() }
  async sendDraft(): Promise<void> {
    if (this.mode !== 'review' || !this.draft || this.requestController) return
    const text = this.draft; this.draft = ''; this.phone.draft?.(null)
    await this.runQuestion(text)
  }
  private reviewDraft(text: string): void {
    const clean = text.trim()
    if (!clean) throw new Error('No speech was recognized. Nothing was sent; please retry.')
    if (clean.length > 4000) throw new Error('Question is too long. Nothing was sent; please record a shorter question.')
    this.draft = clean; this.mode = 'review'; this.pages = paginateText(plainAnswer(clean), 220); this.page = 0
    if (this.store.snapshot().autoSend) { this.phone.transcript?.(clean); return }
    this.phone.transcript?.(clean); this.phone.draft?.(clean)
    this.phone.set('Review question · not sent', 'Tap to send. Double-tap to discard. Swipe to read the whole transcript, or re-record on the phone.')
    this.showDraftPage()
  }
  private showDraftPage(): void { this.renderer.review?.(this.pages[this.page] ?? '', this.page, this.pages.length) }
  async recentAnswer(): Promise<void> { await this.selectAnswer(this.store.snapshot().history.length - 1) }
  doubleTap(): void {
    if (this.recoveringSpeech) { void this.configureAmbient(false, this.store.snapshot().wakePhrase, this.store.snapshot().answerQuestions); return }
    if (this.heldQuestion && !this.heldQuestion.released) { void this.cancelHold(); return }
    if (this.displaySleeping) { this.toggleDisplay(); return }
    void this.navigateBack().catch(error => this.fail(error))
  }
  toggleDisplay(): void {
    if (this.exited) return
    this.displaySleeping = !this.displaySleeping
    this.renderer.sleep?.(this.displaySleeping)
    this.phone.displaySleeping?.(this.displaySleeping)
  }
  private async navigateBack(): Promise<void> {
    if (this.exited || this.navigationBusy || this.microphoneOpening || this.mode === 'pairing') return
    this.lastTapAt = Date.now()
    this.clearNotice(); this.voiceTarget = null
    if (this.requestController) {
      this.cancelConfirmation = !this.cancelConfirmation
      if (this.cancelConfirmation) this.renderer.confirmCancel?.()
      else this.renderActiveProgress?.()
      return
    }
    if (this.mode === 'review') { await this.discardDraft(); return }
    if (this.mode === 'resume-consent') { this.showPaused(); return }
    if (this.mode === 'paused') { this.showHome(); return }
    if (this.mode === 'inbox-confirm') { this.mode = 'inbox-action'; this.showInboxAction(); await this.resumeListening(); return }
    if (this.mode === 'inbox-action') { if (!this.actionTarget?.id) this.showHome(); else { this.mode = 'inbox-detail'; this.showInboxPage() }; return }
    if (this.mode === 'inbox-detail') { this.showInboxItem(); return }
    if (this.mode === 'inbox') { this.showHome(); return }
    if (this.mode === 'ambient') {
      this.pausedLifelog = this.proactive.memoryActive
      await this.configureAmbient(false, this.store.snapshot().wakePhrase, this.store.snapshot().answerQuestions)
      if (!this.exited && this.foregroundActive && !this.ambientRunning) this.showPaused()
      return
    }
    if (this.mode === 'home') { this.showRecent(this.store.snapshot().history.length - 1); return }
    this.navigationBusy = true
    try {
      if (this.mode === 'listening') { this.stopLiveSpeech(); await this.audio.stop(); this.audioBuffer = null }
      this.showHome()
    } finally { this.navigationBusy = false }
    await this.resumeListening()
  }
  private showRecent(index: number): void {
    const history = this.store.snapshot().history
    if (!history.length) { this.showHome(); this.phone.set('No recent answers yet', 'Tap to ask your first question.'); return }
    this.recentIndex = Math.max(0, Math.min(history.length - 1, index))
    this.mode = 'recent'
    this.renderer.recent?.(plainAnswer(history[this.recentIndex].question), history.length - this.recentIndex, history.length)
  }
  async systemExit(): Promise<void> {
    this.cancelSpeechRecovery()
    this.clearNotice()
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.memoryRequest++; this.resumeAfterAsk = false
    this.proactive.stop()
    this.exited = true
    this.stopLiveSpeech()
    this.cancelRequest()
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    this.ambientRunning = false
    this.ambientSegmenter?.reset()
    await this.audio.stop().catch(() => undefined)
  }

  async pair(code: string, origin: string): Promise<void> {
    if (this.mode === 'pairing') return
    const parsed = AgentOriginSchema.safeParse(origin)
    if (!parsed.success || (this.allowedOrigins.length > 0 && !this.allowedOrigins.includes(parsed.data))) {
      this.phone.set('Check main server URL', 'Enter an allowed HTTPS origin for your OpenAGI main.'); return
    }
    const saved = this.store.snapshot()
    if (saved.node && saved.nodeToken && saved.connectionMode === 'enrollment' && saved.agentOrigin === parsed.data) {
      this.showHome(); return
    }
    this.mode = 'pairing'; this.renderer.pairing(); this.phone.set('Pairing G2…', 'Checking the one-time code with OpenAGI.')
    try {
      const state = this.store.snapshot()
      const sameMain = state.connectionMode === 'enrollment' && state.agentOrigin === parsed.data
      const nodeToken = sameMain && state.nodeToken ? state.nodeToken : createNodeToken()
      const nodeId = sameMain ? state.nodeId : crypto.randomUUID()
      // Persist the client-created credential before exchange. The exchange is
      // idempotent for this node id + token, so a lost HTTP response can be
      // retried without creating an unreachable credential on the server.
      await this.store.update({
        nodeId, nodeToken, node: null, conversationId: state.conversationId ?? crypto.randomUUID(),
        connectionMode: 'enrollment', agentOrigin: parsed.data,
      })
      let enrolled
      try { enrolled = await this.api.enroll(code, nodeId, nodeToken) }
      catch (error) {
        if (error instanceof OpenAGIApiError) throw error
        enrolled = await this.api.enroll(code, nodeId, nodeToken)
      }
      await this.store.update({
        nodeToken: enrolled.nodeToken, node: enrolled.node,
        connectionMode: 'enrollment', agentOrigin: parsed.data,
      })
      await this.heartbeatWithoutLosingEnrollment(enrolled.node.name)
      this.startHeartbeat()
      this.showHome()
    }
    catch (error) {
      // Preserve pending credentials across failed attempts: a prior response
      // may have been lost after the main committed the enrollment.
      this.mode = 'unpaired'; this.renderer.message('Could not pair G2', safeOpenAGIError(error)); this.phone.set('Pairing failed', safeOpenAGIError(error))
    }
  }
  async unlink(): Promise<void> {
    if (this.mode === 'review') { this.phone.set('Question not sent', 'Send or discard the transcript before disconnecting.'); return }
    if (this.mode === 'thinking' || this.mode === 'listening' || this.ambientProcessing) { this.phone.set('Question in progress', 'Wait for the current question before disconnecting.'); return }
    await this.stopAmbient()
    if (this.audio.active) await this.audio.stop().catch(() => undefined)
    if (this.store.snapshot().connectionMode === 'enrollment') {
      try { await this.api.unlink() }
      catch (error) {
        this.showHome()
        this.phone.set('Could not disconnect', `${safeOpenAGIError(error)} The credential is still saved; retry here or remove the node from OpenAGI.`)
        return
      }
    }
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    await this.store.clearCredential(); this.showUnpaired()
  }
  async newConversation(): Promise<void> {
    if (this.mode === 'review') return
    if (this.mode === 'thinking' || this.mode === 'listening' || this.mode === 'pairing' || this.ambientProcessing) return
    await this.store.update({ conversationId: crypto.randomUUID() }); this.pages = []; this.phone.preview?.(''); this.showHome(); this.phone.set('New conversation', 'Your next question starts a fresh agent chat.')
  }
  async selectAnswer(index: number): Promise<void> {
    if (this.mode === 'review') return
    if (this.mode === 'thinking' || this.mode === 'listening' || this.mode === 'pairing' || this.ambientProcessing) return
    const entry = this.store.snapshot().history[index]
    if (!entry) return
    await this.store.update({ conversationId: entry.conversationId })
    this.pages = paginateText(plainAnswer(entry.reply), 260); this.phone.paired(true); this.showAnswer(0)
    this.phone.history?.(this.store.snapshot().history); this.phone.preview?.(entry.reply)
    this.phone.set('Conversation resumed', `${entry.question} — Tap the glasses to ask a follow-up, or use Ask on the phone.`)
  }
  async connectAgent(origin: string, token: string): Promise<void> {
    if (this.requestController || this.mode === 'review' || this.mode === 'listening' || this.microphoneOpening) return
    let normalizedOrigin: string
    try { normalizedOrigin = AgentOriginSchema.parse(origin) } catch { this.phone.set('Could not add agent', 'Enter your main server HTTPS origin without a path or credentials.'); return }
    if (this.allowedOrigins.length > 0 && !this.allowedOrigins.includes(normalizedOrigin)) {
      this.phone.set('Agent URL not allowed', 'This package was not built with that exact origin. Repackage Agents with the origin included.')
      return
    }
    const cleanToken = token.trim()
    if (cleanToken.length < 16 || cleanToken.length > 4_096) {
      this.phone.set('Could not add agent', 'Paste a scoped bearer token between 16 and 4096 characters.')
      return
    }
    this.proactive.stop()
    await this.stopAmbient()
    await this.store.update({
      connectionMode: 'direct', agentOrigin: normalizedOrigin, nodeToken: cleanToken,
      node: null, conversationId: crypto.randomUUID(),
    })
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    this.showHome()
    this.phone.set('Agent connected', `G2 will use ${normalizedOrigin}. The token stays in this app's local storage.`)
  }
  async configureAmbient(enabled: boolean, wakePhrase: string, answerQuestions: boolean): Promise<void> {
    const next = this.ambientConfiguration.then(() => this.applyAmbientConfiguration(enabled, wakePhrase, answerQuestions))
    this.ambientConfiguration = next.catch(() => undefined)
    return next
  }
  private async applyAmbientConfiguration(enabled: boolean, wakePhrase: string, answerQuestions: boolean): Promise<void> {
    if (this.exited) return
    if (!enabled && this.recoveringSpeech) {
      this.pausedLifelog = this.proactive.memoryActive
      await this.stopAmbient(); await this.store.update({ ambientEnabled: false })
      this.phone.ambient(false, wakePhrase, answerQuestions); this.showPaused(); return
    }
    if (!enabled && this.requestController) {
      this.resumeAfterAsk = false
      await this.store.update({ ambientEnabled: false })
      await this.stopAmbient()
      this.phone.ambient(false, this.store.snapshot().wakePhrase, this.store.snapshot().answerQuestions)
      return
    }
    if (this.navigationBusy || this.microphoneOpening || this.mode === 'review' || this.mode === 'listening' || this.mode === 'thinking') {
      const state = this.store.snapshot()
      this.phone.ambient(state.ambientEnabled, state.wakePhrase, state.answerQuestions)
      this.phone.set('Microphone busy', 'Finish the current question before changing listening mode.')
      return
    }
    const cleanPhrase = wakePhrase.trim().slice(0, 40) || 'open agi'
    await this.store.update({ ambientEnabled: enabled, wakePhrase: cleanPhrase, answerQuestions })
    this.phone.ambient(enabled, cleanPhrase, answerQuestions)
    if (!this.store.snapshot().nodeToken) return
    if (!enabled) {
      this.resumeAfterAsk = false
      await this.stopAmbient()
      this.showHome()
      this.phone.set('Always listening paused', 'Tap Ask for push-to-talk, or enable always listening again.')
      return
    }
    try { await this.startAmbient() }
    catch (error) {
      await this.pauseAmbientWithError(error)
    }
  }
  async startAsk(fromHold = false): Promise<void> {
    if (this.recoveringSpeech) return
    if (this.heldQuestion && !fromHold) return
    if (this.exited || !this.foregroundActive || this.navigationBusy || this.microphoneOpening || this.requestController) return
    if (this.mode === 'review') { await this.sendDraft(); return }
    if (this.mode === 'listening') { await this.finishAsk(); return }
    this.clearNotice()
    if (this.mode.startsWith('inbox')) { const selected = this.mode === 'inbox-action' || this.mode === 'inbox-confirm' ? this.actionTarget : this.inboxItems[this.inboxIndex]; this.voiceTarget = selected?.id ? { ...selected } : null; this.showHome() }
    if (this.mode === 'message' || this.mode === 'answer' || this.mode === 'recent' || this.mode === 'paused' || this.mode === 'resume-consent') this.showHome()
    if (this.ambientRunning) {
      this.resumeAfterAsk = true
      await this.stopAmbient(true)
      this.showHome()
    }
    if (this.mode !== 'home' || !this.store.snapshot().nodeToken) return
    if (this.store.snapshot().speechModel !== 'openai-buffered') { await this.startLiveAsk(); return }
    this.mode = 'listening'; this.audioBuffer = new QuestionAudioBuffer(); this.renderer.progress?.('Opening microphone', this.heldQuestion ? 'Keep holding' : 'Please wait'); this.phone.set('Opening microphone…', 'Waiting for audio from your glasses. Keep the Even app open.')
    let displayedSecond = -1
    this.microphoneOpening = true
    try { await this.audio.start(pcm => {
      if (this.mode !== 'listening') return
      try {
        this.audioBuffer?.push(pcm)
        const duration = this.audioBuffer?.durationSeconds ?? 0
        if (duration > 0 && Math.floor(duration) !== displayedSecond) {
          displayedSecond = Math.floor(duration)
          this.phone.set('Recording question', `${duration.toFixed(1)} seconds received from G2. ${this.stopInstruction()}`)
        }
      } catch (error) { void this.audio.stop(); this.fail(error) }
    });
      if (this.exited || !this.foregroundActive) { await this.audio.stop(); this.audioBuffer = null }
      else if (this.mode === 'listening') this.renderer.listening()
    }
    catch (error) { this.fail(error) }
    finally { this.microphoneOpening = false }
    if (['message'].includes(this.mode)) await this.resumeListening()
  }
  async finishAsk(): Promise<void> {
    if (this.heldQuestion && !this.heldQuestion.released) { await this.cancelHold(); return }
    if (!this.microphoneOpening && this.mode === 'listening' && this.liveSpeech) {
      const speech = this.liveSpeech
      this.mode = 'thinking'; clearTimeout(this.liveCaptureTimer)
      const controller = new AbortController(); this.requestController = controller; this.preparingDraft = true
      this.phone.requestActive?.(true)
      this.renderActiveProgress = () => { if (!this.cancelConfirmation) this.renderer.progress?.('Finishing transcript', 'Not sent to agent') }
      this.renderActiveProgress()
      this.phone.set('Finishing live transcript', this.store.snapshot().autoSend ? 'Waiting for final words, then sending automatically.' : 'Waiting for final words. Review the text before sending it to the agent.')
      try {
        await this.audio.stop()
        const started = Date.now()
        const text = await speech.finish()
        if (this.exited || controller.signal.aborted || this.liveSpeech !== speech) return
        this.liveSpeech = null; this.speechStart = null
        if (!text) throw new Error('No speech was recognized. Your question was not sent; please retry.')
        this.phone.activity?.(`Speech finalized in ${Date.now() - started}ms`)
        this.reviewDraft(text)
      } catch (error) { this.stopLiveSpeech(); if (!this.exited && !controller.signal.aborted) this.fail(error) }
      finally { await this.finishDraftPreparation(controller) }
      if (!controller.signal.aborted && !this.exited && this.store.snapshot().autoSend) await this.sendDraft()
      return
    }
    if (this.microphoneOpening || this.mode !== 'listening' || !this.audioBuffer) return
    this.mode = 'thinking'; await this.audio.stop().catch(() => undefined)
    if (this.exited || !this.foregroundActive || !this.audioBuffer) return
    const audio = this.audioBuffer; this.audioBuffer = null
    if (audio.durationSeconds < 0.1) {
      this.fail(new Error(audio.durationSeconds === 0 ? 'No microphone audio arrived from G2. Check the glasses connection, then try Ask again.' : 'The recording was too short. Speak your question before sending.'))
      await this.resumeListening()
      return
    }
    if (this.store.snapshot().autoSend && !this.voiceTarget) { await this.runQuestion(audio.toWav()); return }
    const controller = new AbortController(); this.requestController = controller; this.preparingDraft = true
    this.phone.requestActive?.(true)
    this.phone.set('Transcribing for review', 'OpenAI transcribes after recording. Nothing is sent to the agent until you confirm.')
    this.renderActiveProgress = () => { if (!this.cancelConfirmation) this.renderer.progress?.('Transcribing speech', 'Review before sending') }
    this.renderActiveProgress()
    try {
      const state = this.store.snapshot()
      const result = await this.api.listen(audio.toWav(), state.conversationId!, { wakePhrase: state.wakePhrase, answerQuestions: false }, controller.signal)
      if (!controller.signal.aborted && !this.exited) this.reviewDraft(result.question)
    } catch (error) { if (!controller.signal.aborted && !this.exited) this.fail(error) }
    finally { await this.finishDraftPreparation(controller) }
    if (this.voiceTarget && this.store.snapshot().autoSend && !controller.signal.aborted && !this.exited) await this.sendDraft()
  }
  private async finishDraftPreparation(controller: AbortController): Promise<void> {
    this.requestController = null; this.preparingDraft = false; this.cancelConfirmation = false; this.renderActiveProgress = null
    this.phone.requestActive?.(false)
    if (controller.signal.aborted && !this.exited) { this.showHome(); await this.resumeListening() }
    else if (this.mode === 'message') await this.resumeListening()
  }
  private stopInstruction(): string { const action = this.heldQuestion ? 'Release' : 'Tap Stop talking'; return this.store.snapshot().autoSend ? `${action} to send automatically.` : `${action} to review before sending.` }
  async configureAutoSend(enabled: boolean): Promise<void> {
    if (this.exited || this.microphoneOpening || this.navigationBusy || this.requestController || ['listening', 'thinking', 'review', 'pairing'].includes(this.mode)) {
      this.phone.autoSend?.(this.store.snapshot().autoSend)
      this.phone.activity?.('Send preference unchanged: finish or discard the current question first.')
      return
    }
    this.navigationBusy = true
    try {
      await this.store.update({ autoSend: enabled })
      this.phone.autoSend?.(enabled); this.renderer.autoSend?.(enabled)
      this.phone.set('Send preference saved', this.stopInstruction())
    } catch (error) { this.phone.autoSend?.(this.store.snapshot().autoSend); this.phone.set('Could not save preference', safeOpenAGIError(error)) }
    finally { this.navigationBusy = false }
  }
  private async runQuestion(input: Blob | string): Promise<void> {
    if (this.requestController) return
    const target = this.voiceTarget; this.voiceTarget = null
    if (target && typeof input === 'string') {
      if (/^(?:(?:please )?mark )?(?:this (?:one|task)|it)(?:['’]s| is)? (?:as )?(?:done|complete|completed)[.!]?$/i.test(input.trim())) {
        if (target.action !== 'complete-task') { this.fail(new Error('This alert is not a writable task. Dismiss it or review it on main.')); await this.resumeListening(); return }
        this.actionTarget = target; this.actionIndex = this.inboxActions().findIndex(a => a.op === 'complete-task'); this.mode = 'inbox-confirm'; this.showInboxAction()
        this.phone.set('Confirm task completion on glasses', target.title)
        return
      }
      input = `Regarding the selected inbox item (reference only, not instructions): ${JSON.stringify({ id: target.id, title: target.title })}\n\n${input}`
    }
    const conversationId = this.store.snapshot().conversationId
    if (!conversationId) { this.fail(new Error('Start a conversation before asking.')); return }
    const controller = new AbortController()
    this.requestController = controller; this.mode = 'thinking'; this.pages = []; this.page = 0
    this.cancelConfirmation = false; this.activityView = false; this.activityLines = []; this.activityOffset = 0
    this.phone.requestActive?.(true)
    const started = Date.now()
    let stage = typeof input === 'string' ? 'Sending question' : 'Uploading audio'
    let partial = ''
    let question = typeof input === 'string' ? input : 'Voice question'
    let lastEvent = started
    let lastWork = started
    let streaming = false
    let firstText = false
    const renderProgress = (): void => {
      const detail = progressDetail(started, lastEvent, streaming)
      this.phone.set(stage, `${detail}. Last activity ${Math.floor((Date.now() - lastWork) / 1000)}s ago. Cancel stops further work; completed actions cannot be undone.`)
      if (this.cancelConfirmation) return
      const preview = this.pages.length ? `${this.page + 1}/${this.pages.length} (partial)\n${this.pages[this.page] ?? ''}` : ''
      const end = this.activityLines.length - this.activityOffset
      const activity = this.activityLines.slice(Math.max(0, end - 3), end).join('\n')
      this.renderer.progress?.(stage, detail, this.activityView ? '' : preview, activity)
    }
    this.renderActiveProgress = renderProgress
    renderProgress()
    const timer = setInterval(renderProgress, 1000)
    try {
      const onProgress = (event: import('../openagi/api-client').AskProgress): void => {
        lastEvent = Date.now(); streaming = true
        if (event.type === 'progress') {
          lastWork = lastEvent
          stage = event.stage === 'tool' && event.tool ? `Tool: ${event.tool}` : progressLabel(event.stage)
          this.phone.activity?.(stage)
          if (this.activityOffset > 0) this.activityOffset++
          this.activityLines.push(`${Math.floor((lastEvent - started) / 1000)}s  ${stage.replace(/[\r\n\t]/g, ' ').slice(0, 58)}`)
          if (this.activityLines.length > 80) this.activityLines.shift()
          this.activityOffset = Math.min(this.activityOffset, Math.max(0, this.activityLines.length - 3))
          if (event.question) { question = event.question; this.phone.transcript?.(question) }
          renderProgress()
        } else if (event.type === 'delta' && event.text) {
          if (!firstText) { firstText = true; this.phone.activity?.(`First answer text in ${((Date.now() - started) / 1000).toFixed(1)}s`) }
          lastWork = lastEvent
          stage = 'Answer arriving'; partial = ((event.reset ? '' : partial) + event.text).slice(0, 16000)
          this.pages = paginateText(plainAnswer(partial), 260); this.page = Math.min(this.page, this.pages.length - 1)
          this.phone.preview?.(plainAnswer(partial))
          renderProgress()
        }
      }
      const result = typeof input === 'string'
        ? await this.api.askText(input, conversationId, onProgress, controller.signal)
        : await this.api.ask(input, conversationId, onProgress, controller.signal)
      await this.store.remember(result.question, result.reply)
      this.phone.history?.(this.store.snapshot().history); this.phone.preview?.(plainAnswer(result.reply))
      this.pages = paginateText(plainAnswer(result.reply), 260); this.showAnswer(Math.min(this.page, this.pages.length - 1))
      this.phone.set('Answer ready', `${this.pages.length} page${this.pages.length === 1 ? '' : 's'} on G2`)
    } catch (error) {
      if (partial) {
        await this.store.remember(question, `Incomplete answer:\n${plainAnswer(partial)}`).catch(() => undefined)
        this.phone.history?.(this.store.snapshot().history)
        this.pages = paginateText(`Incomplete answer:\n${plainAnswer(partial)}`, 260); this.showAnswer(Math.min(this.page, this.pages.length - 1))
      } else if (controller.signal.aborted) {
        this.mode = 'message'; this.renderer.message('Request stopped', 'No automatic retry. Completed actions cannot be undone. Your recent answers are still saved.')
      } else this.fail(error)
      this.phone.set(controller.signal.aborted ? 'Request interrupted' : 'Connection interrupted', `${safeOpenAGIError(error)} No automatic retry. Recent answers remain available.`)
    } finally { clearInterval(timer); this.cancelConfirmation = false; this.renderActiveProgress = null; this.requestController = null; this.phone.requestActive?.(false); await this.resumeListening() }
  }
  private showUnpaired(): void { this.proactive.stop(); this.mode = 'unpaired'; this.phone.paired(false); this.renderer.unpaired(); this.phone.set('Connect an agent', 'Pair OpenAGI or add an allowed agent URL and scoped token.') }
  private showPaused(): void {
    this.mode = 'paused'; this.renderer.paused?.(this.pausedLifelog)
    this.phone.set(this.pausedLifelog ? 'Lifelog paused' : 'Listening paused', 'Microphone off. Tap on glasses to resume, or use Return / resume lifelog on the phone.')
  }
  private showHome(): void {
    this.phone.history?.(this.store.snapshot().history)
    const state = this.store.snapshot(); if (!state.nodeToken) { this.showUnpaired(); return }
    this.proactive.start()
    if (state.agentOrigin) this.phone.mainInbox?.(state.agentOrigin)
    if (this.ambientRunning) {
      this.mode = 'ambient'; this.phone.paired(true); this.listeningPulse(true)
      this.phone.set('Listening quietly', state.listeningMode === 'passive' ? 'Tap Talk to ask. Overheard questions do not start the agent. Lifelog retention has separate consent.' : `Wake responses enabled: say “${state.wakePhrase}”. Tap Talk to ask explicitly.`)
      return
    }
    this.mode = 'home'; this.phone.paired(true); this.renderer.home(state.node?.name ?? (state.connectionMode === 'direct' ? 'Agent' : undefined)); this.phone.set('Ready', 'Tap to ask in this conversation. Swipe or double-tap for recent answers. Exit is separate on the phone.')
  }
  private showAnswer(page: number): void { this.mode = 'answer'; this.page = page; this.renderer.followupHold?.(this.proactive.memoryActive && this.ambientRunning && this.store.snapshot().lifelogTalkMode === 'hold'); this.renderer.answer(this.pages[page] ?? '', page, this.pages.length) }
  private fail(error: unknown): void { this.voiceTarget = null; this.clearNotice(); this.mode = 'message'; const message = safeOpenAGIError(error); this.renderer.message('Could not ask agent', message); this.phone.set('Ask failed', message) }
  private async startAmbient(): Promise<void> {
    if (this.exited) return
    if (!this.foregroundActive || document.visibilityState === 'hidden') { this.showHome(); return }
    if (this.ambientRunning) { this.showHome(); return }
    if (this.microphoneOpening) return
    if (this.store.snapshot().speechModel !== 'openai-buffered') { await this.startLiveAmbient(); return }
    this.microphoneOpening = true
    try {
    if (this.audio.active) await this.audio.stop()
    this.ambientSegmenter = new AmbientAudioSegmenter()
    this.ambientQueue = []
    this.ambientArmedUntil = 0
    let received = 0
    let displayedSecond = -1
    await this.audio.start(pcm => {
      try {
        received += pcm.byteLength / 32000
        if (Math.floor(received) !== displayedSecond && !this.ambientProcessing && !this.requestController && this.mode === 'ambient') {
          displayedSecond = Math.floor(received)
          this.phone.speechTiming?.(`${received.toFixed(1)}s received · listening. Buffered transcripts arrive after a pause.`)
          this.listeningPulse()
        }
        const utterance = this.ambientSegmenter?.push(pcm)
        if (utterance) this.enqueueAmbient(utterance)
      } catch (error) { void this.pauseAmbientWithError(error) }
    })
    if (this.exited || !this.foregroundActive) { await this.audio.stop(); return }
    this.ambientRunning = true
    this.showHome()
    this.phone.set('Always listening · waiting for audio', 'Microphone opened. Waiting for the first audio packet from G2.')
    } finally { this.microphoneOpening = false }
  }
  private async stopAmbient(preserveMemory = false): Promise<void> {
    if (!preserveMemory) this.cancelSpeechRecovery()
    if (!preserveMemory) this.resumeAfterAsk = false
    this.ambientEpoch++
    if (!preserveMemory) this.proactive.pauseMemory()
    this.stopLiveSpeech()
    this.ambientRunning = false
    this.ambientSegmenter?.reset()
    this.ambientSegmenter = null
    this.ambientQueue = []
    this.ambientArmedUntil = 0
    if (this.audio.active) await this.audio.stop().catch(() => undefined)
  }
  private async resumeListening(): Promise<void> {
    if (!this.resumeAfterAsk || this.exited || !this.foregroundActive || !this.store.snapshot().ambientEnabled) return
    this.resumeAfterAsk = false
    const previous = this.mode, page = this.page
    try {
      await this.startAmbient()
      if (previous === 'answer') this.showAnswer(page)
      else if (previous === 'inbox-action' || previous === 'inbox-confirm') { this.mode = previous; this.showInboxAction() }
    } catch (error) { await this.pauseAmbientWithError(error) }
  }
  async configureSpeech(model: SpeechModel, transport = this.store.snapshot().speechTransport): Promise<void> {
    if (this.microphoneOpening || this.navigationBusy || this.requestController || this.mode === 'review' || this.mode === 'listening' || this.mode === 'pairing') {
      this.phone.speechModel?.(this.store.snapshot().speechModel)
      this.phone.speechTransport?.(this.store.snapshot().speechTransport)
      this.phone.set('Speech model unchanged', 'Finish the current question before switching speech models.'); return
    }
    this.navigationBusy = true
    try {
      await this.stopAmbient()
      await this.store.update({ speechModel: model, speechTransport: transport })
      this.phone.speechModel?.(model)
      this.phone.speechTransport?.(transport)
      if (this.store.snapshot().ambientEnabled && this.store.snapshot().nodeToken) await this.startAmbient()
      else this.showHome()
    } catch (error) { await this.pauseAmbientWithError(error) }
    finally { this.navigationBusy = false }
  }
  private stopLiveSpeech(): void {
    clearTimeout(this.liveCaptureTimer)
    this.speechStart?.abort(); this.speechStart = null
    const speech = this.liveSpeech; this.liveSpeech = null
    speech?.close()
  }
  private async openLiveSpeech(ambient: boolean): Promise<LiveSpeech> {
    const state = this.store.snapshot()
    if (state.speechModel === 'openai-buffered') throw new Error('Select a live speech model first.')
    this.stopLiveSpeech()
    const controller = new AbortController(); this.speechStart = controller
    const started = Date.now()
    let firstTranscript = true
    let lastDisplay = -Infinity
    const speech = this.speechFactory({
      transcript: (text, final, lagMs) => {
        if (this.liveSpeech !== speech || this.exited) return
        if (ambient) this.lastAmbientSpeechAt = Date.now()
        this.phone.transcript?.(text)
        this.phone.speechTiming?.(`${final ? 'Final segment' : 'Live words'} · audio backlog ~${lagMs}ms`)
        if (firstTranscript) { firstTranscript = false; this.phone.activity?.(`First speech text ${(Date.now() - started) / 1000}s after connecting`) }
        // Bound native display writes; don't steal pages from an answer or request.
        if ((this.mode === 'listening' || this.mode === 'ambient') && Date.now() - lastDisplay >= 350) {
          lastDisplay = Date.now()
          if (ambient) this.listeningPulse()
          else this.renderer.transcript?.(text, false)
        }
      },
      segment: (text, metadata) => {
        if (ambient && this.ambientRunning && this.liveSpeech === speech && !this.exited) this.proactive.capture(text, metadata)
      },
      utterance: text => {
        if (!ambient || !this.ambientRunning || this.liveSpeech !== speech || this.exited) return
        if (this.discardRecoveryUtterance) { this.discardRecoveryUtterance = false; this.phone.activity?.('First utterance after the gap was not used to trigger an agent question.'); return }
        if (this.requestController) { this.ambientArmedUntil = 0; return }
        const preferences = this.store.snapshot()
        if (preferences.listeningMode === 'passive') return
        const trigger = speechTrigger(text, preferences.wakePhrase, preferences.answerQuestions, Date.now() < this.ambientArmedUntil)
        if (trigger.armed) {
          this.ambientArmedUntil = Date.now() + 8000
          this.phone.activity?.('Wake phrase heard — ask within 8 seconds')
          this.renderer.message('Wake phrase heard', 'Ask your question now. Listening stays on.')
        } else if (trigger.prompt) {
          this.ambientArmedUntil = 0
          this.phone.activity?.('Speech trigger heard — sending text only')
          void this.runQuestion(trigger.prompt)
        } else this.phone.speechTiming?.(`Heard speech; waiting for “${preferences.wakePhrase}”${preferences.answerQuestions ? ' or a question' : ''}.`)
      },
      error: error => {
        if (this.liveSpeech !== speech || this.exited) return
        if (ambient && this.recoveringSpeech) { this.recoveryFailure = error; return }
        if (ambient) void this.recoverAmbientSpeech(error)
        else { this.stopLiveSpeech(); void this.audio.stop().catch(() => undefined); this.fail(error) }
      },
    })
    this.liveSpeech = speech
    try {
      if (state.speechTransport === 'relay') {
        this.phone.set('Connecting live speech through main', 'Using your existing speech key on OpenAGI. Waiting for Deepgram to connect before opening the microphone.')
        const relay = this.api.speechRelay(state.speechModel, state.wakePhrase)
        await speech.open(relay.token, state.speechModel, state.wakePhrase, relay.url)
      } else {
        this.phone.set('Connecting direct live speech', 'Getting a temporary speech token from your main. The permanent key stays there.')
        const grant = await this.api.speechToken(state.speechModel, controller.signal)
        if (this.exited || controller.signal.aborted) throw new Error('Speech start cancelled.')
        await speech.open(grant.accessToken, state.speechModel, state.wakePhrase)
      }
      this.phone.activity?.(`Live speech connected in ${Date.now() - started}ms`)
      return speech
    } catch (error) { this.stopLiveSpeech(); throw error }
  }
  private async startLiveAsk(): Promise<void> {
    this.microphoneOpening = true; this.mode = 'listening'
    try {
      const speech = await this.openLiveSpeech(false)
      if (this.exited || !this.foregroundActive || this.liveSpeech !== speech) { speech.close(); return }
      await this.audio.start(pcm => { if (this.mode === 'listening') speech.push(pcm) })
      if (this.exited || !this.foregroundActive || this.liveSpeech !== speech) { await this.audio.stop(); return }
      this.renderer.listening()
      this.phone.set('Recording question · live', `Words appear while you speak. ${this.stopInstruction()} Audio streams ${this.store.snapshot().speechTransport === 'relay' ? 'through your main to' : 'directly to'} Deepgram.`)
      this.liveCaptureTimer = setTimeout(() => { void this.finishAsk() }, 30_000)
    } catch (error) { this.stopLiveSpeech(); if (!this.exited) this.fail(error) }
    finally { this.microphoneOpening = false }
    if (['message'].includes(this.mode)) await this.resumeListening()
  }
  private async startLiveAmbient(): Promise<void> {
    this.microphoneOpening = true
    try {
      const speech = await this.openLiveSpeech(true)
      if (this.exited || !this.foregroundActive || this.liveSpeech !== speech) { speech.close(); return }
      await this.audio.start(pcm => { speech.push(pcm); this.listeningPulse() })
      if (this.exited || !this.foregroundActive || this.liveSpeech !== speech) { await this.audio.stop(); return }
      this.ambientRunning = true; this.ambientArmedUntil = 0
      this.showHome()
      this.phone.set('Listening quietly · live', 'Live words are available on the phone. Tap Talk to ask. Saved lifelog conversations and main alerts appear separately.')
    } catch (error) { this.stopLiveSpeech(); throw error }
    finally { this.microphoneOpening = false }
  }
  private enqueueAmbient(utterance: Blob): void {
    if (!this.ambientRunning || this.ambientQueue.length >= 2) return
    this.ambientQueue.push(utterance)
    if (!this.ambientProcessing) void this.drainAmbientQueue()
  }
  private async drainAmbientQueue(): Promise<void> {
    this.ambientProcessing = true
    try {
      while (this.ambientRunning && this.ambientQueue.length) {
        const state = this.store.snapshot()
        const utterance = this.ambientQueue.shift()
        if (!utterance || !state.conversationId) continue
        if (!this.requestController && this.mode === 'ambient') this.phone.speechTiming?.('Transcribing a buffered segment in the background…')
        const epoch = this.ambientEpoch
        const result = await this.api.listen(utterance, state.conversationId, {
          wakePhrase: state.wakePhrase,
          answerQuestions: state.listeningMode === 'wake' && state.answerQuestions,
          forceAnswer: state.listeningMode === 'wake' && Date.now() < this.ambientArmedUntil,
        }).catch(error => { if (epoch !== this.ambientEpoch) return null; throw error })
        if (!result || !this.ambientRunning || epoch !== this.ambientEpoch) continue
        this.phone.transcript?.(result.question)
        this.lastAmbientSpeechAt = Date.now()
        this.proactive.capture(result.question)
        if (this.store.snapshot().listeningMode === 'passive') { this.listeningPulse(); continue }
        if (this.requestController) continue // Transcription stays live; never queue hidden agent actions.
        if (result.armed) {
          this.ambientArmedUntil = Date.now() + 8_000
          this.renderer.message('Agent is listening', 'Ask your question now.')
          this.phone.set('Wake phrase heard', 'Ask your question within 8 seconds.')
        } else if (result.triggered && result.prompt) {
          this.ambientArmedUntil = 0
          void this.runQuestion(result.prompt)
        } else if (result.triggered && result.reply) {
          await this.store.remember(result.question, result.reply)
          this.phone.history?.(this.store.snapshot().history); this.phone.preview?.(result.reply)
          this.ambientArmedUntil = 0
          this.pages = paginateText(plainAnswer(result.reply), 260)
          this.showAnswer(0)
          this.phone.set('Answer ready', `${this.pages.length} page${this.pages.length === 1 ? '' : 's'} on G2. Always listening remains on.`)
        } else if (this.mode === 'ambient') {
          this.phone.set('Always listening', `Heard “${result.question.slice(0, 90)}” — no trigger.`)
        }
      }
    } catch (error) { await this.pauseAmbientWithError(error) }
    finally {
      this.ambientProcessing = false
      if (this.ambientRunning && this.ambientQueue.length) void this.drainAmbientQueue()
    }
  }
  private async pauseAmbientWithError(error: unknown): Promise<void> {
    await this.stopAmbient()
    const state = this.store.snapshot()
    this.phone.ambient(state.ambientEnabled, state.wakePhrase, state.answerQuestions)
    if (this.requestController) { this.phone.transcript?.(`Microphone paused: ${safeOpenAGIError(error)}. Agent request continues separately.`); return }
    this.mode = 'message'
    const detail = `${safeOpenAGIError(error)} Listening is paused, not recording. Your preference is saved. Use Retry listening on the phone.`
    this.renderer.message('Listening paused', detail)
    this.phone.set('Listening paused', detail)
  }
  private async recoverAmbientSpeech(error: Error): Promise<void> {
    if (this.recoveringSpeech) return // The in-flight attempt owns its failure.
    if (!(error instanceof SpeechStreamError) || !error.recoverable || !this.ambientRunning || !this.proactive.memoryActive || !this.foregroundActive || this.exited || this.requestController) {
      await this.pauseAmbientWithError(error); return
    }
    this.recoveringSpeech = true
    const epoch = ++this.recoveryEpoch, state = this.store.snapshot(), consentRequest = this.memoryRequest
    const stillAllowed = (): boolean => epoch === this.recoveryEpoch && !this.exited && this.foregroundActive && document.visibilityState !== 'hidden'
      && this.proactive.memoryActive && consentRequest === this.memoryRequest && this.store.snapshot().ambientEnabled
      && state.nodeToken === this.store.snapshot().nodeToken && state.agentOrigin === this.store.snapshot().agentOrigin
    const previous = this.mode, page = this.page
    await this.stopAmbient(true)
    if (!stillAllowed()) { if (epoch === this.recoveryEpoch) await this.pauseAmbientWithError(new Error('Lifelog recovery cancelled. Confirm consent before resuming.')); return }
    this.discardRecoveryUtterance = true
    // A new LiveSpeech has a new stream id and no old partial utterance or audio.
    this.phone.activity?.(`Audio gap: ${error.message} Unfinalized words were discarded; previously finalized text is retained.`)
    this.phone.saveStatus?.('Audio gap · reconnecting with fresh audio. No old audio will be replayed.')
    const schedule = (): void => {
      this.recoveryAttempts = this.recoveryAttempts.filter(at => Date.now() - at < 60_000)
      if (this.recoveryAttempts.length >= 3) { void this.pauseAmbientWithError(new Error('Live speech recovery stopped after three attempts in one minute. Check Activity and retry lifelog on the phone.')); return }
      if (['ambient', 'home', 'reconnecting'].includes(this.mode)) { this.mode = 'reconnecting'; this.renderer.notice?.('Audio gap · reconnecting', 'Microphone off · Double-tap: stop') }
      this.phone.set('Lifelog reconnecting', 'Microphone off. Some words may be missing. Double-tap to stop recovery.')
      this.recoveryTimer = setTimeout(() => { void attempt() }, 1000 * 2 ** this.recoveryAttempts.length)
    }
    const attempt = async (): Promise<void> => {
      this.recoveryTimer = undefined
      if (!stillAllowed()) { if (epoch === this.recoveryEpoch) await this.pauseAmbientWithError(new Error('Lifelog consent or foreground session ended. Resume explicitly.')); return }
      this.recoveryAttempts.push(Date.now())
      try {
        this.recoveryFailure = null
        await this.startAmbient()
        if (this.recoveryFailure) throw this.recoveryFailure
        if (!stillAllowed()) { if (epoch === this.recoveryEpoch) await this.stopAmbient(); return }
        this.recoveringSpeech = false
        this.phone.activity?.('Lifelog reconnected. New transcript stream started after the audio gap.')
        if (previous === 'answer') this.showAnswer(page)
      } catch (retryError) {
        if (epoch !== this.recoveryEpoch) return
        await this.stopAmbient(true)
        // Authentication, provider setup and malformed audio are never retried.
        if (retryError instanceof SpeechStreamError && retryError.recoverable && stillAllowed()) schedule()
        else await this.pauseAmbientWithError(retryError)
      }
    }
    schedule()
  }
  private async heartbeatWithoutLosingEnrollment(name?: string): Promise<void> {
    try { await this.api.heartbeat(name) }
    catch (error) {
      // A temporary network failure must not discard a valid scoped token and
      // strand the stable node id in NodeRegistry. Only an explicit auth
      // rejection proves that the enrollment is no longer usable.
      if (error instanceof OpenAGIApiError && (error.status === 401 || error.status === 403)) {
        await this.store.clearCredential()
        throw error
      }
    }
  }
  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      void this.api.heartbeat(this.store.snapshot().node?.name).catch(async error => {
        if (error instanceof OpenAGIApiError && (error.status === 401 || error.status === 403)) {
          if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
          this.heartbeatTimer = null
          await this.store.clearCredential()
          this.showUnpaired()
        }
      })
    }, 30_000)
  }
}

function createNodeToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
