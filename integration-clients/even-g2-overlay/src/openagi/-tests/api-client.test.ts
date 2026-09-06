import { describe, expect, it, vi } from 'vitest'
import { OpenAGIApiClient, blobToBase64 } from '../api-client'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('OpenAGIApiClient', () => {
  const config = { origin: 'https://openagi.example.com', allowedOrigins: ['https://openagi.example.com'] }
  it('pins the speech relay to the selected HTTPS main and keeps the token out of its URL', () => {
    const api = new OpenAGIApiClient(config, () => ({ nodeToken: 't'.repeat(43) }))
    const relay = api.speechRelay('nova-3', 'Peri')
    expect(relay.url).toBe('wss://openagi.example.com/nodes/g2/speech?model=nova-3&wakePhrase=Peri')
    expect(relay.url).not.toContain(relay.token)
    const blocked = new OpenAGIApiClient(config, () => ({ nodeToken: 't'.repeat(43) }), globalThis.fetch, () => 'https://other.example.com')
    expect(() => blocked.speechRelay('nova-3', '')).toThrow('not allowed')
    const insecure = new OpenAGIApiClient({ ...config, allowedOrigins: [] }, () => ({ nodeToken: 't'.repeat(43) }), globalThis.fetch, () => 'http://main.example.com')
    expect(() => insecure.speechRelay('nova-3', '')).toThrow('HTTPS')
  })
  it('enrolls without owner credentials, then uses only the scoped node credential', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const nodeId = crypto.randomUUID()
    const nodeToken = 'n'.repeat(43)
    let credential: { nodeId: string; nodeToken: string } | null = null
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      requests.push({ url, init })
      if (url.endsWith('/exchange')) return Promise.resolve(jsonResponse({ node: { id: nodeId, name: 'G2', platform: 'even_g2', enrolledAt: new Date().toISOString() }, nodeToken: 'x'.repeat(43) }))
      return Promise.resolve(jsonResponse({ ok: true }))
    }) as unknown as typeof fetch
    const api = new OpenAGIApiClient(config, () => credential, fetchImpl)

    const enrolled = await api.enroll('123456', nodeId, nodeToken)
    credential = { nodeId, nodeToken: enrolled.nodeToken }
    await api.heartbeat()

    expect(new Headers(requests[0]?.init?.headers).has('Authorization')).toBe(false)
    const enrollmentBody = requests[0]?.init?.body
    if (typeof enrollmentBody !== 'string') throw new Error('Expected enrollment JSON body')
    expect(JSON.parse(enrollmentBody)).toMatchObject({
      code: '123456', platform: 'even_g2', nodeId, nodeToken,
    })
    expect(new Headers(requests[1]?.init?.headers).get('Authorization')).toBe(`Bearer ${credential.nodeToken}`)
    expect(new Headers(requests[1]?.init?.headers).get('X-OpenAGI-Node-ID')).toBe(nodeId)
    expect(requests[1]?.init?.redirect).toBe('error')
    const heartbeatBody = requests[1]?.init?.body
    if (typeof heartbeatBody !== 'string') throw new Error('Expected heartbeat JSON body')
    expect(JSON.parse(heartbeatBody)).toMatchObject({
      nodeId,
      role: 'node',
      capabilities: [
        { id: 'g2-voice-input', ready: true, operations: ['ask', 'listen'] },
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
    const api = new OpenAGIApiClient(config, () => ({ nodeId, nodeToken: 'd'.repeat(43) }), fetchImpl)
    const audio = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/wav' })
    const conversationId = crypto.randomUUID()

    await expect(api.ask(audio, conversationId)).resolves.toMatchObject({ reply: 'Hi.', sessionId: 'server-bound-session' })
    expect(requestBody.audioBase64).toBe(await blobToBase64(audio))
    expect(requestBody.conversationId).toBe(conversationId)
    expect(requestBody).not.toHaveProperty('sessionId')
  })

  it('surfaces the server safe error message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: 'empty_transcription', message: 'I did not hear a question.' }, 422)) as unknown as typeof fetch
    const api = new OpenAGIApiClient(config, () => ({ nodeId: crypto.randomUUID(), nodeToken: 'd'.repeat(43) }), fetchImpl)
    await expect(api.ask(new Blob([new Uint8Array([1])]), crypto.randomUUID())).rejects.toMatchObject({ code: 'empty_transcription', status: 422, message: 'I did not hear a question.' })
  })

  it('sends ambient listening policy without broadening the node credential', async () => {
    let requestBody: Record<string, unknown> = {}
    const fetchImpl = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body')
      requestBody = JSON.parse(init.body) as Record<string, unknown>
      return Promise.resolve(jsonResponse({ question: 'Open AGI, what time is it?', triggered: true, armed: false, reply: 'Noon.' }))
    }) as unknown as typeof fetch
    const api = new OpenAGIApiClient(config, () => ({ nodeId: crypto.randomUUID(), nodeToken: 'd'.repeat(43) }), fetchImpl)
    await api.listen(new Blob([new Uint8Array([1, 2])]), crypto.randomUUID(), { wakePhrase: 'open agi', answerQuestions: true })
    expect(requestBody).toMatchObject({ wakePhrase: 'open agi', triggerMode: 'wake_or_question', forceAnswer: false })
    expect(requestBody).not.toHaveProperty('sessionId')
  })

  it('supports a generic allowed agent URL with only a scoped bearer token', async () => {
    const requests: Array<{ url: string; headers: Headers }> = []
    const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        headers: new Headers(init?.headers),
      })
      return Promise.resolve(jsonResponse({ question: 'Hello?', reply: 'Hi.', sessionId: 'agent-session' }))
    }) as unknown as typeof fetch
    const api = new OpenAGIApiClient(
      { origin: 'https://openagi.example.com', allowedOrigins: ['https://openagi.example.com', 'https://agent.example.com'] },
      () => ({ nodeToken: 'scoped-agent-token' }), fetchImpl, () => 'https://agent.example.com',
    )
    await api.ask(new Blob([new Uint8Array([1, 2])]), crypto.randomUUID())
    const request = requests[0]
    expect(request?.url).toBe('https://agent.example.com/nodes/g2/ask')
    expect(request?.headers.get('Authorization')).toBe('Bearer scoped-agent-token')
    expect(request?.headers.has('X-OpenAGI-Node-ID')).toBe(false)
  })

  it('rejects a runtime origin that was not compiled into the package', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const api = new OpenAGIApiClient(config, () => ({ nodeToken: 'scoped-agent-token' }), fetchImpl, () => 'https://evil.example.com')
    await expect(api.ask(new Blob([new Uint8Array([1, 2])]), crypto.randomUUID())).rejects.toMatchObject({ code: 'origin_not_allowed' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
