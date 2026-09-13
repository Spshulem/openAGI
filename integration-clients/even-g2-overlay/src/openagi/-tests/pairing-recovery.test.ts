import { expect, it, vi } from 'vitest'
import { OpenAGIG2App } from '../../app/openagi-g2-app'
import { OpenAGIPhoneCompanion } from '../../ui/openagi-phone-companion'
import { OpenAGIStore } from '../store'

it('reuses pending credentials after lost responses and ignores Pair once enrolled', async () => {
  const store = new OpenAGIStore({ get: () => Promise.resolve(null), set: () => Promise.resolve(), remove: () => Promise.resolve() })
  const enroll = vi.fn().mockRejectedValueOnce(new Error('lost')).mockRejectedValueOnce(new Error('lost'))
    .mockImplementation((_code: string, id: string, token: string) => Promise.resolve({ nodeToken: token, node: { id, name: 'G2', platform: 'even_g2', enrolledAt: new Date().toISOString() } }))
  type Args = ConstructorParameters<typeof OpenAGIG2App>
  const app = new OpenAGIG2App(
    { enroll, heartbeat: () => Promise.resolve({ ok: true }) } as unknown as Args[0], store,
    { active: false, stop: () => Promise.resolve() } as Args[2],
    { pairing: vi.fn(), message: vi.fn(), home: vi.fn() } as unknown as Args[3],
    { set: vi.fn(), paired: vi.fn() } as unknown as Args[4], [],
  )
  try {
    await app.pair('123456', 'https://main.example.com')
    const pending = store.snapshot()
    await app.pair('123456', 'https://main.example.com')
    expect(enroll.mock.calls[2].slice(1, 3)).toEqual([pending.nodeId, pending.nodeToken])
    await app.pair('123456', 'https://main.example.com')
    expect(enroll).toHaveBeenCalledTimes(3)
  } finally { await app.systemExit() }
})

it('hides pairing after connection and shows phone errors', () => {
  document.body.innerHTML = '<div id="app"></div>'
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask: vi.fn(), newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn(), configureAmbient: vi.fn() }, [])
  phone.paired(true)
  expect(getComputedStyle(document.querySelector('#pair')!).display).toBe('none')
  phone.paired(false)
  phone.set('Pairing failed', 'Retry with your main server code.')
  expect(document.querySelector('#status')?.textContent).toBe('Pairing failed')
  expect(document.querySelector('#detail')?.textContent).toContain('main server code')
})
