import { z } from 'zod'
import type { KeyValueStorage } from '../storage/recovery-store'

const StateSchema = z.object({
  version: z.literal(2),
  nodeId: z.string().uuid(),
  nodeToken: z.string().min(16).max(4_096).nullable(),
  node: z.object({ id: z.string().uuid(), name: z.string(), platform: z.literal('even_g2'), enrolledAt: z.string() }).nullable(),
  conversationId: z.string().uuid().nullable(),
  ambientEnabled: z.boolean().default(false),
  listeningMode: z.enum(['passive', 'wake']).default('passive'),
  idleTapAction: z.enum(['talk', 'highlight']).default('talk'),
  wakePhrase: z.string().trim().min(1).max(40).default('open agi'),
  answerQuestions: z.boolean().default(true),
  speechModel: z.enum(['openai-buffered', 'nova-3', 'nova-2']).default('openai-buffered'),
  speechTransport: z.enum(['relay', 'direct']).default('relay'),
  autoSend: z.boolean().default(true),
  connectionMode: z.enum(['enrollment', 'direct']).default('enrollment'),
  agentOrigin: z.string().url().nullable().default(null),
  history: z.array(z.object({ conversationId: z.string().uuid(), question: z.string(), reply: z.string(), at: z.string() })).max(30).default([]),
})
export type OpenAGIState = z.infer<typeof StateSchema>
const KEY = 'openagi.g2.state.v2'

function empty(nodeId: string = crypto.randomUUID(), preferences?: Pick<OpenAGIState, 'ambientEnabled' | 'listeningMode' | 'idleTapAction' | 'wakePhrase' | 'answerQuestions' | 'speechModel' | 'speechTransport' | 'autoSend'>): OpenAGIState {
  return {
    version: 2, nodeId, nodeToken: null, node: null, conversationId: null,
    ambientEnabled: preferences?.ambientEnabled ?? false, wakePhrase: preferences?.wakePhrase ?? 'open agi',
    listeningMode: preferences?.listeningMode ?? 'passive',
    idleTapAction: preferences?.idleTapAction ?? 'talk',
    answerQuestions: preferences?.answerQuestions ?? true,
    speechModel: preferences?.speechModel ?? 'openai-buffered',
    speechTransport: preferences?.speechTransport ?? 'relay',
    autoSend: preferences?.autoSend ?? true,
    connectionMode: 'enrollment', agentOrigin: null, history: [],
  }
}

export class OpenAGIStore {
  private state: OpenAGIState = empty()
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
    await this.update({ history: [...this.state.history, { conversationId: this.state.conversationId, question: question.slice(0, 4000), reply: reply.slice(0, 16000), at: new Date().toISOString() }].slice(-30) })
  }
  async update(patch: Partial<Omit<OpenAGIState, 'version'>>): Promise<OpenAGIState> {
    const changedMain = patch.agentOrigin !== undefined && patch.agentOrigin !== this.state.agentOrigin
    const next = StateSchema.parse({ ...this.state, ...patch, ...(changedMain ? { history: [] } : {}), version: 2 })
    await this.storage.set(KEY, JSON.stringify(next))
    this.state = next
    return this.snapshot()
  }
  async clearCredential(): Promise<void> {
    const next = empty(this.state.nodeId, this.state)
    await this.storage.set(KEY, JSON.stringify(next))
    this.state = next
  }
}
