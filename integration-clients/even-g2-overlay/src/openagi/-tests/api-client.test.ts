import { describe, expect, it, vi } from 'vitest'
import { OpenAGIApiClient, blobToBase64 } from '../api-client'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('OpenAGIApiClient', () => {
  it('enrolls without owner credentials, then uses only the scoped node credential', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const nodeId = crypto.randomUUID()
    let credential: { nodeId: string; nodeToken: string } | null = null
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      if (url.endsWith('/exchange')) return Promise.resolve(jsonResponse({ node: { id: nodeId, name: 'G2', platform: 'even_g2', enrolledAt: new Date().toISOString() }, nodeToken: 'x'.repeat(43) }))
      return Promise.resolve(jsonResponse({ ok: true }))
    }) as unknown as typeof fetch
    const api = new OpenAGIApiClient({ origin: 'https://openagi.example.com' }, () => credential, fetchImpl)

    const enrolled = await api.enroll('123456', nodeId)
    credential = { nodeId, nodeToken: enrolled.nodeToken }
    await api.heartbeat()

    expect(new Headers(requests[0]?.init?.headers).has('Authorization')).toBe(false)
    expect(new Headers(requests[1]?.init?.headers).get('Authorization')).toBe(`Bearer ${credential.nodeToken}`)
    expect(new Headers(requests[1]?.init?.headers).get('X-OpenAGI-Node-ID')).toBe(nodeId)
    const heartbeatBody = requests[1]?.init?.body
    if (typeof heartbeatBody !== 'string') throw new Error('Expected heartbeat JSON body')
    expect(JSON.parse(heartbeatBody)).toMatchObject({
      nodeId,
      role: 'node',
      capabilities: [
        { id: 'g2-voice-input', ready: true, operations: ['ask'] },
        { id: 'g2-text-display', ready: true, operations: ['show-answer'] },
      ],
    })
  })

  it('base64 encodes question audio and keeps only the G2 conversation discriminator', async () => {
    let requestBody: Record<string, unknown> = {}
    const nodeId = crypto.randomUUID()
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
      requestBody = JSON.parse(init.body) as Record<string, unknown>
      return Promise.resolve(jsonResponse({ question: 'Hello?', reply: 'Hi.', sessionId: 'server-bound-session' }))
    }) as unknown as typeof fetch
    const api = new OpenAGIApiClient({ origin: 'https://openagi.example.com' }, () => ({ nodeId, nodeToken: 'd'.repeat(43) }), fetchImpl)
    const audio = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/wav' })
    const conversationId = crypto.randomUUID()

    await expect(api.ask(audio, conversationId)).resolves.toMatchObject({ reply: 'Hi.', sessionId: 'server-bound-session' })
    expect(requestBody.audioBase64).toBe(await blobToBase64(audio))
    expect(requestBody.conversationId).toBe(conversationId)
    expect(requestBody).not.toHaveProperty('sessionId')
  })

  it('surfaces the server safe error message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'empty_transcription', message: 'I did not hear a question.' }, 422)) as unknown as typeof fetch
    const api = new OpenAGIApiClient({ origin: 'https://openagi.example.com' }, () => ({ nodeId: crypto.randomUUID(), nodeToken: 'd'.repeat(43) }), fetchImpl)
    await expect(api.ask(new Blob([new Uint8Array([1])]), crypto.randomUUID())).rejects.toMatchObject({ code: 'empty_transcription', status: 422, message: 'I did not hear a question.' })
  })
})
