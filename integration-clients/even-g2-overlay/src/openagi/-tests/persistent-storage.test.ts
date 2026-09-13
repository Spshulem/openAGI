import { expect, it, vi } from 'vitest'
import { EvenKeyValueStorage } from '../persistent-storage'
import { OpenAGIStore } from '../store'
import { OpenAGIG2App } from '../../app/openagi-g2-app'

function fixture() {
  const values = new Map<string, string>()
  const bridge = {
    getLocalStorage: vi.fn((key: string) => Promise.resolve(values.get(key) ?? '')),
    setLocalStorage: vi.fn((key: string, value: string) => { values.set(key, value); return Promise.resolve(true) }),
  }
  const legacy = { get: vi.fn((): Promise<string | null> => Promise.resolve(null)), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) }
  return { bridge, legacy, storage: new EvenKeyValueStorage(bridge, legacy) }
}

it('reopens with the same pairing and URL without another enrollment or browser storage', async () => {
  const { bridge, legacy, storage } = fixture()
  const first = new OpenAGIStore(storage)
  const id = first.snapshot().nodeId
  await first.update({ nodeToken: 'scoped-test-token-1234', agentOrigin: 'https://main.example.com',
    node: { id, name: 'G2', platform: 'even_g2', enrolledAt: new Date().toISOString() } })
  const reopened = new OpenAGIStore(new EvenKeyValueStorage(bridge, legacy))
  const heartbeat = vi.fn(() => Promise.resolve({ ok: true }))
  const enroll = vi.fn()
  const paired = vi.fn()
  type Args = ConstructorParameters<typeof OpenAGIG2App>
  const app = new OpenAGIG2App(
    { heartbeat, enroll } as unknown as Args[0], reopened, { active: false, stop: () => Promise.resolve() } as Args[2],
    { home: vi.fn() } as unknown as Args[3],
    { paired, set: vi.fn(), ambient: vi.fn() } as unknown as Args[4], [],
  )
  try {
    await app.boot()
    expect(reopened.snapshot()).toEqual(first.snapshot())
    expect(heartbeat).toHaveBeenCalledOnce()
    expect(enroll).not.toHaveBeenCalled()
    expect(paired).toHaveBeenCalledWith(true)
    expect(legacy.get).not.toHaveBeenCalled()
  } finally { await app.systemExit() }
})

it('migrates existing browser state to native storage', async () => {
  const { bridge, legacy, storage } = fixture()
  legacy.get.mockResolvedValue('existing-state')
  expect(await storage.get('state')).toBe('existing-state')
  expect(bridge.setLocalStorage).toHaveBeenCalledWith('state', 'existing-state')
  expect(legacy.remove).toHaveBeenCalledWith('state')
})

it('does not claim credentials are saved when native storage fails', async () => {
  const { bridge, storage } = fixture()
  bridge.setLocalStorage.mockResolvedValue(false)
  const store = new OpenAGIStore(storage)
  await expect(store.update({ nodeToken: 'scoped-test-token-1234' })).rejects.toThrow('Could not save')
  expect(store.snapshot().nodeToken).toBeNull()
})

it('does not fall back to stale browser credentials when native reads fail', async () => {
  const { bridge, legacy, storage } = fixture()
  bridge.getLocalStorage.mockRejectedValue(new Error('bridge unavailable'))
  await expect(storage.get('state')).rejects.toThrow('bridge unavailable')
  expect(legacy.get).not.toHaveBeenCalled()
})

it('disconnect stays disconnected across reopen even if legacy cleanup fails', async () => {
  const { bridge, legacy, storage } = fixture()
  const store = new OpenAGIStore(storage)
  await store.update({ nodeToken: 'scoped-test-token-1234' })
  legacy.remove.mockRejectedValue(new Error('browser unavailable'))
  await store.clearCredential()
  const reopened = new OpenAGIStore(new EvenKeyValueStorage(bridge, legacy))
  expect((await reopened.load()).nodeToken).toBeNull()
  expect(legacy.get).not.toHaveBeenCalled()
})
