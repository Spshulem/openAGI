import type { OpenAGIApiClient } from './api-client'
import { OpenAGIApiError } from './config'

export interface InboxItem { id: string; title: string; summary: string; category: string; important: boolean; seen: boolean; notified?: boolean; action: string; taskId?: string; dueDate?: string; reminder?: boolean; suggestedDate?: string; timeZone?: string; supervisor?: boolean; options?: string[] }
// The supervisor's glanceable status: counts by colour, red then yellow threads.
export interface FleetStatus { mode: string | null; lastTickAt: string | null; needsYou: number; counts: { red: number; yellow: number; green: number; gray: number }; threads: { name: string; health: string; state: string; reason: string }[] }
export type InboxOperation = 'seen' | 'dismiss' | 'snooze' | 'accept-task' | 'complete-task' | 'delete-memory'
export interface ProactiveSettings { enabled: boolean; categories: string[]; retentionDays: number; quietStart: number; quietEnd: number; timeZone: string; maxPerHour: number; supervisorOnly?: boolean }
export interface ProactiveView {
  proactiveSettings?(settings: ProactiveSettings): void
  inbox?(items: InboxItem[]): void
  memoryStatus?(active: boolean, detail: string): void
  activity?(text: string): void
  saveStatus?(text: string): void
  consentLost?(): void
}

export interface MainConsent { id: string; grantedAt?: number | null; until?: number | null }

// This timer only reads persisted notifications; it never starts agent work.
// Ambient uploads are final text only, opt-in, and never replayed.
// Consent is persistent: suspendMemory() stops capture locally (app in the
// background, microphone paused); only revokeMemory() withdraws it on main.
export class G2ProactiveClient {
  items: InboxItem[] = []
  /** Main holds a recording consent for this G2. */
  get memoryActive(): boolean { return Boolean(this.consent) }
  /** Final text is being retained right now. */
  get capturing(): boolean { return Boolean(this.consent) && !this.suspended && this.running && this.foreground }
  get consentId(): string | null { return this.consent?.id ?? null }
  private timer: ReturnType<typeof setInterval> | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private consent: MainConsent | null = null
  private suspended = true
  private queue: { text: string; at: number; endAt: number; streamId: string; speaker: number | null }[] = []
  private bufferedStreamId = crypto.randomUUID()
  private generation = 0
  private controller = new AbortController()
  private refreshing = false
  // A refresh asked for mid-flight runs once the current one ends; bumping
  // feedGeneration drops the in-flight snapshot (it predates an answer).
  private refreshQueued = false
  private feedGeneration = 0
  private uploading = false
  private running = false
  private foreground = true
  private hidden(): boolean { return !this.foreground }
  setForeground(active: boolean): void {
    if (this.foreground === active) return
    this.foreground = active
    if (!active) { this.suspendMemory(); this.controller.abort(); this.controller = new AbortController() }
    else if (this.running) void this.refresh()
  }
  // The phone screen does not gate anything; becoming visible just refreshes.
  private visibility = (): void => { if (document.visibilityState !== 'hidden' && this.running && !this.hidden()) void this.refresh() }
  constructor(private readonly api: OpenAGIApiClient, private readonly view: ProactiveView, private readonly canNotify: () => boolean, private readonly notify: (item: InboxItem) => void) {}
  consentSnapshot(): MainConsent | null { return this.consent ? { ...this.consent } : null }
  /** Stops capture locally and drops unsent text. Consent stays on main. */
  suspendMemory(detail = 'Lifelog paused on this device. Microphone off; consent stays on. Unsent text is not replayed.'): void {
    const wasCapturing = !this.suspended
    this.generation++; this.suspended = true; this.queue = []
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (wasCapturing) this.view.memoryStatus?.(false, detail)
  }
  resumeMemory(): boolean {
    if (!this.consent || !this.running || this.hidden()) return false
    if (this.suspended) { this.suspended = false; this.view.memoryStatus?.(true, 'Lifelog on. Final text is saved on your main; speakers are unverified.') }
    return true
  }
  /** Main's current grant for this G2, or null. Throws when main is unreachable. */
  async readConsent(): Promise<MainConsent | null> {
    const result = await this.api.proactive({ op: 'settings' }, this.controller.signal)
    return result.consent?.id ? { ...result.consent } : null
  }
  /** Adopts a grant main confirmed. Capture stays suspended until resumeMemory(). */
  adoptConsent(consent: MainConsent): void {
    if (this.consent?.id !== consent.id) { this.generation++; this.queue = []; this.suspended = true }
    this.consent = { ...consent }
  }
  start(): void {
    if (this.running || typeof this.api.proactive !== 'function') return
    this.running = true; this.controller = new AbortController()
    document.addEventListener('visibilitychange', this.visibility)
    void this.refresh()
    this.timer = setInterval(() => { if (!this.hidden()) void this.refresh() }, 60_000)
  }
  /** Local teardown only: never revokes consent on main. */
  stop(): void {
    this.running = false; this.suspendMemory(); this.consent = null; this.controller.abort()
    if (this.timer) clearInterval(this.timer)
    this.timer = null; document.removeEventListener('visibilitychange', this.visibility)
    this.items = []; this.view.inbox?.([])
  }
  async refresh(): Promise<void> {
    if (!this.running || this.hidden()) return
    if (this.refreshing) { this.refreshQueued = true; return }
    this.refreshing = true
    const signal = this.controller.signal
    const feedGeneration = this.feedGeneration
    try {
      const result = await this.api.proactive({ op: 'feed' }, signal)
      if (!this.running || signal.aborted || feedGeneration !== this.feedGeneration) return
      this.items = result.items ?? []; this.view.inbox?.(this.items)
      if (result.settings) this.view.proactiveSettings?.(result.settings)
      // Do not claim a notification until the app says it can show it safely.
      // Supervisor mode pings for its own questions without the general opt-in.
      const item = this.items.find(i => i.important && !i.seen && !i.notified && (result.settings?.enabled === true || (result.settings?.supervisorOnly === true && i.supervisor === true)))
      if (item && !result.quiet && this.canNotify()) {
        const allowed = await this.api.proactive({ op: 'can-notify', id: item.id }, signal)
        if (!signal.aborted && this.running && allowed.notify && this.canNotify()) {
          this.notify(item)
          item.notified = true
          await this.api.proactive({ op: 'notify', id: item.id }, signal)
        }
      }
    } catch (error) { if (!signal.aborted) this.view.activity?.(`Inbox unavailable: ${error instanceof Error ? error.message : 'check main connection'}`) }
    finally {
      this.refreshing = false
      if (this.refreshQueued) { this.refreshQueued = false; void this.refresh() }
    }
  }
  // Answers a supervisor question with one of its fixed choices. ok=false
  // means main kept the question open (the agent was not reached yet).
  async answer(id: string, answer: string): Promise<{ ok: boolean; detail: string }> {
    try {
      const result = await this.api.proactive({ op: 'answer', id, answer }, this.controller.signal) as unknown as { ok?: boolean; detail?: string }
      // A feed read that started before the answer must not bring it back.
      this.feedGeneration++
      if (result.ok === true) { this.items = this.items.filter(i => i.id !== id); this.view.inbox?.(this.items) }
      await this.refresh()
      return { ok: result.ok === true, detail: result.detail ?? '' }
    } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : 'Main did not answer' } }
  }
  async fleetStatus(): Promise<FleetStatus | null> {
    try { return await this.api.proactive({ op: 'fleet-status' }, this.controller.signal) as unknown as FleetStatus }
    catch { return null }
  }
  async configure(settings: Partial<ProactiveSettings>): Promise<void> {
    try { await this.api.proactive({ op: 'configure', settings }, this.controller.signal); await this.refresh() }
    catch (error) { this.view.activity?.(`Could not save inbox settings: ${String(error)}`) }
  }
  /** Asks main for a new grant after the owner's explicit consent. */
  async grantMemory(recordingConsent: boolean): Promise<MainConsent | null> {
    if (!this.running || !recordingConsent) return null
    const generation = this.generation
    const result = await this.api.proactive({ op: 'consent', enabled: true, recordingConsent }, this.controller.signal)
    if (!result.consent?.id) return null
    if (generation !== this.generation || !this.running) {
      void this.api.proactive({ op: 'consent', enabled: false, consentId: result.consent.id }).catch(() => {})
      return null
    }
    this.adoptConsent(result.consent)
    return this.consentSnapshot()
  }
  /** Withdraws the grant on main. Only for an explicit owner choice. */
  revokeMemory(consentId = this.consent?.id, detail = 'Lifelog off. New transcripts are not retained. Existing transcripts follow your retention setting.'): void {
    this.generation++; this.suspended = true; this.queue = []; this.consent = null
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null; this.view.memoryStatus?.(false, detail)
    if (consentId) void this.api.proactive({ op: 'consent', enabled: false, consentId }).catch(() => {})
  }
  capture(text: string, metadata?: { at: number; endAt: number; streamId: string; speaker: number | null }): void {
    if (!this.capturing) return
    const trimmed = text.trim()
    if (!trimmed) return
    const previous = this.queue.at(-1)
    // Provider final events can arrive much faster than the upload cadence.
    // Coalesce adjacent words from the same speaker without crossing streams.
    if (metadata && previous && previous.streamId === metadata.streamId && previous.speaker === metadata.speaker
      && metadata.at >= previous.endAt && metadata.at - previous.endAt < 5000 && metadata.endAt - previous.at <= 60000
      && previous.text.length + trimmed.length < 950) {
      previous.text += ` ${trimmed}`; previous.endAt = metadata.endAt; return
    }
    // A full buffer (main unreachable for a long time) drops new text rather
    // than turning lifelog off; consent is untouched.
    if (trimmed.length > 1000 || this.queue.length >= 100) { this.view.saveStatus?.('Text not saved: waiting for main. Lifelog stays on.'); return }
    this.queue.push({ text: trimmed, ...(metadata ?? { at: Date.now(), endAt: Date.now(), streamId: this.bufferedStreamId, speaker: null }) })
    this.view.saveStatus?.('Final text waiting to save on main')
    if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush() }, 30_000)
  }
  private async flush(): Promise<void> {
    if (!this.consent || !this.queue.length || this.uploading || !this.running) return
    if (!this.capturing) { this.suspendMemory(); return }
    this.uploading = true
    const segments = this.queue.splice(0, 10), texts = segments.map(s => s.text), generation = this.generation, consentId = this.consent.id
    try {
      await this.api.proactive({ op: 'capture', consentId, batchId: crypto.randomUUID(), texts, segments: segments.map(s => ({ at: s.at, endAt: s.endAt, streamId: s.streamId, speaker: s.speaker })) }, this.controller.signal)
      if (generation === this.generation) {
        this.view.activity?.(`Saved ${texts.length} final transcript segment(s) to main; checking explicit commitments.`)
        this.view.saveStatus?.(`Saved on main at ${new Date().toLocaleTimeString()}`)
        await this.refresh()
      }
    } catch (error) {
      if (generation !== this.generation) return
      // 403: main no longer holds this grant (revoked on main). Anything else
      // is a transient failure: drop this batch (no replay) and keep going.
      if (error instanceof OpenAGIApiError && error.status === 403 && this.consent?.id === consentId) {
        this.suspendMemory(); this.consent = null
        this.view.memoryStatus?.(false, 'Main no longer holds your lifelog consent (revoked or deleted on main). Microphone off.')
        this.view.consentLost?.()
      } else this.view.saveStatus?.('Upload failed; that text was not saved and is not replayed. Lifelog stays on.')
    }
    finally { this.uploading = false; if (this.queue.length && this.capturing && !this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush() }, 16_000) }
  }
  async markMoment(): Promise<boolean> {
    if (!this.capturing) { this.view.activity?.('Lifelog must be listening before marking a moment.'); return false }
    try {
      await this.api.proactive({ op: 'mark-moment', consentId: this.consent!.id }, this.controller.signal)
      this.view.activity?.('Moment marked on main, linked to the latest saved words.'); return true
    } catch (error) { this.view.activity?.(`Moment not marked: ${String(error)}`); return false }
  }
  async action(op: InboxOperation, id?: string, extra: Record<string, unknown> = {}): Promise<boolean> {
    // Main clears its grant with the transcripts.
    if (op === 'delete-memory') { this.suspendMemory(); this.consent = null }
    try {
      await this.api.proactive({ ...extra, op, id, ...(['accept-task', 'complete-task'].includes(op) ? { confirm: true } : {}) }, this.controller.signal)
      this.view.activity?.(op === 'complete-task' ? 'Task completed on OpenAGI main. External source was not changed.' : op === 'accept-task' ? 'Added to your user tasks on main. No agent action was started.' : op === 'delete-memory' ? 'Retained transcripts and suggestions deleted; accepted tasks remain.' : 'Inbox updated')
      await this.refresh()
      return true
    } catch (error) { this.view.activity?.(`Inbox action failed: ${String(error)}`); return false }
  }
}
