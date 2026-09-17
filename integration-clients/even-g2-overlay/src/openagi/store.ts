import { z } from 'zod'
import type { KeyValueStorage } from '../storage/recovery-store'

const StateSchema = z.object({
  version: z.literal(2),
  nodeId: z.string().uuid(),
  nodeToken: z.string().min(16).max(4_096).nullable(),
  node: z.object({ id: z.string().uuid(), name: z.string(), platform: z.literal('even_g2'), enrolledAt: z.string() }).nullable(),
  conversationId: z.string().uuid().nullable(),
  continuation: z.string().max(200).nullable().default(null),
  interfaceStyle: z.enum(['focused', 'classic']).default('focused'),
  lifelogPaused: z.boolean().default(false),
  savedDraft: z.string().max(4000).default(''),
  pendingRequest: z.object({ id: z.string().max(80), conversationId: z.string().uuid(), continuation: z.string().max(200).nullable(), text: z.string().max(4000).nullable(), origin: z.string().url() }).nullable().default(null),
  ambientEnabled: z.boolean().default(false),
  lifelogEnabled: z.boolean().default(false),
  backgroundListening: z.boolean().default(false),
  lifelogConsent: z.object({ id: z.string().min(1).max(200), until: z.number().finite() }).nullable().default(null),
  listeningMode: z.enum(['passive', 'wake']).default('passive'),
  idleTapAction: z.enum(['talk', 'highlight']).default('talk'),
  lifelogTalkMode: z.enum(['tap', 'hold']).default('tap'),
  wakePhrase: z.string().trim().min(1).max(40).default('open agi'),
  answerQuestions: z.boolean().default(true),
  speechModel: z.enum(['openai-buffered', 'nova-3', 'nova-2']).default('openai-buffered'),
  speechTransport: z.enum(['relay', 'direct']).default('relay'),
  autoSend: z.boolean().default(true),
  connectionMode: z.enum(['enrollment', 'direct']).default('enrollment'),
  agentOrigin: z.string().url().nullable().default(null),
  history: z.array(z.object({ conversationId: z.string().uuid(), continuation: z.string().max(200).nullable().default(null), question: z.string(), reply: z.string(), at: z.string() })).max(30).default([]),
})
export type OpenAGIState = z.infer<typeof StateSchema>
const KEY = 'openagi.g2.state.v2'

function empty(nodeId: string = crypto.randomUUID(), preferences?: Pick<OpenAGIState, 'ambientEnabled' | 'listeningMode' | 'idleTapAction' | 'lifelogTalkMode' | 'wakePhrase' | 'answerQuestions' | 'speechModel' | 'speechTransport' | 'autoSend'>): OpenAGIState {
  return {
    version: 2, nodeId, nodeToken: null, node: null, conversationId: null,
    continuation: null, interfaceStyle: 'focused', lifelogPaused: false, savedDraft: '', pendingRequest: null,
    lifelogEnabled: false, lifelogConsent: null, backgroundListening: false,
    ambientEnabled: preferences?.ambientEnabled ?? false, wakePhrase: preferences?.wakePhrase ?? 'open agi',
    listeningMode: preferences?.listeningMode ?? 'passive',
    idleTapAction: preferences?.idleTapAction ?? 'talk',
    lifelogTalkMode: preferences?.lifelogTalkMode ?? 'tap',
    answerQuestions: preferences?.answerQuestions ?? true,
    speechModel: preferences?.speechModel ?? 'openai-buffered',
    speechTransport: preferences?.speechTransport ?? 'relay',
    autoSend: preferences?.autoSend ?? true,
    connectionMode: 'enrollment', agentOrigin: null, history: [],
  }
}

export class OpenAGIStore {
  private state: OpenAGIState = empty()
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly storage: KeyValueStorage) {}
  async load(): Promise<OpenAGIState> {
    const raw = await this.storage.get(KEY)
    if (!raw) return this.snapshot()
    try { this.state = StateSchema.parse(JSON.parse(raw)) } catch { await this.clearCredential() }
    return this.snapshot()
  }
  snapshot(): OpenAGIState { return structuredClone(this.state) }
  async remember(question: string, reply: string): Promise<void> {
    if (!this.state.conversationId) return
    await this.update({ history: [...this.state.history, { conversationId: this.state.conversationId, continuation: this.state.continuation, question: question.slice(0, 4000), reply: reply.slice(0, 16000), at: new Date().toISOString() }].slice(-30) })
  }
  update(patch: Partial<Omit<OpenAGIState, 'version'>>): Promise<OpenAGIState> {
    const savedPatch = structuredClone(patch)
    const result = this.writes.then(() => this.persistUpdate(savedPatch))
    this.writes = result.then(() => undefined, () => undefined)
    return result
  }
  private async persistUpdate(patch: Partial<Omit<OpenAGIState, 'version'>>): Promise<OpenAGIState> {
    const changedMain = patch.agentOrigin !== undefined && patch.agentOrigin !== this.state.agentOrigin
    const changedCredential = patch.nodeToken !== undefined && patch.nodeToken !== this.state.nodeToken
    const next = StateSchema.parse({ ...this.state, ...patch, ...(changedMain || changedCredential ? { history: [], continuation: null, pendingRequest: null, savedDraft: '', lifelogEnabled: false, lifelogPaused: false, lifelogConsent: null, backgroundListening: false } : {}), version: 2 })
    await this.storage.set(KEY, JSON.stringify(next))
    this.state = next
    return this.snapshot()
  }
  async clearCredential(): Promise<void> {
    const result = this.writes.then(async () => {
      const next = empty(this.state.nodeId, this.state)
      await this.storage.set(KEY, JSON.stringify(next))
      this.state = next
    })
    this.writes = result.catch(() => undefined)
    await result
  }
}
