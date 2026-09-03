import { z } from 'zod'
import type { KeyValueStorage } from '../storage/recovery-store'

const StateSchema = z.object({
  version: z.literal(2),
  nodeId: z.string().uuid(),
  nodeToken: z.string().length(43).nullable(),
  node: z.object({ id: z.string().uuid(), name: z.string(), platform: z.literal('even_g2'), enrolledAt: z.string() }).nullable(),
  conversationId: z.string().uuid().nullable(),
})
export type OpenAGIState = z.infer<typeof StateSchema>
const KEY = 'openagi.g2.state.v2'

function empty(nodeId: string = crypto.randomUUID()): OpenAGIState {
  return { version: 2, nodeId, nodeToken: null, node: null, conversationId: null }
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
  async update(patch: Partial<Omit<OpenAGIState, 'version'>>): Promise<OpenAGIState> {
    this.state = StateSchema.parse({ ...this.state, ...patch, version: 2 })
    await this.storage.set(KEY, JSON.stringify(this.state))
    return this.snapshot()
  }
  async clearCredential(): Promise<void> {
    this.state = empty(this.state.nodeId)
    await this.storage.set(KEY, JSON.stringify(this.state))
  }
}
