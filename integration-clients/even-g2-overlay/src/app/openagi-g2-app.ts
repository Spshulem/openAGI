import type { AudioSource } from '../even/audio-source'
import { QuestionAudioBuffer } from '../buildbetter/question-audio'
import { paginateText } from '../state/ask-state-machine'
import type { OpenAGIApiClient } from '../openagi/api-client'
import { OpenAGIApiError, safeOpenAGIError } from '../openagi/config'
import type { OpenAGIStore } from '../openagi/store'
import type { OpenAGIGlassesRenderer } from '../ui/openagi-glasses-renderer'
import type { OpenAGIPhoneCompanion } from '../ui/openagi-phone-companion'

type Mode = 'unpaired' | 'pairing' | 'home' | 'listening' | 'thinking' | 'answer' | 'message'

export class OpenAGIG2App {
  private mode: Mode = 'unpaired'
  private audioBuffer: QuestionAudioBuffer | null = null
  private pages: string[] = []
  private page = 0
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  constructor(private readonly api: OpenAGIApiClient, private readonly store: OpenAGIStore, private readonly audio: AudioSource, private readonly renderer: OpenAGIGlassesRenderer, private readonly phone: OpenAGIPhoneCompanion) {}

  async boot(): Promise<void> {
    const stored = await this.store.load()
    if (stored.nodeToken) {
      try { await this.heartbeatWithoutLosingEnrollment(stored.node?.name); this.startHeartbeat(); this.showHome(); return }
      catch (error) {
        if (!(error instanceof OpenAGIApiError) || (error.status !== 401 && error.status !== 403)) throw error
        await this.store.clearCredential()
      }
    }
    this.showUnpaired()
  }
  tap(): void {
    if (this.mode === 'home') void this.startAsk()
    else if (this.mode === 'listening') void this.finishAsk()
    else if (this.mode === 'answer' || this.mode === 'message') this.showHome()
    else if (this.mode === 'unpaired') this.renderer.pairing()
  }
  scrollUp(): void { if (this.mode === 'answer') this.showAnswer(Math.max(0, this.page - 1)) }
  scrollDown(): void { if (this.mode === 'answer') this.showAnswer(Math.min(this.pages.length - 1, this.page + 1)) }
  doubleTap(): void { this.phone.set('Exit requested', 'Confirm exit on the glasses.') }
  async systemExit(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    if (this.audio.active) await this.audio.stop().catch(() => undefined)
  }

  async pair(code: string): Promise<void> {
    if (this.mode === 'pairing') return
    this.mode = 'pairing'; this.renderer.pairing(); this.phone.set('Pairing G2…', 'Checking the one-time code with OpenAGI.')
    try {
      const state = this.store.snapshot()
      const enrolled = await this.api.enroll(code, state.nodeId)
      await this.store.update({ nodeToken: enrolled.nodeToken, node: enrolled.node, conversationId: crypto.randomUUID() })
      await this.heartbeatWithoutLosingEnrollment(enrolled.node.name)
      this.startHeartbeat()
      this.showHome()
    }
    catch (error) { this.mode = 'unpaired'; this.renderer.message('Could not pair G2', safeOpenAGIError(error)); this.phone.set('Pairing failed', safeOpenAGIError(error)) }
  }
  async unlink(): Promise<void> {
    if (this.audio.active) await this.audio.stop().catch(() => undefined)
    try { await this.api.unlink() } catch { /* remove the local credential even if the server is offline */ }
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    await this.store.clearCredential(); this.showUnpaired()
  }
  async newConversation(): Promise<void> { await this.store.update({ conversationId: crypto.randomUUID() }); this.showHome(); this.phone.set('New conversation', 'Your next question starts a fresh OpenAGI chat.') }
  async startAsk(): Promise<void> {
    if (this.mode !== 'home' || !this.store.snapshot().nodeToken) return
    this.mode = 'listening'; this.audioBuffer = new QuestionAudioBuffer(); this.renderer.listening(); this.phone.set('Listening…', 'Tap again when your question is finished.')
    try { await this.audio.start(pcm => { try { this.audioBuffer?.push(pcm) } catch (error) { void this.audio.stop(); this.fail(error) } }) }
    catch (error) { this.fail(error) }
  }
  async finishAsk(): Promise<void> {
    if (this.mode !== 'listening' || !this.audioBuffer) return
    this.mode = 'thinking'; await this.audio.stop().catch(() => undefined); this.renderer.thinking(); this.phone.set('Asking OpenAGI…', 'Transcribing your question and running your OpenAGI tools.')
    try {
      const conversationId = this.store.snapshot().conversationId
      if (!conversationId) throw new Error('Start a new G2 conversation before asking OpenAGI.')
      const result = await this.api.ask(this.audioBuffer.toWav(), conversationId)
      this.renderer.thinking(result.question); this.pages = paginateText(result.reply); this.showAnswer(0)
      this.phone.set('Answer ready', `${this.pages.length} page${this.pages.length === 1 ? '' : 's'} on G2`)
    } catch (error) { this.fail(error) } finally { this.audioBuffer = null }
  }
  private showUnpaired(): void { this.mode = 'unpaired'; this.phone.paired(false); this.renderer.unpaired(); this.phone.set('Pair your G2', 'In OpenAGI, open Nodes and generate a G2 enrollment code.') }
  private showHome(): void {
    const state = this.store.snapshot(); if (!state.nodeToken) { this.showUnpaired(); return }
    this.mode = 'home'; this.phone.paired(true); this.renderer.home(state.node?.name); this.phone.set('Ready', 'Tap Ask to continue your OpenAGI conversation.')
  }
  private showAnswer(page: number): void { this.mode = 'answer'; this.page = page; this.renderer.answer(this.pages[page] ?? '', page, this.pages.length) }
  private fail(error: unknown): void { this.mode = 'message'; const message = safeOpenAGIError(error); this.renderer.message('Could not ask OpenAGI', message); this.phone.set('Ask failed', message) }
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
