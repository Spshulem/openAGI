import { expect, it, vi } from 'vitest'
import { OpenAGIStore } from '../store'
import { OpenAGIApiClient } from '../api-client'

it('persists bounded conversation history and clears it when switching main or disconnecting', async () => {
  let value: string | null = null
  const storage = { get: () => Promise.resolve(value), set: (_key: string, next: string) => { value = next; return Promise.resolve() }, remove: () => Promise.resolve() }
  const store = new OpenAGIStore(storage)
  const conversationId = crypto.randomUUID()
  await store.update({ agentOrigin: 'https://first.example.com', conversationId })
  for (let index = 0; index < 32; index++) await store.remember(`Question ${index}`, `Answer ${index}`)
  const reopened = new OpenAGIStore(storage)
  expect((await reopened.load()).history).toHaveLength(30)
  expect(reopened.snapshot().history[0].question).toBe('Question 2')
  expect(reopened.snapshot().history[0].conversationId).toBe(conversationId)
  await reopened.update({ agentOrigin: 'https://second.example.com' })
  expect(reopened.snapshot().history).toEqual([])
  await reopened.remember('Another', 'Answer')
  await reopened.clearCredential()
  expect(reopened.snapshot().history).toEqual([])
})

it('migrates pre-history pairing state without losing credentials', async () => {
  const original = new OpenAGIStore({ get: () => Promise.resolve(null), set: () => Promise.resolve(), remove: () => Promise.resolve() })
  await original.update({ nodeToken: 'test-credential-123456' })
  const state = { ...original.snapshot(), history: undefined }
  const reopened = new OpenAGIStore({ get: () => Promise.resolve(JSON.stringify(state)), set: () => Promise.resolve(), remove: () => Promise.resolve() })
  expect((await reopened.load()).nodeToken).toBe('test-credential-123456')
  expect(reopened.snapshot().history).toEqual([])
})

function apiWithStream(lines: string[]) {
  const bytes = new TextEncoder().encode(lines.join('\n') + '\n')
  const stream = new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7))
    controller.close()
  } })
  const fetcher = vi.fn(() => Promise.resolve(new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } })))
  return new OpenAGIApiClient({ origin: 'https://main.example.com', allowedOrigins: [] }, () => ({ nodeToken: 'scoped-token-test' }), fetcher)
}

it('parses fragmented streaming progress, text and final result', async () => {
  const api = apiWithStream([
    JSON.stringify({ type: 'progress', stage: 'transcribing' }),
    JSON.stringify({ type: 'delta', text: 'Héllo' }),
    JSON.stringify({ type: 'result', question: 'Hi', reply: 'Héllo', sessionId: 'session' }),
  ])
  const progress = vi.fn()
  expect((await api.ask(new Blob(['audio']), crypto.randomUUID(), progress)).reply).toBe('Héllo')
  expect(progress).toHaveBeenCalledWith({ type: 'delta', text: 'Héllo' })
})

it('surfaces stream errors and interrupted answers instead of claiming success', async () => {
  await expect(apiWithStream(['{"type":"error","message":"Transcription failed"}']).ask(new Blob(), crypto.randomUUID(), vi.fn())).rejects.toThrow('Transcription failed')
  await expect(apiWithStream(['{"type":"heartbeat"}']).ask(new Blob(), crypto.randomUUID(), vi.fn())).rejects.toThrow('before the answer completed')
})

it('does not abort a healthy stream after 75 or 180 seconds', async () => {
  vi.useFakeTimers()
  let writer!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(controller) { writer = controller } })
  const api = new OpenAGIApiClient({ origin: 'https://main.example.com', allowedOrigins: [] }, () => ({ nodeToken: 'test-scoped-token' }),
    () => Promise.resolve(new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } })))
  const encode = (event: object): Uint8Array => new TextEncoder().encode(JSON.stringify(event) + '\n')
  try {
    const promise = api.askText('Hello', crypto.randomUUID(), vi.fn(), new AbortController().signal)
    for (let index = 0; index < 7; index++) {
      writer.enqueue(encode({ type: 'heartbeat' }))
      await vi.advanceTimersByTimeAsync(30_000)
    }
    writer.enqueue(encode({ type: 'result', question: 'Hello', reply: 'Still connected', sessionId: 's' })); writer.close()
    expect((await promise).reply).toBe('Still connected')
  } finally { vi.useRealTimers() }
})
