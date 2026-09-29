import type { AudioSource } from '../even/audio-source'
import { QuestionAudioBuffer } from '../buildbetter/question-audio'
import { paginateText } from '../state/ask-state-machine'
import type { OpenAGIApiClient } from '../openagi/api-client'
import { AgentOriginSchema, OpenAGIApiError, safeOpenAGIError } from '../openagi/config'
import { AmbientAudioSegmenter } from '../openagi/ambient-listener'
import { progressDetail, progressLabel } from '../openagi/progress'
import { plainAnswer } from '../openagi/answer-format'
import { LiveSpeech, SpeechStreamError, type SpeechModel, type SpeechCallbacks } from '../openagi/live-speech'
import type { ConversationThread, HomeMode, OpenAGIStore } from '../openagi/store'
import type { OpenAGIGlassesRenderer, LifelogHomeState } from '../ui/openagi-glasses-renderer'
import type { OpenAGIPhoneCompanion } from '../ui/openagi-phone-companion'
import { G2ProactiveClient, type InboxItem, type MainConsent } from '../openagi/proactive'
import type { SharedThreadMessage } from '../openagi/experience-client'

type Mode = 'unpaired' | 'pairing' | 'home' | 'recent' | 'status' | 'inbox' | 'inbox-detail' | 'inbox-action' | 'inbox-confirm' | 'ambient' | 'reconnecting' | 'listening' | 'review' | 'thinking' | 'answer' | 'message'
interface RecentEntry { question: string; reply: string; local?: number }

const CONSENT_NEEDED = 'Lifelog needs your recording consent once. Check the consent box on this page; it stays on until you uncheck it.'

// Three homes, one setting (homeMode):
// - Talk: microphone off at home; tap to talk, tap again to send.
// - Lifelog: always listening while Agents is on the glasses, with the owner's
//   standing consent. Leaving the foreground only pauses locally.
// - Supervisor: the fleet supervisor's questions, thread status and chat.
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
    const label = item.supervisor ? 'Supervisor question' : item.reminder ? 'Reminder suggested' : /^Follow up:/i.test(item.title) ? 'Follow-up suggested' : item.category === 'memory' ? 'Action identified' : item.category === 'highlight' ? 'Lifelog' : 'Update from main'
    this.renderer.notice?.(label, plainAnswer(item.title))
    this.noticeTimer = setTimeout(() => { this.noticeTimer = null; if (['home', 'ambient'].includes(this.mode) && this.foregroundActive && !this.exited) this.showHome() }, 4500)
  }
  // Every ignored gesture gets visible feedback instead of silence.
  private flash(title: string, detail: string): void { this.renderer.flash?.(title, detail); this.phone.activity?.(`${title}: ${detail}`) }
  private currentMode: Mode = 'unpaired'
  private get mode(): Mode { return this.currentMode }
  private set mode(value: Mode) {
    this.currentMode = value
    this.phone?.interaction?.(value === 'unpaired' || value === 'pairing' ? 'unavailable' : value === 'thinking' ? 'working' : value === 'listening' ? 'recording' : value === 'review' ? 'review' : 'idle')
  }
  private get homeMode(): HomeMode { return this.store.snapshot().homeMode }
  private get thread(): ConversationThread { return this.homeMode === 'supervisor' ? 'supervisor' : 'agent' }
  async configureInterface(style: 'focused' | 'classic'): Promise<void> {
    await this.store.update({ interfaceStyle: style }); this.phone.interfaceStyle?.(style)
  }
  private async checkExperience(): Promise<void> {
    try { this.phone.readiness?.(await this.api.configureExperience?.(this.store) ?? null) }
    catch (error) { this.phone.readiness?.(null, `Main readiness could not be checked: ${safeOpenAGIError(error)}`) }
  }
  async readHistory(continuation?: string, offset = 0, query = ''): Promise<void> {
    this.phone.historyStatus?.('Loading from main…')
    try { this.phone.mainHistory?.(await this.api.readHistory(continuation, offset, query), continuation) }
    catch (error) { this.phone.historyStatus?.(`Could not load main history: ${safeOpenAGIError(error)} Local recent answers remain below.`) }
  }
  async continueHistory(continuation: string): Promise<void> {
    if (this.requestController || this.microphoneOpening || this.store.snapshot().pendingRequest || this.store.snapshot().savedDraft || ['listening', 'review', 'pairing'].includes(this.mode)) {
      this.phone.set('Keep your current question', 'Finish or clear the saved question before switching conversations.'); return
    }
    try {
      const history = await this.api.readHistory(continuation)
      const answer = history.messages?.filter(m => m.role === 'assistant').at(-1)?.text
      await this.store.update({ continuation, conversationId: crypto.randomUUID() })
      if (answer) { this.pages = paginateText(plainAnswer(answer), 260); this.phone.preview?.(plainAnswer(answer)); this.showAnswer(0) } else this.showHome()
      this.phone.set('Conversation resumed', 'Your next question continues this exact chat on main.')
    } catch (error) { this.phone.set('Could not resume conversation', safeOpenAGIError(error)) }
  }
  async resumeRequest(allowSubmit = true): Promise<void> {
    if (this.requestController || this.exited || !this.foregroundActive || this.microphoneOpening) return
    const pending = this.store.snapshot().pendingRequest
    if (!pending) return
    this.memoryRequest++
    await this.stopAmbient('Lifelog paused while a saved question is checked.')
    await this.store.update({ conversationId: pending.conversationId, continuation: pending.continuation })
    await this.runQuestion(pending.text ?? '', { resume: true, allowSubmit })
  }
  async dismissRequest(): Promise<void> {
    if (this.requestController) return
    await this.store.update({ pendingRequest: null }); this.phone.pendingQuestion?.(null); this.showHome(); await this.resumeListening()
  }
  private audioBuffer: QuestionAudioBuffer | null = null
  private pages: string[] = []
  private page = 0
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private ambientRunning = false
  private memoryRequest = 0
  private foregroundTransition: Promise<void> = Promise.resolve()
  private recoveringSpeech = false
  private recoveryEpoch = 0
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined
  private recoveryAttempts: number[] = []
  private recoveryFailure: Error | null = null
  private cancelSpeechRecovery(): void { this.recoveryEpoch++; clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined; this.recoveringSpeech = false }
  private lastListeningPulse = 0
  private foregroundActive = true
  private lastAudioAt = 0
  private audioWatch: ReturnType<typeof setInterval> | null = null
  private lifelogRequest = 0
  // Lifelog runtime: never persisted, so reopening Agents always listens.
  private lifelogState: LifelogHomeState = 'off'
  private lifelogDetail = ''
  private lifelogUserPaused = false
  private lifelogStart: Promise<void> | null = null
  private lifelogKickTimer: ReturnType<typeof setTimeout> | undefined
  private lifelogRetryTimer: ReturnType<typeof setTimeout> | undefined
  private lifelogFailures = 0
  private askStarting = false
  // A Supervisor-home press-and-hold is talking; its release sends.
  private pushToTalk = false
  private releasePending = false
  private recentEntries: RecentEntry[] = []
  private recentRequest = 0
  // The phone screen never gates the glasses. While it is locked, a long
  // silence from the microphone means Even suspended audio: stop locally.
  private onVisibility = (): void => {
    if (document.visibilityState === 'hidden') { this.startAudioWatch(); return }
    this.stopAudioWatch()
    if (this.lifelogState === 'waiting') this.kickLifelog()
  }
  private startAudioWatch(): void {
    if (this.audioWatch) return
    this.audioWatch = setInterval(() => {
      if (this.ambientRunning && !this.recoveringSpeech && document.visibilityState === 'hidden' && Date.now() - this.lastAudioAt > 10_000) void this.suspendForAudioGap()
    }, 2000)
  }
  private stopAudioWatch(): void { if (this.audioWatch) clearInterval(this.audioWatch); this.audioWatch = null }
  private async suspendForAudioGap(): Promise<void> {
    const detail = 'No microphone audio for 10 seconds while the phone was locked. Even may have paused audio. Lifelog resumes on your next glasses gesture or when you unlock.'
    this.memoryRequest++; this.cancelSpeechRecovery()
    await this.stopAmbient(detail)
    this.phone.activity?.(detail); this.setLifelog('waiting', detail)
    if (this.mode === 'ambient') this.showHome()
  }
  /** Any glasses gesture: Agents is on the glasses right now. */
  glassesInput(): void {
    if (!this.foregroundActive) this.setForeground(true)
    else if (this.lifelogState === 'waiting') this.kickLifelog()
  }
  setForeground(active: boolean): void {
    if (this.exited) return
    if (active) {
      const returning = !this.foregroundActive
      this.foregroundActive = true; this.proactive.setForeground(true)
      if (returning && ['home', 'ambient', 'reconnecting'].includes(this.mode)) this.showHome()
      this.kickLifelog()
      return
    }
    if (!this.foregroundActive) return
    // Only local: the microphone stops, consent stays on main, and listening
    // resumes on return. Nothing is shown as "paused" on the glasses.
    this.foregroundActive = false
    this.proactive.setForeground(false)
    this.clearNotice()
    this.memoryRequest++; this.lifelogRequest++; this.voiceTarget = null
    clearTimeout(this.lifelogKickTimer); clearTimeout(this.lifelogRetryTimer)
    this.audioBuffer = null
    if (this.preparingDraft) this.cancelRequest()
    this.stopLiveSpeech(); this.cancelSpeechRecovery()
    this.foregroundTransition = this.stopAmbient('Agents left the glasses. Microphone off; lifelog resumes when you return.')
    if (this.mode === 'ambient' || this.mode === 'listening' || this.mode === 'reconnecting' || (this.mode === 'thinking' && !this.requestController)) this.mode = 'home'
    const detail = this.homeMode === 'lifelog'
      ? 'Agents left the glasses foreground. Microphone off; consent stays on. Listening resumes when you return to Agents on the glasses.'
      : 'Agents left the glasses foreground. Microphone off until you return.'
    this.phone.activity?.(detail)
    if (this.homeMode === 'lifelog') this.setLifelog('waiting', 'Agents is in the background on the glasses. Resumes when you return.')
    this.phone.set('Agents in background', detail)
  }
  private ambientEpoch = 0
  private lastAmbientSpeechAt = Date.now()
  private ambientSegmenter: AmbientAudioSegmenter | null = null
  private ambientQueue: Blob[] = []
  private ambientProcessing = false
  private microphoneOpening = false
  private lastTapAt = -Infinity
  private requestController: AbortController | null = null
  private renderActiveProgress: (() => void) | null = null
  private recentIndex = 0
  private navigationBusy = false
  private statusRequest = 0
  private exitDialogOpening = false
  private exited = false
  private liveSpeech: LiveSpeech | null = null
  private speechStart: AbortController | null = null
  private liveCaptureTimer: ReturnType<typeof setTimeout> | undefined
  private displaySleeping = false
  private draft = ''
  private draftRecovery: 'speech' | 'delivery' | undefined
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
      proactiveSettings: settings => {
        phone.proactiveSettings?.(settings)
        // supervisorOnly lives on main; a new pairing or another main starts
        // without it, so the saved home mode is reapplied on first read.
        const supervisorOnly = this.homeMode === 'supervisor'
        if (Boolean(settings.supervisorOnly) !== supervisorOnly) void this.proactive.configure({ supervisorOnly })
      },
      inbox: items => {
        phone.inbox?.(items); renderer.inboxCount?.(items.length)
        // Browsing keeps a stable snapshot. Reopen to see arrivals; main
        // revalidates the exact target before accepting any action.
        if (this.mode === 'home' && !this.noticeTimer) this.renderHome(items)
      },
      activity: text => phone.activity?.(text),
      saveStatus: text => phone.saveStatus?.(text),
      memoryStatus: (active, detail) => { phone.memoryStatus?.(active, detail); this.listeningPulse(true) },
      consentLost: () => { void this.consentLost() },
    },
    () => (this.mode === 'home' || (this.mode === 'ambient' && !this.ambientProcessing && Date.now() - this.lastAmbientSpeechAt > 15_000)) && !this.noticeTimer && !this.exited && !this.navigationBusy && !this.microphoneOpening && !this.displaySleeping && !this.requestController,
    item => this.showNotice(item))
  }
  openInbox(id?: string, supervisorOnly = false): void {
    if (this.exited || this.navigationBusy || this.microphoneOpening || this.requestController || this.displaySleeping || ['listening', 'review', 'pairing'].includes(this.mode)) return
    this.clearNotice(); this.inboxItems = this.proactive.items.filter(i => !supervisorOnly || i.supervisor)
    if (supervisorOnly && !this.inboxItems.length) { void this.showFleetStatus(); return }
    if (!this.inboxItems.length) { this.flash('Inbox empty', 'Nothing from your main right now.'); this.phone.set('Inbox empty', 'Enable proactive updates on the phone, then Refresh.'); return }
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
  private openLifelogControls(): void {
    this.actionTarget = { id: '', title: 'Lifelog', summary: '', category: '', important: false, seen: true, action: '' }
    this.actionIndex = 0; this.mode = 'inbox-action'; this.showInboxAction()
  }
  private inboxActions(): { label: string; op: 'talk' | 'dismiss' | 'snooze' | 'accept-task' | 'complete-task' | 'mark' | 'pause' | 'resume' | 'recent' | 'answer'; value?: string }[] {
    const item = this.actionTarget
    // An empty target is the Lifelog controls list (swipe down in Lifelog).
    if (item && !item.id) {
      return [...(this.proactive.capturing ? [{ label: 'Mark this moment', op: 'mark' as const }] : []),
        this.ambientRunning && !this.lifelogUserPaused ? { label: 'Pause listening', op: 'pause' as const } : { label: 'Resume listening', op: 'resume' as const },
        { label: 'Recent answers', op: 'recent' }]
    }
    // A supervisor question is answered with one of its own fixed choices.
    const answers = item?.supervisor ? (item.options ?? []).map(value => ({ label: `Answer: ${value}`, op: 'answer' as const, value })) : []
    return [...answers,
      { label: 'Talk about this item', op: 'talk' },
      ...(item?.action === 'complete-task' ? [{ label: 'Complete task on main', op: 'complete-task' as const }] : []),
      ...(item?.action === 'accept-task' && !item.reminder ? [{ label: 'Add as my task', op: 'accept-task' as const }] : []),
      ...(item?.id ? [{ label: 'Dismiss alert only', op: 'dismiss' as const }, { label: 'Snooze alert 1 hour', op: 'snooze' as const }] : [])]
  }
  private showInboxAction(): void {
    this.renderer.inboxAction?.(this.inboxActions()[this.actionIndex]?.label ?? '', plainAnswer(this.actionTarget?.title ?? ''), this.mode === 'inbox-confirm')
  }
  private async chooseInboxAction(): Promise<void> {
    const target = this.actionTarget, action = this.inboxActions()[this.actionIndex]; if (!target || !action) return
    if (action.op === 'pause') { await this.pauseLifelog(); return }
    if (action.op === 'resume') { this.showHome(); await this.resumeLifelog(); return }
    if (action.op === 'recent') { await this.openRecent(); return }
    if (action.op === 'talk') { this.voiceTarget = target.id ? { ...target } : null; this.showHome(); await this.startAsk(); return }
    if (action.op === 'mark') { await this.markMoment(); return }
    if (this.mode !== 'inbox-confirm') { this.mode = 'inbox-confirm'; this.showInboxAction(); return }
    this.navigationBusy = true
    if (action.op === 'answer') {
      try {
        const result = await this.proactive.answer(target.id, action.value ?? '')
        if (this.exited || !this.foregroundActive) return
        this.mode = 'message'; this.renderer.message(result.ok ? 'Answered' : 'Not sent yet', result.ok ? `${action.value}. ${result.detail}` : `${result.detail || 'The question stays open.'} Try again later.`)
      } finally { this.navigationBusy = false }
      return
    }
    try {
      const ok = await this.proactive.action(action.op, target.id, { title: target.title, taskId: target.taskId, dueDate: target.dueDate })
      if (this.exited || !this.foregroundActive) return
      this.mode = 'message'; this.renderer.message(ok ? 'Saved on main' : 'Action not confirmed', ok ? action.op === 'complete-task' ? 'Completed in OpenAGI. External source unchanged.' : action.label : 'Check Activity on phone. Nothing is assumed complete.')
    } finally { this.navigationBusy = false }
  }
  async markMoment(): Promise<void> {
    const ok = await this.proactive.markMoment()
    const onGlasses = ['ambient', 'home', 'inbox-action'].includes(this.mode) && this.foregroundActive && !this.exited
    if (ok && onGlasses) { this.showHome(); this.showNotice({ id: '', title: 'Moment marked on main', summary: '', category: 'highlight', action: '', important: false, seen: true }) }
    else if (!ok && onGlasses) this.flash('Moment not marked', this.proactive.capturing ? 'Wait until some words are saved, then try again.' : 'Lifelog is not listening right now.')
  }
  private async showFleetStatus(): Promise<void> {
    // Only the newest request, and only if the user is still where they
    // asked for it; a slow reply must not replace a question they opened.
    const request = ++this.statusRequest, from = this.mode
    const status = await this.proactive.fleetStatus()
    if (this.exited || !this.foregroundActive || request !== this.statusRequest || this.mode !== from) return
    if (!status) { this.mode = 'message'; this.renderer.message('Supervisor unavailable', 'Main could not read the supervisor. Check the Mac running it.'); return }
    const c = status.counts
    const lines = status.threads.map(t => `${t.health === 'red' ? '●' : '○'} ${t.name}: ${t.reason || t.state}`)
    const text = `${c.red} red · ${c.yellow} yellow · ${c.green} green\n${status.needsYou} question${status.needsYou === 1 ? '' : 's'} for you · ${status.mode ?? 'mode ?'}\n\n${lines.join('\n') || 'Nothing needs attention.'}`
    this.pages = paginateText(plainAnswer(text), 220); this.page = 0; this.mode = 'status'
    this.renderer.fleetStatus(this.pages[0] ?? '', 0, this.pages.length)
  }
  // The single home setting. Leaving Lifelog withdraws its consent on main;
  // the phone checkbox is remembered for the next time Lifelog is chosen.
  async configureHomeMode(mode: HomeMode): Promise<void> {
    const previous = this.homeMode
    if (mode === previous) { this.phone.homeMode?.(mode); return }
    if (this.requestController || this.microphoneOpening || this.navigationBusy || ['listening', 'review', 'thinking', 'pairing'].includes(this.mode)) {
      this.phone.homeMode?.(previous); this.phone.set('Mode unchanged', 'Finish or discard the current question, then switch modes.'); return
    }
    await this.store.update({ homeMode: mode }); this.phone.homeMode?.(mode)
    if (previous === 'lifelog') await this.revokeLifelog('Lifelog off: you switched modes. Microphone off and consent withdrawn on main. Choosing Lifelog again restarts it.')
    this.lifelogUserPaused = false; this.lifelogFailures = 0
    this.setLifelog(mode === 'lifelog' ? 'starting' : 'off')
    this.renderer.speaker?.(mode === 'supervisor' ? 'Supervisor' : 'Agent')
    if (['home', 'status', 'ambient', 'recent', 'answer', 'message', 'reconnecting'].includes(this.mode) || this.mode.startsWith('inbox')) this.showHome()
    await this.proactive.configure({ supervisorOnly: mode === 'supervisor' })
    if (mode === 'lifelog') await this.startLifelog()
  }
  async configureRecordingConsent(consent: boolean): Promise<void> {
    await this.store.update({ recordingConsent: consent }); this.phone.recordingConsent?.(consent)
    if (!consent) {
      await this.revokeLifelog('Recording consent withdrawn. Microphone off and consent removed on main. Check the box to start lifelog again.')
      if (this.homeMode === 'lifelog') this.setLifelog('consent')
      if (['home', 'ambient'].includes(this.mode)) this.showHome()
      return
    }
    if (this.homeMode === 'lifelog') { this.lifelogFailures = 0; await this.startLifelog() }
  }
  async pauseLifelog(): Promise<void> {
    if (this.homeMode !== 'lifelog') return
    // Lifelog's own microphone may be opening; only a question blocks a pause.
    if (this.requestController || ['listening', 'review', 'thinking'].includes(this.mode)) { this.flash('Busy', 'Finish the current question first.'); this.phone.set('Lifelog busy', 'Finish the current question, then pause.'); return }
    this.lifelogUserPaused = true; this.memoryRequest++
    clearTimeout(this.lifelogKickTimer); clearTimeout(this.lifelogRetryTimer); this.cancelSpeechRecovery()
    await this.stopAmbient('Lifelog paused by you. Microphone off; consent stays on.')
    this.setLifelog('paused')
    if (['ambient', 'home', 'inbox-action', 'reconnecting'].includes(this.mode)) this.showHome()
    this.phone.set('Lifelog paused', 'Microphone off. Consent stays on. Swipe down on the glasses, or use Resume listening here, to continue.')
  }
  async resumeLifelog(): Promise<void> {
    if (this.homeMode !== 'lifelog') return
    this.lifelogUserPaused = false; this.lifelogFailures = 0
    await this.startLifelog()
    if (this.lifelogState === 'consent') this.flash('Consent needed', 'Check the recording consent box in Agents on the phone.')
  }
  async deleteMemory(): Promise<void> {
    this.memoryRequest++; clearTimeout(this.lifelogRetryTimer); this.cancelSpeechRecovery()
    const saved = this.store.snapshot().lifelogConsent?.id ?? this.proactive.consentId ?? undefined
    await this.stopAmbient()
    const ok = await this.proactive.action('delete-memory')
    if (!ok) this.proactive.revokeMemory(saved)
    await this.store.update({ lifelogConsent: null, recordingConsent: false }); this.phone.recordingConsent?.(false)
    if (this.homeMode === 'lifelog') this.setLifelog('consent')
    if (['ambient', 'home'].includes(this.mode)) this.showHome()
    this.phone.set(ok ? 'Lifelog memory deleted' : 'Delete not confirmed', ok ? 'Transcripts and suggestions deleted on main; recording consent is off. Check the box to start again.' : 'Main did not confirm the delete. Consent is off on this device; check Activity and retry.')
  }
  private async consentLost(): Promise<void> {
    await this.store.update({ lifelogConsent: null, recordingConsent: false }); this.phone.recordingConsent?.(false)
    this.memoryRequest++; await this.stopAmbient()
    if (this.homeMode === 'lifelog') this.setLifelog('consent')
    if (['ambient', 'home'].includes(this.mode)) this.showHome()
  }
  private async revokeLifelog(detail: string): Promise<void> {
    this.memoryRequest++; clearTimeout(this.lifelogKickTimer); clearTimeout(this.lifelogRetryTimer); this.cancelSpeechRecovery()
    await this.stopAmbient()
    const saved = this.store.snapshot().lifelogConsent?.id ?? this.proactive.consentId ?? undefined
    this.proactive.revokeMemory(saved, detail)
    await this.store.update({ lifelogConsent: null })
  }
  private setLifelog(state: LifelogHomeState, detail = ''): void {
    this.lifelogState = state; this.lifelogDetail = detail
    this.phone.lifelogState?.(state, detail)
    if (this.mode === 'home' && this.homeMode === 'lifelog' && !this.noticeTimer && !this.exited && this.store.snapshot().nodeToken) this.renderHome()
  }
  private kickLifelog(delay = 400): void {
    if (this.exited || this.homeMode !== 'lifelog' || this.lifelogUserPaused) return
    clearTimeout(this.lifelogKickTimer)
    // Deferred past the tap delay: a tap that starts a question wins.
    this.lifelogKickTimer = setTimeout(() => { this.lifelogKickTimer = undefined; if (!this.askStarting && !this.ambientRunning) void this.startLifelog() }, delay)
  }
  private scheduleLifelogRetry(): void {
    clearTimeout(this.lifelogRetryTimer)
    const delay = Math.min(300_000, 15_000 * 2 ** Math.min(this.lifelogFailures, 5)); this.lifelogFailures++
    this.lifelogRetryTimer = setTimeout(() => { this.lifelogRetryTimer = undefined; void this.startLifelog() }, delay)
  }
  private lifelogWait(detail: string): void {
    this.setLifelog('waiting', detail); this.phone.memoryStatus?.(false, detail); this.scheduleLifelogRetry()
  }
  private startLifelog(): Promise<void> {
    if (this.lifelogStart) return this.lifelogStart
    const run = this.runLifelog().finally(() => { if (this.lifelogStart === run) this.lifelogStart = null })
    this.lifelogStart = run
    return run
  }
  private async runLifelog(): Promise<void> {
    clearTimeout(this.lifelogRetryTimer); this.lifelogRetryTimer = undefined
    const state = this.store.snapshot()
    if (state.homeMode !== 'lifelog') { this.setLifelog('off'); return }
    if (this.exited || !state.nodeToken) return
    if (this.lifelogUserPaused) { this.setLifelog('paused'); return }
    if (!this.foregroundActive) { this.setLifelog('waiting', 'Agents is in the background on the glasses. Resumes when you return.'); return }
    if (this.ambientRunning) { if (this.proactive.resumeMemory()) this.setLifelog('listening'); return }
    if (this.requestController || this.microphoneOpening || this.recoveringSpeech || this.askStarting || ['listening', 'review', 'thinking', 'pairing'].includes(this.mode)) return
    if (!state.recordingConsent) { this.setLifelog('consent'); this.phone.memoryStatus?.(false, CONSENT_NEEDED); return }
    const request = ++this.memoryRequest
    const current = (): boolean => request === this.memoryRequest && !this.exited && this.foregroundActive && !this.lifelogUserPaused
      && this.store.snapshot().homeMode === 'lifelog' && this.store.snapshot().recordingConsent
    this.setLifelog('starting')
    this.proactive.start()
    try {
      await this.foregroundTransition
      if (!current() || !await this.ensureConsent(current) || !current()) return
      this.proactive.resumeMemory()
      await this.startAmbient()
      if (!current()) { await this.stopAmbient(); return }
      if (!this.ambientRunning) { this.proactive.suspendMemory(); this.lifelogWait('Microphone busy; lifelog starts again in a moment.'); return }
      this.lifelogFailures = 0
      this.setLifelog('listening')
      if (['home', 'ambient'].includes(this.mode)) this.showHome()
    } catch (error) { if (request === this.memoryRequest) await this.pauseAmbientWithError(error) }
  }
  // Reuses main's grant; asks for a new one only when main has none and the
  // owner's standing consent is on. A grant main dropped is never overridden.
  private async ensureConsent(current: () => boolean): Promise<boolean> {
    const saved = this.store.snapshot().lifelogConsent
    if (this.proactive.memoryActive && (!saved || saved.id === this.proactive.consentId)) {
      if (!saved) await this.saveConsent(this.proactive.consentSnapshot())
      return true
    }
    let onMain: MainConsent | null
    try { onMain = await this.proactive.readConsent() }
    catch (error) { if (current()) this.lifelogWait(`Main unreachable (${safeOpenAGIError(error)}). Lifelog starts as soon as main answers.`); return false }
    if (!current()) return false
    if (saved && onMain?.id !== saved.id) {
      await this.store.update({ lifelogConsent: null, recordingConsent: false }); this.phone.recordingConsent?.(false)
      this.setLifelog('consent')
      this.phone.memoryStatus?.(false, 'Your main no longer holds this lifelog consent (turned off or deleted there). Check the consent box again to restart lifelog.')
      return false
    }
    let consent = onMain
    if (consent) this.proactive.adoptConsent(consent)
    else {
      try { consent = await this.proactive.grantMemory(true) }
      catch (error) { if (current()) this.lifelogWait(`Could not record consent on main: ${safeOpenAGIError(error)} Retrying.`); return false }
      if (!consent) return false
    }
    await this.saveConsent(consent)
    return true
  }
  private async saveConsent(consent: MainConsent | null): Promise<void> {
    await this.store.update({ lifelogConsent: consent ? { id: consent.id, grantedAt: consent.grantedAt ?? null, until: consent.until ?? null } : null })
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
    this.renderer.passive?.(this.proactive.capturing)
  }

  async boot(): Promise<void> {
    document.addEventListener('visibilitychange', this.onVisibility)
    if (document.visibilityState === 'hidden') this.startAudioWatch()
    const stored = await this.store.load()
    this.phone.interfaceStyle?.(stored.interfaceStyle)
    this.phone.homeMode?.(stored.homeMode)
    this.phone.recordingConsent?.(stored.recordingConsent)
    this.phone.speechModel?.(stored.speechModel)
    this.phone.speechTransport?.(stored.speechTransport)
    this.phone.autoSend?.(stored.autoSend)
    this.renderer.autoSend?.(stored.autoSend)
    this.renderer.speaker?.(stored.homeMode === 'supervisor' ? 'Supervisor' : 'Agent')
    this.lifelogState = stored.homeMode === 'lifelog' ? 'starting' : 'off'
    if (stored.nodeToken) {
      try {
        if (stored.connectionMode === 'enrollment') {
          await this.heartbeatWithoutLosingEnrollment(stored.node?.name)
          this.startHeartbeat()
        }
        await this.checkExperience()
        if (stored.pendingRequest) { this.showHome(); await this.resumeRequest(false); return }
        if (stored.savedDraft) { this.showHome(); this.reviewDraft(stored.savedDraft, 'speech'); return }
        this.showHome()
        if (stored.homeMode === 'lifelog') { await this.startLifelog(); return }
        if (stored.homeMode === 'talk') {
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
    if (this.exited || this.exitDialogOpening) return
    if (this.displaySleeping) { this.toggleDisplay(); return }
    // A second tap to stop talking is never treated as a bounce.
    if (this.mode !== 'listening' && Date.now() - this.lastTapAt < 400) return
    if (this.navigationBusy) { this.flash('One moment', 'Finishing the last action…'); return }
    if (this.microphoneOpening) {
      // Lifelog is starting its microphone: the question takes over as soon as it can.
      if (this.lifelogStart && ['home', 'ambient', 'answer'].includes(this.mode)) { this.lastTapAt = Date.now(); void this.startAsk(); return }
      this.flash('Microphone opening', 'Wait for Listening, then tap to stop.'); return
    }
    this.lastTapAt = Date.now()
    this.clearNotice()
    if (this.requestController) {
      if (this.cancelConfirmation) this.cancelRequest()
      else if (!this.preparingDraft) { this.activityView = !this.activityView; this.renderActiveProgress?.() }
      else this.flash('Finishing transcript', 'One moment…')
      return
    }
    if (this.mode === 'review') void this.sendDraft()
    else if (this.mode === 'inbox') { this.mode = 'inbox-detail'; this.showInboxPage(); void this.proactive.action('seen', this.inboxItems[this.inboxIndex]?.id) }
    else if (this.mode === 'inbox-detail') { this.actionTarget = { ...this.inboxItems[this.inboxIndex] }; this.actionIndex = 0; this.mode = 'inbox-action'; this.showInboxAction() }
    else if (this.mode === 'inbox-action' || this.mode === 'inbox-confirm') void this.chooseInboxAction()
    else if (this.mode === 'home' && this.homeMode === 'supervisor') this.openInbox(undefined, true)
    else if (['home', 'ambient', 'answer', 'status', 'reconnecting'].includes(this.mode)) void this.startAsk()
    else if (this.mode === 'listening') void this.finishAsk()
    else if (this.mode === 'recent') void this.openRecentEntry(this.recentIndex).catch(error => this.fail(error))
    else if (this.mode === 'message') { this.showHome(); if (this.lifelogState === 'waiting') this.kickLifelog() }
    else if (this.mode === 'unpaired') this.renderer.pairing()
    else if (this.mode === 'pairing') this.flash('Pairing', 'Finish pairing on the phone.')
    else this.flash('Working', 'One moment…')
  }
  // Supervisor home: press and hold to talk to the supervisor, let go to
  // send (no review step). Anywhere else a hold stays a plain tap.
  holdStart(): boolean {
    if (this.exited || this.exitDialogOpening || this.displaySleeping || this.homeMode !== 'supervisor' || this.mode !== 'home') return false
    if (this.navigationBusy || this.microphoneOpening || this.askStarting || this.requestController) return false
    this.pushToTalk = true; this.releasePending = false; this.lastTapAt = Date.now(); this.clearNotice()
    void this.startAsk().then(() => { if (this.releasePending) { this.releasePending = false; void this.releaseToSend() } })
    return true
  }
  holdRelease(): void {
    if (!this.pushToTalk) return
    // Let go before the microphone opened: send once it has.
    if (this.askStarting || this.microphoneOpening) { this.releasePending = true; return }
    void this.releaseToSend()
  }
  private async releaseToSend(): Promise<void> {
    try { if (this.mode === 'listening') await this.finishAsk() }
    finally { this.pushToTalk = false }
  }
  // Push-to-talk sends on release whatever the review setting says.
  private sendsOnFinish(): boolean { return this.pushToTalk || this.store.snapshot().autoSend }
  scrollUp(): void { this.movePage(-1) }
  scrollDown(): void { this.movePage(1) }
  private movePage(direction: number): void {
    if (this.exited || this.displaySleeping) return
    if (this.navigationBusy) { this.flash('One moment', 'Finishing the last action…'); return }
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
    else if (this.mode === 'status') { this.page = Math.max(0, Math.min(this.pages.length - 1, this.page + direction)); this.renderer.fleetStatus(this.pages[this.page] ?? '', this.page, this.pages.length) }
    else if (this.mode === 'home' || this.mode === 'ambient') {
      // Swipe up: Inbox. Swipe down: Recent (Talk), controls (Lifelog) or thread status (Supervisor).
      if (direction < 0) this.openInbox()
      else if (this.homeMode === 'supervisor') void this.showFleetStatus()
      else if (this.homeMode === 'lifelog') this.openLifelogControls()
      else void this.openRecent()
    }
    else if (this.mode === 'recent') this.showRecent(this.recentIndex - direction)
    else if (this.mode === 'listening') this.flash('Listening', this.stopInstruction())
  }
  cancelRequest(): void {
    this.cancelConfirmation = false; this.requestController?.abort(); if (this.preparingDraft) this.stopLiveSpeech()
    if (this.store.snapshot().pendingRequest) void this.api.cancelPending?.().then(() => this.phone.pendingQuestion?.(this.store.snapshot().pendingRequest ? 'Main already finished. Check the saved result.' : null))
      .catch(error => { this.phone.pendingQuestion?.(`Cancel could not be confirmed: ${safeOpenAGIError(error)} Check the saved request.`) })
  }
  async discardDraft(): Promise<void> {
    if (this.mode !== 'review') return
    await this.store.update({ savedDraft: '' })
    this.voiceTarget = null; this.draft = ''; this.phone.draft?.(null); this.showHome(); await this.resumeListening()
  }
  async rerecordDraft(): Promise<void> { if (this.mode !== 'review') return; await this.discardDraft(); await this.startAsk() }
  async sendDraft(): Promise<void> {
    if (this.mode !== 'review' || !this.draft || this.requestController) return
    const text = this.draft; this.draft = ''; this.phone.draft?.(null)
    await this.runQuestion(text)
  }
  private reviewDraft(text: string, recovery?: 'speech' | 'delivery'): void {
    const clean = text.trim()
    if (!clean) throw new Error('No speech was recognized. Nothing was sent; please retry.')
    if (clean.length > 4000) throw new Error('Question is too long. Nothing was sent; please record a shorter question.')
    this.draft = clean; this.draftRecovery = recovery; this.mode = 'review'; this.pages = paginateText(plainAnswer(clean), 220); this.page = 0
    void this.store.update({ savedDraft: clean }).catch(error => this.phone.set('Draft is only on screen', `Could not save it for reopening: ${safeOpenAGIError(error)}`))
    if (this.sendsOnFinish() && !recovery) { this.phone.transcript?.(clean); return }
    this.phone.transcript?.(clean); this.phone.draft?.(clean, recovery)
    this.phone.set('Review question · not sent', 'Tap to send. Double-tap goes back and keeps the draft. Swipe to read, or explicitly Discard on the phone.')
    this.showDraftPage()
  }
  private recoverQuestion(text: string, error: unknown, recovery: 'speech' | 'delivery'): void {
    if (!text.trim() || text.length > 4000) { this.fail(error); return }
    this.reviewDraft(text, recovery)
    const detail = recovery === 'speech'
      ? 'Text may be incomplete. Review, then Send or Re-record. Nothing was sent to the agent.'
      : 'Main may already have received this question. Check its chat before sending again; actions could run twice.'
    this.phone.set(recovery === 'speech' ? 'Transcript recovered · not sent' : 'Delivery uncertain · question retained', `${safeOpenAGIError(error)} ${detail}`)
    this.phone.activity?.(`${recovery === 'speech' ? 'Speech finalization failed' : 'Agent delivery failed'}: ${safeOpenAGIError(error)} ${detail}`)
  }
  private showDraftPage(): void { this.renderer.review?.(this.pages[this.page] ?? '', this.page, this.pages.length, this.draftRecovery) }
  async recentAnswer(): Promise<void> { await this.selectAnswer(this.store.snapshot().history.length - 1) }
  doubleTap(): void {
    if (this.exited) return
    // These are the same root screen in different connection/listening states.
    // Do not tear down on dialog-open: only SYSTEM_EXIT/ABNORMAL_EXIT confirms exit.
    if (['home', 'unpaired', 'ambient', 'reconnecting'].includes(this.mode) && !this.requestController) {
      if (this.displaySleeping) this.toggleDisplay()
      void this.requestExit(); return
    }
    if (this.displaySleeping) { this.toggleDisplay(); return }
    void this.navigateBack().catch(error => this.fail(error))
  }
  async requestExit(): Promise<void> {
    if (this.exited || this.exitDialogOpening) return
    this.exitDialogOpening = true
    this.lastTapAt = Date.now()
    this.clearNotice()
    try {
      if (!await this.renderer.requestExit() && !this.exited) {
        this.phone.set('Exit dialog unavailable', 'Even could not open its exit confirmation. Try double-tap again or use Exit on the phone.')
      }
    } catch (error) {
      if (!this.exited) this.phone.set('Exit dialog unavailable', `${safeOpenAGIError(error)} Try double-tap again or use Exit on the phone.`)
    } finally { this.exitDialogOpening = false }
  }
  toggleDisplay(): void {
    if (this.exited) return
    this.displaySleeping = !this.displaySleeping
    this.renderer.sleep?.(this.displaySleeping)
    this.phone.displaySleeping?.(this.displaySleeping)
  }
  private async navigateBack(): Promise<void> {
    if (this.exited || this.mode === 'pairing') return
    if (this.navigationBusy || this.microphoneOpening) { this.flash('Microphone opening', 'Double-tap again once Listening shows.'); return }
    this.lastTapAt = Date.now()
    this.clearNotice(); this.voiceTarget = null
    if (this.requestController) {
      this.cancelConfirmation = !this.cancelConfirmation
      if (this.cancelConfirmation) this.renderer.confirmCancel?.()
      else this.renderActiveProgress?.()
      return
    }
    if (this.mode === 'review') { this.showHome(); this.phone.set('Draft kept', 'Tap to return to your question. Discard on the phone to delete it.'); return }
    if (this.mode === 'inbox-confirm') { this.mode = 'inbox-action'; this.showInboxAction(); return }
    if (this.mode === 'inbox-action') { if (!this.actionTarget?.id) this.showHome(); else { this.mode = 'inbox-detail'; this.showInboxPage() }; return }
    if (this.mode === 'inbox-detail') { this.showInboxItem(); return }
    if (this.mode === 'inbox' || this.mode === 'status') { this.showHome(); return }
    this.navigationBusy = true
    try {
      if (this.mode === 'listening') { this.stopLiveSpeech(); await this.audio.stop(); this.audioBuffer = null }
      this.showHome()
    } finally { this.navigationBusy = false }
    await this.resumeListening()
  }
  // Talk: the owner's shared agent conversation from every paired device,
  // falling back to answers saved on this phone when main predates it.
  private async openRecent(): Promise<void> {
    const request = ++this.recentRequest
    let entries: RecentEntry[] | null = null
    if (typeof this.api.readThread === 'function') {
      const from = this.mode
      this.renderer.notice?.('Recent', 'Loading from your main…')
      try {
        const page = await this.api.readThread(this.thread)
        if (page) entries = sharedEntries(page.messages)
      } catch (error) { this.phone.activity?.(`Shared conversation unavailable: ${safeOpenAGIError(error)} Showing answers saved on this phone.`) }
      if (request !== this.recentRequest || this.mode !== from || this.exited) return
    }
    this.recentEntries = entries ?? this.store.snapshot().history.map((entry, local) => ({ question: entry.question, reply: entry.reply, local }))
    this.showRecent(this.recentEntries.length - 1)
  }
  private showRecent(index: number): void {
    const entries = this.recentEntries
    if (!entries.length) { this.showHome(); this.flash('No recent answers yet', 'Tap to talk to the agent.'); this.phone.set('No recent answers yet', 'Tap to ask your first question.'); return }
    this.recentIndex = Math.max(0, Math.min(entries.length - 1, index))
    this.mode = 'recent'
    this.renderer.recent?.(plainAnswer(entries[this.recentIndex].question), entries.length - this.recentIndex, entries.length)
  }
  private async openRecentEntry(index: number): Promise<void> {
    const entry = this.recentEntries[index]; if (!entry) return
    if (entry.local !== undefined) { await this.selectAnswer(entry.local); return }
    // Shared entries are one continuous conversation; a follow-up goes there.
    this.pages = paginateText(plainAnswer(entry.reply || 'No answer yet.'), 260); this.phone.preview?.(plainAnswer(entry.reply)); this.showAnswer(0)
  }
  async systemExit(): Promise<void> {
    this.stopAudioWatch()
    this.cancelSpeechRecovery()
    this.clearNotice()
    clearTimeout(this.lifelogKickTimer); clearTimeout(this.lifelogRetryTimer)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.memoryRequest++
    // Local only: consent stays on main for the next time Agents opens.
    this.proactive.stop()
    this.exited = true
    this.stopLiveSpeech()
    // Closing the observer is not cancellation of main-owned accepted work.
    this.requestController?.abort()
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
      await this.checkExperience()
      await this.resumeListening()
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
    this.memoryRequest++; clearTimeout(this.lifelogRetryTimer)
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
    await this.store.clearCredential(); this.phone.recordingConsent?.(false); this.showUnpaired()
  }
  async newConversation(): Promise<void> {
    if (this.store.snapshot().pendingRequest || this.store.snapshot().savedDraft) { this.phone.set('Keep your current question', 'Finish or clear your saved question before starting a new chat.'); return }
    if (this.mode === 'review') return
    if (this.mode === 'thinking' || this.mode === 'listening' || this.mode === 'pairing' || this.ambientProcessing) return
    await this.store.update({ conversationId: crypto.randomUUID(), continuation: null }); this.pages = []; this.phone.preview?.(''); this.showHome(); this.phone.set('New conversation', 'Your next question starts a fresh agent chat.')
  }
  async selectAnswer(index: number): Promise<void> {
    if (this.store.snapshot().pendingRequest || this.store.snapshot().savedDraft) return
    if (this.mode === 'review') return
    if (this.mode === 'thinking' || this.mode === 'listening' || this.mode === 'pairing' || this.ambientProcessing) return
    const entry = this.store.snapshot().history[index]
    if (!entry) return
    await this.store.update({ conversationId: entry.conversationId, continuation: entry.continuation })
    this.pages = paginateText(plainAnswer(entry.reply), 260); this.phone.paired(true); this.showAnswer(0)
    this.phone.history?.(this.store.snapshot().history); this.phone.preview?.(entry.reply)
    this.phone.set('Conversation resumed', `${entry.question} — Tap the glasses to ask a follow-up, or use Talk on the phone.`)
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
    // Switching agents is an explicit choice: withdraw the old main's grant.
    this.memoryRequest++
    if (this.proactive.memoryActive) this.proactive.revokeMemory()
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
    await this.checkExperience()
    await this.resumeListening()
  }
  async startAsk(): Promise<void> {
    if (this.askStarting) { this.flash('Microphone opening', 'One moment…'); return }
    this.askStarting = true
    try { await this.beginAsk() } finally { this.askStarting = false }
    if (['message'].includes(this.mode)) await this.resumeListening()
  }
  private async beginAsk(): Promise<void> {
    // A lifelog microphone that is opening finishes first, then hands over.
    if (this.lifelogStart) await this.lifelogStart.catch(() => undefined)
    const state = this.store.snapshot()
    if (state.pendingRequest) { this.phone.pendingQuestion?.('Check your saved question before asking another. Reconnecting will not submit it twice.'); this.flash('Saved question waiting', 'Check it on the phone before asking again.'); return }
    if (this.mode !== 'review' && state.savedDraft) { this.reviewDraft(state.savedDraft, 'speech'); return }
    if (this.exited) return
    if (this.navigationBusy || this.microphoneOpening || this.requestController) { this.flash('Busy', 'Finish the current question first.'); return }
    if (!this.foregroundActive) { this.phone.set('Agents is in the background', 'Open Agents on the glasses, then tap to talk.'); return }
    if (this.mode === 'review') { await this.sendDraft(); return }
    if (this.mode === 'listening') { await this.finishAsk(); return }
    if (this.recoveringSpeech) { this.cancelSpeechRecovery(); this.memoryRequest++ }
    this.clearNotice()
    if (this.mode.startsWith('inbox')) { const selected = this.mode === 'inbox-action' || this.mode === 'inbox-confirm' ? this.actionTarget : this.inboxItems[this.inboxIndex]; this.voiceTarget = selected?.id ? { ...selected } : null; this.showHome() }
    if (['message', 'answer', 'recent', 'status', 'reconnecting', 'ambient'].includes(this.mode)) this.showHome()
    if (this.ambientRunning) {
      this.memoryRequest++
      await this.stopAmbient('Lifelog paused while you talk; it resumes after your question.')
      this.showHome()
    }
    if (this.mode !== 'home' || !this.store.snapshot().nodeToken) return
    if (this.store.snapshot().speechModel !== 'openai-buffered') { await this.startLiveAsk(); return }
    this.mode = 'listening'; this.audioBuffer = new QuestionAudioBuffer(); this.renderer.progress?.('Opening microphone', 'Please wait'); this.phone.set('Opening microphone…', 'Waiting for audio from your glasses. Keep the Even app open.')
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
  }
  async finishAsk(): Promise<void> {
    if (!this.microphoneOpening && this.mode === 'listening' && this.liveSpeech) {
      const speech = this.liveSpeech
      this.mode = 'thinking'; clearTimeout(this.liveCaptureTimer)
      const controller = new AbortController(); this.requestController = controller; this.preparingDraft = true
      let finalized = false
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
        finalized = true
      } catch (error) {
        const text = speech.snapshotText?.() ?? ''
        this.stopLiveSpeech()
        if (!this.exited && !controller.signal.aborted) this.recoverQuestion(text, error, 'speech')
      }
      finally { await this.finishDraftPreparation(controller) }
      if (finalized && !controller.signal.aborted && !this.exited && this.sendsOnFinish()) await this.sendDraft()
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
    if (this.sendsOnFinish() && !this.voiceTarget) { await this.runQuestion(audio.toWav()); return }
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
    if (this.voiceTarget && this.sendsOnFinish() && !controller.signal.aborted && !this.exited) await this.sendDraft()
  }
  private async finishDraftPreparation(controller: AbortController): Promise<void> {
    this.requestController = null; this.preparingDraft = false; this.cancelConfirmation = false; this.renderActiveProgress = null
    this.phone.requestActive?.(false)
    if (controller.signal.aborted && !this.exited) { this.showHome(); await this.resumeListening() }
    else if (this.mode === 'message') await this.resumeListening()
  }
  private stopInstruction(): string { return this.pushToTalk ? 'Let go to send.' : this.store.snapshot().autoSend ? 'Tap to stop and send automatically.' : 'Tap to stop and review before sending.' }
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
  private async runQuestion(input: Blob | string, recovery?: { resume: boolean; allowSubmit: boolean }): Promise<void> {
    if (this.requestController) return
    try { await this.store.update({ savedDraft: '' }) }
    catch (error) { this.phone.set('Question not sent', `Could not save delivery state: ${safeOpenAGIError(error)}`); return }
    if (this.requestController || this.exited) return
    const originalInput = input
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
    // Talk and Lifelog share the owner's agent conversation across devices;
    // Supervisor mode talks to the supervisor's own thread.
    const thread = this.thread
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
    let received: { question: string; reply: string } | undefined
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
      const result = recovery?.resume ? await this.api.resumePending(onProgress, controller.signal, recovery.allowSubmit) : typeof input === 'string'
        ? await this.api.askText(input, conversationId, onProgress, controller.signal, thread)
        : await this.api.ask(input, conversationId, onProgress, controller.signal, thread)
      received = result
      await this.store.update({ savedDraft: '' })
      this.phone.pendingQuestion?.(null); this.phone.draft?.(null)
      await this.store.remember(result.question, result.reply)
      this.phone.history?.(this.store.snapshot().history); this.phone.preview?.(plainAnswer(result.reply))
      this.pages = paginateText(plainAnswer(result.reply), 260); this.showAnswer(Math.min(this.page, this.pages.length - 1))
      this.phone.set('Answer ready', `${this.pages.length} page${this.pages.length === 1 ? '' : 's'} on G2`)
    } catch (error) {
      // Main rejected the request outright (it predates this feature): nothing ran.
      const rejected = error instanceof OpenAGIApiError && error.code === 'threads_unsupported'
      if (received) {
        // Delivery succeeded. A local persistence/rendering failure must not
        // discard the completed answer or offer to repeat completed actions.
        this.phone.preview?.(plainAnswer(received.reply))
        this.pages = paginateText(plainAnswer(received.reply), 260); this.showAnswer(Math.min(this.page, this.pages.length - 1))
        this.phone.set('Answer received · local update failed', `${safeOpenAGIError(error)} The agent already completed this question. Do not resend to retry saving history.`)
        this.phone.activity?.(`Answer received; local update failed: ${safeOpenAGIError(error)}`)
      } else if (rejected) this.fail(error)
      else if (partial) {
        await this.store.remember(question, `Incomplete answer:\n${plainAnswer(partial)}`).catch(() => undefined)
        this.phone.history?.(this.store.snapshot().history)
        this.phone.preview?.(`Incomplete answer:\n${plainAnswer(partial)}`)
        this.pages = paginateText(`Incomplete answer:\n${plainAnswer(partial)}`, 260); this.showAnswer(Math.min(this.page, this.pages.length - 1))
      } else if (controller.signal.aborted) {
        this.mode = 'message'; this.renderer.message('Request stopped', 'No automatic retry. Completed actions cannot be undone. Your recent answers are still saved.')
      } else this.fail(error)
      if (!received && !rejected && this.store.snapshot().pendingRequest) {
        this.phone.pendingQuestion?.(`${safeOpenAGIError(error)} Your question is saved. Check the same request, or review History before clearing it.`)
        this.mode = 'message'; this.renderer.message('Question saved', 'Connection interrupted. Check saved request on phone; it will not send twice.')
        this.phone.set('Question saved · needs attention', safeOpenAGIError(error))
      } else if (!received && !rejected) {
        if (!partial && !controller.signal.aborted && !this.exited && typeof originalInput === 'string') {
          this.voiceTarget = target
          this.recoverQuestion(originalInput, error, 'delivery')
        }
        else this.phone.set(controller.signal.aborted ? 'Request interrupted' : 'Connection interrupted', `${safeOpenAGIError(error)} No automatic retry. Recent answers remain available.`)
      }
    } finally { clearInterval(timer); this.cancelConfirmation = false; this.renderActiveProgress = null; this.requestController = null; this.phone.requestActive?.(false); await this.resumeListening() }
  }
  private showUnpaired(): void { this.proactive.stop(); this.mode = 'unpaired'; this.phone.paired(false); this.renderer.unpaired(); this.phone.set('Connect an agent', 'Pair OpenAGI or add an allowed agent URL and scoped token.') }
  private renderHome(items = this.proactive.items): void {
    const state = this.store.snapshot()
    if (state.homeMode === 'supervisor') this.renderer.supervisorHome(items.filter(i => i.supervisor).length)
    else if (state.homeMode === 'lifelog') this.renderer.lifelogHome?.(this.lifelogState === 'off' ? 'starting' : this.lifelogState, this.lifelogDetail)
    else this.renderer.home(state.node?.name ?? (state.connectionMode === 'direct' ? 'Agent' : undefined))
  }
  private showHome(): void {
    this.phone.history?.(this.store.snapshot().history)
    const state = this.store.snapshot(); if (!state.nodeToken) { this.showUnpaired(); return }
    this.proactive.start()
    if (state.agentOrigin) this.phone.mainInbox?.(state.agentOrigin)
    this.phone.paired(true)
    if (state.homeMode === 'lifelog' && this.ambientRunning) {
      this.mode = 'ambient'; this.listeningPulse(true)
      this.phone.set('Lifelog on', 'Listening and saving final text to your main. Tap the glasses to talk to the agent; swipe down to mark a moment or pause.')
      return
    }
    this.mode = 'home'; this.renderHome()
    if (state.homeMode === 'supervisor') this.phone.set('Supervisor', 'Tap on the glasses for the supervisor’s questions, or thread status when there are none. Press and hold to talk to the supervisor; let go to send. Swipe down: thread status.')
    else if (state.homeMode === 'lifelog') this.phone.set(this.lifelogState === 'consent' ? 'Lifelog needs consent' : this.lifelogState === 'paused' ? 'Lifelog paused' : 'Lifelog', this.lifelogState === 'consent' ? CONSENT_NEEDED : this.lifelogDetail || 'Tap the glasses to talk to the agent. Swipe down for lifelog controls.')
    else this.phone.set('Talk', 'Tap the glasses to talk to the agent; tap again to send. Swipe down: recent. Swipe up: inbox. Double-tap at home: exit.')
  }
  private showAnswer(page: number): void { this.mode = 'answer'; this.page = page; this.renderer.answer(this.pages[page] ?? '', page, this.pages.length) }
  private fail(error: unknown): void { this.voiceTarget = null; this.clearNotice(); this.mode = 'message'; const message = safeOpenAGIError(error); this.renderer.message('Could not ask agent', message); this.phone.set('Ask failed', message) }
  private async startAmbient(): Promise<void> {
    if (this.exited || this.ambientRunning || this.microphoneOpening || !this.foregroundActive) return
    if (this.store.snapshot().speechModel !== 'openai-buffered') { await this.startLiveAmbient(); return }
    this.microphoneOpening = true
    try {
      if (this.audio.active) await this.audio.stop()
      this.ambientSegmenter = new AmbientAudioSegmenter()
      this.ambientQueue = []
      let received = 0
      let displayedSecond = -1
      this.lastAudioAt = Date.now()
      await this.audio.start(pcm => {
        try {
          if (pcm.byteLength) this.lastAudioAt = Date.now()
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
    } finally { this.microphoneOpening = false }
  }
  private async stopAmbient(reason?: string): Promise<void> {
    this.ambientEpoch++
    this.proactive.suspendMemory(reason)
    this.stopLiveSpeech()
    this.ambientRunning = false
    this.ambientSegmenter?.reset()
    this.ambientSegmenter = null
    this.ambientQueue = []
    if (this.audio.active) await this.audio.stop().catch(() => undefined)
  }
  // After any question or screen change: Lifelog listens again by itself.
  private async resumeListening(): Promise<void> {
    if (this.mode === 'review' || this.exited || !this.foregroundActive) return // Keep recovery text visible until Send or Discard.
    if (this.homeMode !== 'lifelog' || this.lifelogUserPaused) return
    await this.startLifelog()
  }
  async configureSpeech(model: SpeechModel, transport = this.store.snapshot().speechTransport): Promise<void> {
    if (this.microphoneOpening || this.navigationBusy || this.requestController || this.mode === 'review' || this.mode === 'listening' || this.mode === 'pairing') {
      this.phone.speechModel?.(this.store.snapshot().speechModel)
      this.phone.speechTransport?.(this.store.snapshot().speechTransport)
      this.phone.set('Speech model unchanged', 'Finish the current question before switching speech models.'); return
    }
    this.navigationBusy = true
    try {
      this.memoryRequest++; this.cancelSpeechRecovery()
      await this.stopAmbient('Switching speech model.')
      await this.store.update({ speechModel: model, speechTransport: transport })
      this.phone.speechModel?.(model)
      this.phone.speechTransport?.(transport)
    } catch (error) { this.phone.set('Could not switch speech model', safeOpenAGIError(error)) }
    finally { this.navigationBusy = false }
    if (['home', 'ambient'].includes(this.mode)) this.showHome()
    await this.resumeListening()
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
          else this.renderer.transcript?.(text)
        }
      },
      segment: (text, metadata) => {
        if (ambient && this.ambientRunning && this.liveSpeech === speech && !this.exited) this.proactive.capture(text, metadata)
      },
      // Lifelog never turns overheard speech into a question: talking to the
      // agent is always an explicit tap.
      utterance: () => undefined,
      error: error => {
        if (this.liveSpeech !== speech || this.exited) return
        if (ambient && this.recoveringSpeech) { this.recoveryFailure = error; return }
        if (ambient) void this.recoverAmbientSpeech(error)
        else if (!this.preparingDraft) {
          const text = speech.snapshotText?.() ?? ''
          this.stopLiveSpeech(); void this.audio.stop().catch(() => undefined)
          this.recoverQuestion(text, error, 'speech')
        }
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
    this.renderer.progress?.('Opening microphone', 'Please wait')
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
  }
  private async startLiveAmbient(): Promise<void> {
    this.microphoneOpening = true
    try {
      const speech = await this.openLiveSpeech(true)
      if (this.exited || !this.foregroundActive || this.liveSpeech !== speech) { speech.close(); return }
      this.lastAudioAt = Date.now()
      await this.audio.start(pcm => {
        if (this.liveSpeech !== speech || this.exited) return
        if (pcm.byteLength) this.lastAudioAt = Date.now()
        speech.push(pcm); this.listeningPulse()
      })
      if (this.exited || !this.foregroundActive || this.liveSpeech !== speech) { await this.audio.stop(); return }
      this.ambientRunning = true
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
        // Transcription only: overheard speech never starts the agent.
        const result = await this.api.listen(utterance, state.conversationId, { wakePhrase: state.wakePhrase, answerQuestions: false, forceAnswer: false })
          .catch(error => { if (epoch !== this.ambientEpoch) return null; throw error })
        if (!result || !this.ambientRunning || epoch !== this.ambientEpoch) continue
        this.phone.transcript?.(result.question)
        this.lastAmbientSpeechAt = Date.now()
        this.proactive.capture(result.question)
        this.listeningPulse()
      }
    } catch (error) { await this.pauseAmbientWithError(error) }
    finally {
      this.ambientProcessing = false
      if (this.ambientRunning && this.ambientQueue.length) void this.drainAmbientQueue()
    }
  }
  // Local only: consent stays on and the next glasses gesture (or a timed
  // retry) starts listening again.
  private async pauseAmbientWithError(error: unknown): Promise<void> {
    this.cancelSpeechRecovery()
    this.memoryRequest++
    await this.stopAmbient()
    const detail = `${safeOpenAGIError(error)} Microphone off; consent stays on. Lifelog retries on your next glasses gesture.`
    if (this.homeMode === 'lifelog') { this.setLifelog('waiting', detail); this.phone.memoryStatus?.(false, detail); this.scheduleLifelogRetry() }
    if (this.requestController) { this.phone.transcript?.(`Microphone stopped: ${safeOpenAGIError(error)}. Agent request continues separately.`); return }
    if (['ambient', 'home', 'reconnecting'].includes(this.mode)) { this.mode = 'message'; this.renderer.message('Microphone stopped', detail) }
    this.phone.set('Lifelog waiting', detail)
  }
  private async recoverAmbientSpeech(error: Error): Promise<void> {
    if (this.recoveringSpeech) return // The in-flight attempt owns its failure.
    if (!(error instanceof SpeechStreamError) || !error.recoverable || !this.ambientRunning || !this.proactive.memoryActive || !this.foregroundActive || this.exited || this.requestController) {
      await this.pauseAmbientWithError(error); return
    }
    this.recoveringSpeech = true
    const epoch = ++this.recoveryEpoch, state = this.store.snapshot(), consentRequest = this.memoryRequest
    const stillAllowed = (): boolean => epoch === this.recoveryEpoch && !this.exited && this.foregroundActive
      && this.proactive.memoryActive && consentRequest === this.memoryRequest && this.homeMode === 'lifelog' && !this.lifelogUserPaused
      && state.nodeToken === this.store.snapshot().nodeToken && state.agentOrigin === this.store.snapshot().agentOrigin
    const previous = this.mode, page = this.page
    await this.stopAmbient('Audio gap · reconnecting with fresh audio.')
    if (!stillAllowed()) { if (epoch === this.recoveryEpoch) await this.pauseAmbientWithError(new Error('Lifelog recovery stopped.')); return }
    // A new LiveSpeech has a new stream id and no old partial utterance or audio.
    this.phone.activity?.(`Audio gap: ${error.message} Unfinalized words were discarded; previously finalized text is retained.`)
    this.phone.saveStatus?.('Audio gap · reconnecting with fresh audio. No old audio will be replayed.')
    const schedule = (): void => {
      this.recoveryAttempts = this.recoveryAttempts.filter(at => Date.now() - at < 60_000)
      if (this.recoveryAttempts.length >= 3) { void this.pauseAmbientWithError(new Error('Live speech recovery stopped after three attempts in one minute.')); return }
      if (['ambient', 'home', 'reconnecting'].includes(this.mode)) { this.mode = 'reconnecting'; this.renderer.notice?.('Audio gap · reconnecting', 'Tap: talk to agent · Double-tap: exit') }
      this.phone.set('Lifelog reconnecting', 'Microphone off. Some words may be missing. Consent stays on.')
      this.recoveryTimer = setTimeout(() => { void attempt() }, 1000 * 2 ** this.recoveryAttempts.length)
    }
    const attempt = async (): Promise<void> => {
      this.recoveryTimer = undefined
      if (!stillAllowed()) { if (epoch === this.recoveryEpoch) await this.pauseAmbientWithError(new Error('Lifelog recovery stopped.')); return }
      this.recoveryAttempts.push(Date.now())
      try {
        this.recoveryFailure = null
        this.proactive.resumeMemory()
        await this.startAmbient()
        // Speech callbacks can set this during the awaited connection setup.
        const recoveryFailure = this.recoveryFailure as Error | null
        if (recoveryFailure) throw recoveryFailure
        if (!stillAllowed()) { if (epoch === this.recoveryEpoch) await this.stopAmbient(); return }
        this.recoveringSpeech = false
        this.setLifelog('listening')
        this.phone.activity?.('Lifelog reconnected. New transcript stream started after the audio gap.')
        if (previous === 'answer' && this.mode === 'reconnecting') this.showAnswer(page)
        else if (['home', 'ambient', 'reconnecting'].includes(this.mode)) this.showHome()
      } catch (retryError) {
        if (epoch !== this.recoveryEpoch) return
        await this.stopAmbient()
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

// Pairs the shared conversation into question/answer entries, oldest first.
// Messages from other devices are labelled with the device name.
function sharedEntries(messages: SharedThreadMessage[]): RecentEntry[] {
  const entries: RecentEntry[] = []
  for (const message of messages) {
    if (message.role === 'user') entries.push({ question: message.sourceName ? `${message.sourceName}: ${message.text}` : message.text, reply: '' })
    else if (entries.length && !entries[entries.length - 1].reply) entries[entries.length - 1].reply = message.text
    else entries.push({ question: 'Earlier', reply: message.text })
  }
  return entries.slice(-30)
}

function createNodeToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
