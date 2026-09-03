import type { OpenAGIConfig } from './config'
import { OpenAGIApiError } from './config'

type Fetch = typeof fetch
export interface OpenAGINode {
  id: string
  name: string
  platform: 'even_g2'
  enrolledAt: string
}
export interface OpenAGINodeCredential { nodeId: string; nodeToken: string }
export interface OpenAGIAskResult { question: string; reply: string; sessionId: string }

const CAPABILITIES = [
  { id: 'g2-voice-input', ready: true, operations: ['ask'] },
  { id: 'g2-text-display', ready: true, operations: ['show-answer'] },
]

export class OpenAGIApiClient {
  private readonly fetchImpl: Fetch
  constructor(private readonly config: OpenAGIConfig, private readonly getCredential: () => OpenAGINodeCredential | null, fetchImpl: Fetch = globalThis.fetch) {
    this.fetchImpl = fetchImpl.bind(globalThis)
  }
  enroll(code: string, nodeId: string, name = 'Even G2'): Promise<{ node: OpenAGINode; nodeToken: string }> {
    return this.json('/nodes/enroll/exchange', {
      method: 'POST',
      body: JSON.stringify({ code, platform: 'even_g2', nodeId, name }),
    }, false)
  }
  heartbeat(name = 'Even G2'): Promise<{ ok: boolean }> {
    const credential = this.requireCredential()
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
    return this.json('/nodes/revoke', { method: 'POST', body: JSON.stringify({ nodeId: credential.nodeId }) })
  }
  async ask(wav: Blob, conversationId: string): Promise<OpenAGIAskResult> {
    return this.json('/nodes/g2/ask', {
      method: 'POST',
      body: JSON.stringify({ audioBase64: await blobToBase64(wav), conversationId, language: 'en' }),
    })
  }
  private requireCredential(): OpenAGINodeCredential {
    const credential = this.getCredential()
    if (!credential) throw new OpenAGIApiError('not_enrolled', 401, 'This G2 needs to be paired with OpenAGI again.')
    return credential
  }
  private async json<T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('Content-Type', 'application/json')
    headers.set('Accept', 'application/json')
    const credential = this.getCredential()
    if (authenticated && credential) {
      headers.set('Authorization', `Bearer ${credential.nodeToken}`)
      headers.set('X-OpenAGI-Node-ID', credential.nodeId)
    }
    const response = await this.fetchImpl(`${this.config.origin}${path}`, { ...init, headers })
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
  if (status === 401 || status === 403) return 'This G2 needs to be paired with OpenAGI again.'
  if (status === 413) return 'That question was too long. Keep it under 30 seconds.'
  if (status === 503) return 'OpenAGI speech is not configured yet.'
  return 'OpenAGI could not complete the request.'
}
