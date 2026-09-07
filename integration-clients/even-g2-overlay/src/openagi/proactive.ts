import type { OpenAGIApiClient } from './api-client'

export interface InboxItem { id: string; title: string; summary: string; category: string; important: boolean; seen: boolean; notified?: boolean; action: string }
export interface ProactiveSettings { enabled: boolean; categories: string[]; retentionDays: number; quietStart: number; quietEnd: number; timeZone: string; maxPerHour: number }
export interface ProactiveView {
  proactiveSettings?(settings: ProactiveSettings): void
  inbox?(items: InboxItem[]): void
  memoryStatus?(active: boolean, detail: string): void
  activity?(text: string): void
}

// This timer only reads persisted notifications; it never starts agent work.
// Ambient uploads are final text only, opt-in, ephemeral and never replayed.
export class G2ProactiveClient {
  items: InboxItem[] = []
  get memoryActive(): boolean { return Boolean(this.consent && this.consent.until > Date.now()) }
  private timer: ReturnType<typeof setInterval> | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private consent: { id: string; until: number } | null = null
  private queue: { text: string; at: number; endAt: number; streamId: string; speaker: number | null }[] = []
  private bufferedStreamId = crypto.randomUUID()
  private generation = 0
  private controller = new AbortController()
  private refreshing = false
  private uploading = false
  private running = false
  private consentChanging = false
  private foreground = true
  private hidden(): boolean { return !this.foreground || document.visibilityState === 'hidden' }
  setForeground(active: boolean): void { this.foreground = active; this.visibility() }
  private visibility = (): void => {
    if (this.hidden()) { this.pauseMemory(); this.controller.abort(); this.controller = new AbortController() }
    else if (this.running) void this.refresh()
  }
  constructor(private readonly api: OpenAGIApiClient, private readonly view: ProactiveView, private readonly canNotify: () => boolean, private readonly notify: (item: InboxItem) => void) {}
  start(): void {
    if (this.running || typeof this.api.proactive !== 'function') return
    this.running = true; this.controller = new AbortController()
    document.addEventListener('visibilitychange', this.visibility)
    void this.refresh()
    this.timer = setInterval(() => { if (!this.hidden()) void this.refresh() }, 60_000)
  }
  stop(): void {
    this.running = false; this.pauseMemory(); this.controller.abort()
    if (this.timer) clearInterval(this.timer)
    this.timer = null; document.removeEventListener('visibilitychange', this.visibility)
    this.items = []; this.view.inbox?.([])
  }
  async refresh(): Promise<void> {
    if (!this.running || this.refreshing || this.hidden()) return
    this.refreshing = true
    const signal = this.controller.signal
    try {
      const result = await this.api.proactive({ op: 'feed' }, signal)
      if (!this.running || signal.aborted) return
      this.items = result.items ?? []; this.view.inbox?.(this.items)
      if (result.settings) this.view.proactiveSettings?.(result.settings)
      if (this.consent && this.consent.until <= Date.now()) this.pauseMemory('Memory consent expired. Enable again to keep new transcripts.')
      // Do not claim a notification until the app says it can show it safely.
      const item = this.items.find(i => i.important && !i.seen && !i.notified)
      if (item && !result.quiet && result.settings?.enabled && this.canNotify()) {
        const allowed = await this.api.proactive({ op: 'can-notify', id: item.id }, signal)
        if (!signal.aborted && this.running && allowed.notify && this.canNotify()) {
          this.notify(item)
          item.notified = true
          await this.api.proactive({ op: 'notify', id: item.id }, signal)
        }
      }
    } catch (error) { if (!signal.aborted) this.view.activity?.(`Inbox unavailable: ${error instanceof Error ? error.message : 'check main connection'}`) }
    finally { this.refreshing = false }
  }
  async configure(settings: Partial<ProactiveSettings>): Promise<void> {
    try { await this.api.proactive({ op: 'configure', settings }, this.controller.signal); await this.refresh() }
    catch (error) { this.view.activity?.(`Could not save inbox settings: ${String(error)}`) }
  }
  async enableMemory(recordingConsent: boolean): Promise<void> {
    if (!this.running || this.consentChanging || this.hidden()) return
    this.consentChanging = true
    const generation = this.generation
    try {
      const result = await this.api.proactive({ op: 'consent', enabled: true, recordingConsent }, this.controller.signal)
      if (generation !== this.generation || !this.running || this.hidden()) {
        if (result.consent) void this.api.proactive({ op: 'consent', enabled: false, consentId: result.consent.id }).catch(() => {})
        return
      }
      this.consent = result.consent ?? null
      this.view.memoryStatus?.(Boolean(this.consent), 'Memory armed for this foreground listening session (up to 4 hours). Final transcripts are retained on your main; speakers are unverified.')
    } catch (error) { this.view.memoryStatus?.(false, `Could not enable memory: ${String(error)}`) }
    finally { this.consentChanging = false }
  }
  pauseMemory(detail = 'Memory off. New ambient transcripts are not retained. Existing transcripts follow your retention setting.'): void {
    const consent = this.consent
    this.generation++; this.consent = null; this.queue = []
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null; this.view.memoryStatus?.(false, detail)
    if (consent) void this.api.proactive({ op: 'consent', enabled: false, consentId: consent.id }).catch(() => {})
  }
  capture(text: string, metadata?: { at: number; endAt: number; streamId: string; speaker: number | null }): void {
    if (!this.consent || !this.running || this.hidden()) return
    if (this.consent.until <= Date.now()) { this.pauseMemory('Memory consent expired; enable it again.'); return }
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
    if (trimmed.length > 1000 || this.queue.length >= 100) { this.pauseMemory('Memory paused: transcript buffer full. No unsent text was saved.'); return }
    this.queue.push({ text: trimmed, ...(metadata ?? { at: Date.now(), endAt: Date.now(), streamId: this.bufferedStreamId, speaker: null }) })
    if (!this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush() }, 30_000)
  }
  private async flush(): Promise<void> {
    if (!this.consent || !this.queue.length || this.uploading || !this.running) return
    this.uploading = true
    const segments = this.queue.splice(0, 10), texts = segments.map(s => s.text), generation = this.generation
    try {
      await this.api.proactive({ op: 'capture', consentId: this.consent.id, batchId: crypto.randomUUID(), texts, segments: segments.map(({ text: _text, ...metadata }) => metadata) }, this.controller.signal)
      if (generation === this.generation) this.view.activity?.(`Saved ${texts.length} final transcript segment(s) to main; checking explicit commitments.`)
    } catch { if (generation === this.generation) this.pauseMemory('Memory paused: upload failed. No automatic replay; some submitted text may already be saved on main.') }
    finally { this.uploading = false; if (this.queue.length && this.consent && this.running && !this.flushTimer) this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush() }, 16_000) }
  }
  async action(op: 'seen' | 'dismiss' | 'snooze' | 'accept-task' | 'delete-memory', id?: string): Promise<void> {
    if (op === 'delete-memory') this.pauseMemory()
    try {
      await this.api.proactive({ op, id, ...(op === 'accept-task' ? { confirm: true } : {}) }, this.controller.signal)
      this.view.activity?.(op === 'accept-task' ? 'Added to your user tasks on main. No agent action was started.' : op === 'delete-memory' ? 'Retained transcripts and suggestions deleted; accepted tasks remain.' : 'Inbox updated')
      await this.refresh()
    } catch (error) { this.view.activity?.(`Inbox action failed: ${String(error)}`) }
  }
}
