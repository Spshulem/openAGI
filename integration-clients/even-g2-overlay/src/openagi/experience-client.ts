import type { OpenAGIStore } from './store'
import type { AskProgress, OpenAGIAskResult } from './api-client'
import { OpenAGIApiError } from './config'

export interface G2Capabilities { protocol: number; recovery: boolean; history: boolean; mainRole: string; speech: { transcriptionConfigured: boolean; liveTranscriptionConfigured: boolean } }
export interface G2Conversation { continuation: string; title: string; preview: string; at: string }
export interface G2History { conversations?: G2Conversation[]; messages?: { role: string; text: string; at: string }[]; nextOffset?: number | null; archivedOnMain?: boolean }
export interface RequestReceipt { id: string; state: 'accepted' | 'working' | 'completed' | 'cancelled' | 'unconfirmed'; revision: number; stage?: string; tool?: string; question?: string; text?: string; message?: string; result?: OpenAGIAskResult; events?: { seq: number; stage: string; tool?: string }[] }
type Send = <T>(body: object, signal?: AbortSignal) => Promise<T>

export class G2ExperienceClient {
  capabilities: G2Capabilities | null = null
  constructor(private readonly store: OpenAGIStore, private readonly send: Send, private readonly origin: () => string) {}
  async probe(): Promise<G2Capabilities | null> {
    try {
      const result = await this.send<G2Capabilities>({ op: 'capabilities' })
      this.capabilities = result.protocol === 1 && result.recovery === true ? result : null
    } catch (error) {
      if (!(error instanceof OpenAGIApiError) || ![404, 405].includes(error.status)) throw error
      this.capabilities = null
    }
    return this.capabilities
  }
  async submit(payload: { text?: string; audioBase64?: string; conversationId: string }, progress: ((event: AskProgress) => void) | undefined, signal?: AbortSignal): Promise<OpenAGIAskResult> {
    if (this.store.snapshot().pendingRequest) throw new OpenAGIApiError('request_pending', 409, 'A saved question needs attention. Check its result before asking again.')
    const id = `${Date.now()}_${crypto.randomUUID()}`, continuation = this.store.snapshot().continuation
    await this.store.update({ pendingRequest: { id, conversationId: payload.conversationId, continuation, text: payload.text ?? null, origin: this.origin() }, savedDraft: '' })
    const receipt = await this.send<RequestReceipt>({ op: 'submit', id, question: { ...payload, ...(continuation ? { continuation } : {}) } }, signal)
    return this.observe(receipt, progress, signal)
  }
  async resume(progress: ((event: AskProgress) => void) | undefined, signal?: AbortSignal, allowSubmit = false): Promise<OpenAGIAskResult> {
    const pending = this.store.snapshot().pendingRequest
    if (!pending || pending.origin !== this.origin()) throw new OpenAGIApiError('no_pending_request', 404, 'No saved request belongs to this main.')
    let receipt: RequestReceipt
    try { receipt = await this.send<RequestReceipt>({ op: 'get', id: pending.id }, signal) }
    catch (error) {
      if (!(error instanceof OpenAGIApiError) || error.code !== 'request_not_found' || !allowSubmit || !pending.text) throw error
      receipt = await this.send<RequestReceipt>({ op: 'submit', id: pending.id, question: { text: pending.text, conversationId: pending.conversationId, ...(pending.continuation ? { continuation: pending.continuation } : {}) } }, signal)
    }
    return this.observe(receipt, progress, signal)
  }
  async cancel(): Promise<void> {
    const pending = this.store.snapshot().pendingRequest
    if (!pending || pending.origin !== this.origin()) return
    const receipt = await this.send<RequestReceipt>({ op: 'cancel', id: pending.id })
    if (receipt.state === 'cancelled') await this.store.update({ pendingRequest: null })
  }
  private async observe(initial: RequestReceipt, progress: ((event: AskProgress) => void) | undefined, signal?: AbortSignal): Promise<OpenAGIAskResult> {
    let receipt = initial, revision = -1, stage = '', text = '', sequence = 0
    const stopAt = Date.now() + 310_000
    for (;;) {
      signal?.throwIfAborted()
      if (receipt.revision !== revision) {
        revision = receipt.revision
        const next = `${receipt.stage}:${receipt.tool}`
        const events = receipt.events?.filter(e => e.seq > sequence) ?? []
        for (const event of events) { sequence = event.seq; progress?.({ type: 'progress', stage: event.stage, tool: event.tool, question: receipt.question }) }
        if (!events.length && next !== stage) progress?.({ type: 'progress', stage: receipt.stage, tool: receipt.tool, question: receipt.question })
        stage = next
        if (receipt.text && receipt.text !== text) { text = receipt.text; progress?.({ type: 'delta', text, reset: true }) }
      }
      progress?.({ type: 'heartbeat' })
      if (receipt.state === 'completed' && receipt.result) {
        await this.store.update({ pendingRequest: null, savedDraft: '' })
        return receipt.result
      }
      if (receipt.state === 'cancelled' || receipt.state === 'unconfirmed') throw new OpenAGIApiError(`request_${receipt.state}`, 409, receipt.message ?? 'Check History before sending another question.')
      if (Date.now() > stopAt) throw new OpenAGIApiError('request_pending', 408, 'Main is still processing. Check saved request to reconnect; it will not send twice.')
      await delay(1000, signal)
      receipt = await this.send<RequestReceipt>({ op: 'get', id: receipt.id }, signal)
    }
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Observer stopped', 'AbortError')); return }
    const finish = (): void => { signal?.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(finish, ms)
    const abort = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new DOMException('Observer stopped', 'AbortError')) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
