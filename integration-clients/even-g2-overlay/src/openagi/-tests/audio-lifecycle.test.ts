import { expect, it, vi } from 'vitest'
import { SerializedAudioSource } from '../audio-source'

it('serializes a stop requested while the microphone is opening', async () => {
  let resolveOpen!: (opened: boolean) => void
  const opening = new Promise<boolean>(resolve => { resolveOpen = resolve })
  const unsubscribe = vi.fn()
  const control = vi.fn((open: boolean) => open ? opening : Promise.resolve(true))
  const audio = new SerializedAudioSource({ audioControl: control, onEvenHubEvent: () => unsubscribe })
  const start = audio.start(vi.fn())
  const stop = audio.stop()
  await Promise.resolve()
  expect(control).toHaveBeenCalledTimes(1)
  resolveOpen(true)
  await start
  await stop
  expect(control.mock.calls.map(call => call[0])).toEqual([true, false])
  expect(audio.active).toBe(false)
  expect(unsubscribe).toHaveBeenCalledOnce()
})

it('cleans up rejected opens and can retry without a leaked listener', async () => {
  const unsubscribe = vi.fn()
  const control = vi.fn().mockRejectedValueOnce(new Error('bridge unavailable')).mockResolvedValue(true)
  const audio = new SerializedAudioSource({ audioControl: control, onEvenHubEvent: () => unsubscribe })
  await expect(audio.start(vi.fn())).rejects.toThrow('bridge unavailable')
  expect(unsubscribe).toHaveBeenCalledOnce()
  await audio.start(vi.fn())
  expect(audio.active).toBe(true)
  await audio.stop()
  expect(unsubscribe).toHaveBeenCalledTimes(2)
})

it('does not issue duplicate opens and does not classify a false result as proven permission denial', async () => {
  const control = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
  const audio = new SerializedAudioSource({ audioControl: control, onEvenHubEvent: () => vi.fn() })
  await expect(audio.start(vi.fn())).rejects.toThrow('could not open')
  await audio.start(vi.fn())
  await expect(audio.start(vi.fn())).rejects.toThrow('already in use')
  expect(control).toHaveBeenCalledTimes(3)
  await audio.stop()
})

it('requires confirmed release before reopening after a failed close', async () => {
  const control = vi.fn<(open: boolean) => Promise<boolean>>().mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true)
  const audio = new SerializedAudioSource({ audioControl: control, onEvenHubEvent: () => vi.fn() })
  await audio.start(vi.fn())
  await expect(audio.stop()).rejects.toThrow('did not confirm microphone release')
  expect(audio.active).toBe(true) // Unknown native state must not be mistaken for closed.
  await expect(audio.start(vi.fn())).rejects.toThrow('did not confirm microphone release')
  expect(control.mock.calls.map(call => call[0])).toEqual([true, false, false])
  await audio.start(vi.fn())
  expect(control.mock.calls.map(call => call[0])).toEqual([true, false, false, false, true])
  await audio.stop()
})
