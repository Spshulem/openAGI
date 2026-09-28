import { beforeEach, expect, it, vi } from 'vitest'
import { parseConnectionCard } from '../connection-card'
import { OpenAGIStore } from '../store'
import { G2ExperienceClient, type RequestReceipt } from '../experience-client'
import { OpenAGIApiError } from '../config'
import { OpenAGIPhoneCompanion } from '../../ui/openagi-phone-companion'

beforeEach(() => { document.body.innerHTML = '<div id="app"></div>' })
function storeFixture(): OpenAGIStore {
  const values = new Map<string, string>()
  return new OpenAGIStore({ get: key => Promise.resolve(values.get(key) ?? null), set: (key, value) => { values.set(key, value); return Promise.resolve() }, remove: key => { values.delete(key); return Promise.resolve() } })
}
it('connection cards reject token fields, expired codes, non-HTTPS and credential URLs', () => {
  const base = { format: 'openagi-g2', version: 1, origin: 'https://main.example.test', code: '000123', expiresAt: new Date(Date.now() + 60_000).toISOString() }
  expect(parseConnectionCard(JSON.stringify(base)).code).toBe('000123')
  for (const patch of [{ token: 'do-not-transfer' }, { origin: 'http://main.test' }, { origin: 'https://owner:secret@main.test' }, { origin: 'https://main.test/path' }, { expiresAt: '2000-01-01T00:00:00.000Z' }]) expect(() => parseConnectionCard(JSON.stringify({ ...base, ...patch }))).toThrow()
})
it('Classic round-trips the same controls without changing consent, credential, or draft', () => {
  const ask = vi.fn()
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask, newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn() }, [])
  phone.paired(true); phone.interaction('idle')
  const consent = document.querySelector<HTMLInputElement>('#recording-consent')!
  consent.checked = true
  phone.draft('saved words')
  for (let n = 0; n < 3; n++) { phone.interfaceStyle('classic'); phone.interfaceStyle('focused') }
  expect(document.querySelector('#recording-consent')).toBe(consent)
  expect(consent.checked).toBe(true); expect(document.querySelector('#draft-text')?.textContent).toBe('saved words')
  expect(document.querySelectorAll('#draft-review')).toHaveLength(1)
  document.querySelector<HTMLButtonElement>('[data-action="ask"]')!.click(); expect(ask).toHaveBeenCalledOnce()
  expect([...document.querySelectorAll('.experience-nav button')].map(b => b.textContent)).toEqual(['Talk', 'Inbox', 'History', '⚙'])
  document.querySelector<HTMLButtonElement>('#read-lifelog')!.click()
  document.querySelector<HTMLButtonElement>('#lifelog-close')!.click()
  expect(document.querySelector<HTMLElement>('.history-page')!.hidden).toBe(false)
  phone.history([{ question: 'Saved question', at: new Date().toISOString() }])
  document.querySelector<HTMLButtonElement>('[data-answer]')!.click()
  expect(document.querySelector<HTMLElement>('.talk-page')!.hidden).toBe(false)
})
it('serialized preferences retain overlapping updates on reload', async () => {
  const store = storeFixture()
  await Promise.all([store.update({ interfaceStyle: 'classic' }), store.update({ homeMode: 'lifelog', recordingConsent: true }), store.update({ savedDraft: 'keep me' })])
  await store.load()
  expect(store.snapshot()).toMatchObject({ interfaceStyle: 'classic', homeMode: 'lifelog', recordingConsent: true, savedDraft: 'keep me' })
})
it.each([
  [{ homeMode: 'ask', lifelogEnabled: true, lifelogConsent: { id: 'old', until: 1 } }, { homeMode: 'lifelog', recordingConsent: true, lifelogConsent: null }],
  [{ homeMode: 'ask', lifelogEnabled: false, lifelogConsent: null }, { homeMode: 'talk', recordingConsent: false }],
  [{ lifelogEnabled: true, lifelogConsent: null, lifelogPaused: true, idleTapAction: 'highlight', lifelogTalkMode: 'hold' }, { homeMode: 'lifelog', recordingConsent: false }],
  [{ homeMode: 'supervisor', lifelogEnabled: true, lifelogConsent: { id: 'old', until: 1 } }, { homeMode: 'supervisor', recordingConsent: false, lifelogConsent: null }],
] as [Record<string, unknown>, Record<string, unknown>][])('migrates a 0.4 state %j to one home mode without losing pairing', async (legacy, expected) => {
  const values = new Map<string, string>()
  const storage = { get: (key: string) => Promise.resolve(values.get(key) ?? null), set: (key: string, value: string) => { values.set(key, value); return Promise.resolve() }, remove: () => Promise.resolve() }
  const seed = new OpenAGIStore(storage)
  await seed.update({ nodeToken: 'legacy-scoped-token-123', agentOrigin: 'https://main.example.test' })
  const [key, raw] = [...values.entries()][0]
  const old = { ...JSON.parse(raw) as Record<string, unknown>, ...legacy }
  delete old.recordingConsent
  values.set(key, JSON.stringify(old))
  const state = await new OpenAGIStore(storage).load()
  expect(state).toMatchObject(expected)
  expect(state.nodeToken).toBe('legacy-scoped-token-123')
  expect(state).not.toHaveProperty('lifelogPaused'); expect(state).not.toHaveProperty('idleTapAction')
})
it('an uncertain submission persists one identity, and checking it does not create work', async () => {
  const store = storeFixture(); const conversationId = crypto.randomUUID(); await store.update({ conversationId })
  let requestId = ''
  const send = vi.fn((body: object) => {
    const request = body as { op: string; id: string }
    if (request.op === 'submit') { requestId = request.id; return Promise.reject(new Error('lost acceptance')) }
    return Promise.resolve({ id: requestId, state: 'completed', revision: 2, result: { question: 'hi', reply: 'hello', sessionId: 'test' } })
  })
  const client = new G2ExperienceClient(store, send as never, () => 'https://main.example.test')
  await expect(client.submit({ text: 'hi', conversationId }, undefined)).rejects.toThrow('lost acceptance')
  expect(store.snapshot().pendingRequest?.id).toBe(requestId)
  await client.resume(undefined)
  expect(send.mock.calls.map(call => (call[0] as { op: string }).op)).toEqual(['submit', 'get'])
  expect(store.snapshot().pendingRequest).toBeNull()
})
it('only explicit retry can submit a not-yet-accepted request, with the original id', async () => {
  const store = storeFixture(), id = `${Date.now()}_${crypto.randomUUID()}`
  await store.update({ pendingRequest: { id, text: 'hi', conversationId: crypto.randomUUID(), continuation: null, origin: 'https://main.example.test', thread: null } })
  const send = vi.fn((body: object): Promise<RequestReceipt> => {
    const request = body as { op: string; id: string }
    if (request.op === 'get') return Promise.reject(new OpenAGIApiError('request_not_found', 404, 'not accepted'))
    expect(request.id).toBe(id)
    return Promise.resolve({ id, state: 'completed', revision: 2, result: { question: 'hi', reply: 'hello', sessionId: 'test' } })
  })
  const client = new G2ExperienceClient(store, send as never, () => 'https://main.example.test')
  await expect(client.resume(undefined)).rejects.toThrow('not accepted')
  expect(send).toHaveBeenCalledOnce()
  await client.resume(undefined, undefined, true)
  expect(send.mock.calls.map(call => (call[0] as { op: string }).op)).toEqual(['get', 'get', 'submit'])
})
it('sends the shared thread with a submit and keeps it for an explicit resubmit', async () => {
  const store = storeFixture(); const conversationId = crypto.randomUUID(); await store.update({ conversationId })
  const bodies: Record<string, unknown>[] = []
  const send = vi.fn((body: object) => {
    bodies.push({ ...body })
    const request = body as { op: string; id: string }
    return Promise.resolve({ id: request.id, state: 'completed', revision: 1, result: { question: 'hi', reply: 'hello', sessionId: 'devices:agent:main' } })
  })
  const client = new G2ExperienceClient(store, send as never, () => 'https://main.example.test')
  await client.submit({ text: 'hi', conversationId }, undefined, undefined, 'supervisor')
  expect(bodies[0]).toMatchObject({ op: 'submit', thread: 'supervisor', question: { text: 'hi', conversationId } })
  expect(store.snapshot().pendingRequest).toBeNull()
})
it('falls back to this G2 conversation when an older main rejects the agent thread, with the same request id', async () => {
  const store = storeFixture(); const conversationId = crypto.randomUUID(); await store.update({ conversationId })
  const bodies: Record<string, unknown>[] = []
  const send = vi.fn((body: object) => {
    const request = body as { op: string; id: string; thread?: string }
    bodies.push(request)
    if (request.op === 'submit' && request.thread) return Promise.reject(new OpenAGIApiError('unsupported_experience_fields', 400, 'rejected'))
    return Promise.resolve({ id: request.id, state: 'completed', revision: 1, result: { question: 'hi', reply: 'hello', sessionId: 's' } })
  })
  const client = new G2ExperienceClient(store, send as never, () => 'https://main.example.test')
  await client.submit({ text: 'hi', conversationId }, undefined, undefined, 'agent')
  expect(bodies.map(b => [b.op, b.thread])).toEqual([['submit', 'agent'], ['submit', undefined]])
  expect(bodies[0].id).toBe(bodies[1].id)
  // Known unsupported: later questions skip the field; the supervisor has no fallback.
  await client.submit({ text: 'again', conversationId }, undefined, undefined, 'agent')
  expect(bodies.at(-1)?.thread).toBeUndefined()
  await expect(client.submit({ text: 'boss', conversationId }, undefined, undefined, 'supervisor')).rejects.toThrow('Update OpenAGI')
  expect(store.snapshot().pendingRequest).toBeNull()
  expect(bodies.filter(b => b.op === 'submit')).toHaveLength(3)
})
it('an older main rejecting a supervisor submit clears the saved request: nothing ran', async () => {
  const store = storeFixture(); const conversationId = crypto.randomUUID(); await store.update({ conversationId })
  const send = vi.fn(() => Promise.reject(new OpenAGIApiError('unsupported_experience_fields', 400, 'rejected')))
  const client = new G2ExperienceClient(store, send, () => 'https://main.example.test')
  await expect(client.submit({ text: 'boss', conversationId }, undefined, undefined, 'supervisor')).rejects.toMatchObject({ code: 'threads_unsupported' })
  expect(send).toHaveBeenCalledOnce(); expect(store.snapshot().pendingRequest).toBeNull()
})
