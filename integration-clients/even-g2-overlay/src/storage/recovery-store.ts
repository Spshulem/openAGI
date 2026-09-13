import { z } from 'zod'

const StoredStateSchema = z.object({
  version: z.literal(1),
  deviceCredential: z.string().min(32).nullable(),
  device: z.object({
    id: z.string().uuid(),
    displayName: z.string(),
    workspace: z.object({ id: z.string(), name: z.string() }),
  }).nullable(),
  activeSession: z.object({
    sessionId: z.string().uuid(),
    recordingId: z.string().uuid(),
    idempotencyKey: z.string().uuid(),
    nextSequence: z.number().int().nonnegative(),
    startedAt: z.string(),
  }).nullable(),
  liveCursor: z.string().nullable(),
  liveRecordingId: z.string().uuid().nullable().default(null),
})

export type StoredState = z.infer<typeof StoredStateSchema>

export interface KeyValueStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

const KEY = 'buildbetter.g2.state.v1'
const EMPTY: StoredState = { version: 1, deviceCredential: null, device: null, activeSession: null, liveCursor: null, liveRecordingId: null }

export class RecoveryStore {
  private state: StoredState = structuredClone(EMPTY)

  constructor(private readonly storage: KeyValueStorage) {}

  async load(): Promise<StoredState> {
    const raw = await this.storage.get(KEY)
    if (!raw) return this.snapshot()
    try {
      this.state = StoredStateSchema.parse(JSON.parse(raw))
    } catch {
      await this.storage.remove(KEY)
      this.state = structuredClone(EMPTY)
    }
    return this.snapshot()
  }

  snapshot(): StoredState {
    return structuredClone(this.state)
  }

  async update(patch: Partial<Omit<StoredState, 'version'>>): Promise<StoredState> {
    this.state = StoredStateSchema.parse({ ...this.state, ...patch, version: 1 })
    await this.storage.set(KEY, JSON.stringify(this.state))
    return this.snapshot()
  }

  async clear(): Promise<void> {
    this.state = structuredClone(EMPTY)
    await this.storage.remove(KEY)
  }
}

export class BrowserKeyValueStorage implements KeyValueStorage {
  get(key: string): Promise<string | null> { return Promise.resolve(localStorage.getItem(key)) }
  set(key: string, value: string): Promise<void> { localStorage.setItem(key, value); return Promise.resolve() }
  remove(key: string): Promise<void> { localStorage.removeItem(key); return Promise.resolve() }
}
