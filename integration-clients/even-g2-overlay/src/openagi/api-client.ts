import type { OpenAGIConfig } from './config'
import { OpenAGIApiError } from './config'

type Fetch = typeof fetch
export interface OpenAGINode {
  id: string
  name: string
  platform: 'even_g2'
  enrolledAt: string
}
export interface OpenAGINodeCredential { nodeId?: string; nodeToken: string }
export interface OpenAGIAskResult { question: string; reply: string; sessionId: string }
export interface AskProgress { type: string; stage?: string; tool?: string; question?: string; text?: string; reset?: boolean }
export interface OpenAGIListenResult { question: string; triggered: boolean; armed: boolean; prompt?: string; reason?: string; reply?: string; sessionId?: string }

const CAPABILITIES = [
  { id: 'g2-voice-input', ready: true, operations: ['ask', 'listen'] },
  { id: 'g2-text-display', ready: true, operations: ['show-answer'] },
]

export class OpenAGIApiClient {
  private readonly fetchImpl: Fetch
  constructor(
    private readonly config: OpenAGIConfig,
    private readonly getCredential: () => OpenAGINodeCredential | null,
    fetchImpl: Fetch = globalThis.fetch,
    private readonly getOrigin: () => string = () => config.origin,
  ) {
    this.fetchImpl = fetchImpl.bind(globalThis)
  }
  enroll(code: string, nodeId: string, nodeToken: string, name = 'Even G2'): Promise<{ node: OpenAGINode; nodeToken: string }> {
    return this.json('/nodes/enroll/exchange', {
      method: 'POST',
      body: JSON.stringify({ code, platform: 'even_g2', nodeId, nodeToken, name }),
    }, false)
  }
  heartbeat(name = 'Even G2'): Promise<{ ok: boolean }> {
    const credential = this.requireCredential()
    if (!credential.nodeId) throw new OpenAGIApiError('direct_agent', 400, 'Direct agent connections do not use node heartbeats.')
    return this.json('/nodes/heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        nodeId: credential.nodeId,
        name,
        role: 'node',
        url: null,
        version: null,
        build: null,
        buildSource: 'even-hub',
        capabilities: CAPABILITIES,
      }),
    })
  }
  unlink(): Promise<{ revoked: boolean }> {
    const credential = this.requireCredential()
    if (!credential.nodeId) throw new OpenAGIApiError('direct_agent', 400, 'Disconnect this direct agent locally.')
    return this.json('/nodes/revoke', { method: 'POST', body: JSON.stringify({ nodeId: credential.nodeId }) })
  }
  async ask(wav: Blob, conversationId: string, progress?: (event: AskProgress) => void, signal?: AbortSignal): Promise<OpenAGIAskResult> {
    return this.json('/nodes/g2/ask', {
      method: 'POST',
      signal,
      body: JSON.stringify({ audioBase64: await blobToBase64(wav), conversationId, language: 'en' }),
    }, true, progress)
  }
  speechToken(model: 'nova-3' | 'nova-2', signal?: AbortSignal): Promise<{ accessToken: string; expiresIn: number; model: string }> {
    return this.json('/nodes/g2/speech-token', { method: 'POST', body: JSON.stringify({ model }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000) })
  }
  speechRelay(model: 'nova-3' | 'nova-2', wakePhrase: string): { url: string; token: string } {
    const credential = this.requireCredential()
    const origin = this.validatedOrigin()
    const url = new URL('/nodes/g2/speech', origin); url.protocol = 'wss:'
    url.searchParams.set('model', model); url.searchParams.set('wakePhrase', wakePhrase.slice(0, 40))
    return { url: url.href, token: credential.nodeToken }
  }
  private validatedOrigin(): string {
    const origin = new URL(this.getOrigin()).origin
    if (this.config.allowedOrigins.length > 0 && !this.config.allowedOrigins.includes(origin)) throw new OpenAGIApiError('origin_not_allowed', 400, 'This agent URL is not allowed by the installed G2 package.')
    if (new URL(origin).protocol !== 'https:') throw new OpenAGIApiError('invalid_origin', 400, 'Use your main server HTTPS URL.')
    return origin
  }
  askText(text: string, conversationId: string, progress: (event: AskProgress) => void, signal: AbortSignal): Promise<OpenAGIAskResult> {
    return this.json('/nodes/g2/ask', { method: 'POST', signal, body: JSON.stringify({ text, conversationId }) }, true, progress)
  }
  async listen(wav: Blob, conversationId: string, options: { wakePhrase: string; answerQuestions: boolean; forceAnswer?: boolean }): Promise<OpenAGIListenResult> {
    return this.json('/nodes/g2/listen', {
      method: 'POST',
      body: JSON.stringify({
        audioBase64: await blobToBase64(wav), conversationId, language: 'en', wakePhrase: options.wakePhrase,
        triggerMode: options.answerQuestions ? 'wake_or_question' : 'wake_only', forceAnswer: options.forceAnswer === true, transcribeOnly: true,
      }),
    })
  }
  private requireCredential(): OpenAGINodeCredential {
    const credential = this.getCredential()
    if (!credential) throw new OpenAGIApiError('not_enrolled', 401, 'This G2 needs to be connected to an agent again.')
    return credential
  }
  private async json<T>(path: string, init: RequestInit = {}, authenticated = true, progress?: (event: AskProgress) => void): Promise<T> {
    if (!progress) return this.requestJson(path, { ...init, signal: init.signal ?? AbortSignal.timeout(75_000) }, authenticated)
    const idle = new AbortController()
    let timer = setTimeout(() => idle.abort(), 60_000)
    const external = init.signal
    try {
      return await this.requestJson(path, { ...init, signal: external ? AbortSignal.any([external, idle.signal]) : idle.signal }, authenticated, event => {
        clearTimeout(timer); timer = setTimeout(() => idle.abort(), 60_000)
        progress(event)
      })
    } catch (error) {
      if (external?.aborted) throw new OpenAGIApiError('cancelled', 499, 'Request interrupted. Actions already performed cannot be undone.')
      if (idle.signal.aborted) throw new OpenAGIApiError('stream_idle', 408, 'No stream data arrived for 60 seconds. Partial text is preserved; the request was not replayed.')
      if (error instanceof Error && /abort|fetch/i.test(error.message)) throw new OpenAGIApiError('stream_disconnected', 502, 'The response connection was interrupted. Partial text is preserved; check the main before repeating actions.')
      throw error
    } finally { clearTimeout(timer) }
  }
  private async requestJson<T>(path: string, init: RequestInit = {}, authenticated = true, progress?: (event: AskProgress) => void): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('Content-Type', 'application/json')
    headers.set('Accept', progress ? 'application/x-ndjson' : 'application/json')
    const credential = this.getCredential()
    if (authenticated && credential) {
      headers.set('Authorization', `Bearer ${credential.nodeToken}`)
      if (credential.nodeId) headers.set('X-OpenAGI-Node-ID', credential.nodeId)
    }
    const origin = this.validatedOrigin()
    let response: Response
    try {
      response = await this.fetchImpl(`${origin}${path}`, {
        ...init,
        headers,
        // Never follow a redirect while carrying the scoped bearer token.
        redirect: 'error',
        signal: init.signal,
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new OpenAGIApiError('request_timeout', 408, 'The agent took too long to respond. Try again.')
      }
      throw error
    }
    if (response.ok && response.headers.get('content-type')?.includes('application/x-ndjson')) {
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Streaming response is unavailable.')
      const decoder = new TextDecoder()
      let pending = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          pending += decoder.decode(value, { stream: !done })
          if (pending.length > 262_144) throw new Error('Agent response exceeded the display limit.')
          let newline: number
          while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
            if (!line.trim()) continue
            const event = JSON.parse(line) as AskProgress & { message?: string }
            if (event.type === 'error') throw new Error(event.message ?? 'Agent request failed.')
            if (event.type === 'result') return JSON.parse(line) as T
            progress?.(event)
          }
          if (done) throw new Error('The connection ended before the answer completed. Check your main before retrying.')
        }
      } finally { await reader.cancel().catch(() => undefined) }
    }
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>
    if (response.ok) return payload as T
    throw new OpenAGIApiError(typeof payload.error === 'string' ? payload.error : `http_${response.status}`, response.status, typeof payload.message === 'string' ? payload.message : userMessage(response.status))
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

function userMessage(status: number): string {
  if (status === 401 || status === 403) return 'This G2 needs to be connected to the agent again.'
  if (status === 413) return 'That question was too long. Keep it under 30 seconds.'
  if (status === 503) return 'Agent speech is not configured yet.'
  return 'The agent could not complete the request.'
}
