import { afterEach, expect, it, vi } from 'vitest'
import { StartUpPageCreateResult } from '@evenrealities/even_hub_sdk'
import { AgentsDisplayController } from '../display-controller'

afterEach(() => vi.useRealTimers())

async function fixture() {
  const bridge = {
    createStartUpPageContainer: vi.fn(() => Promise.resolve(StartUpPageCreateResult.success)),
    textContainerUpgrade: vi.fn((value: unknown) => { void value; return Promise.resolve(true) }),
  }
  const display = new AgentsDisplayController(bridge as never, 160, () => new Date('2026-10-27T23:35:00'))
  await display.initialize('Starting')
  return { bridge, display }
}

it('positions the still clock in the upper-right without giving it gesture ownership', async () => {
  const { bridge } = await fixture()
  const page = bridge.createStartUpPageContainer.mock.calls[0] as unknown as [{ textObject: Array<Record<string, unknown>>; containerTotalNum: number }]
  expect(page[0].containerTotalNum).toBe(2)
  expect(page[0].textObject[0]).toMatchObject({ containerID: 1, width: 576, height: 248, yPosition: 40, isEventCapture: 1 })
  expect(page[0].textObject[1]).toMatchObject({ containerID: 2, xPosition: 312, yPosition: 4, width: 260, height: 32, isEventCapture: 0, content: ' ' })
})

it('shows only a still clock while listening, with no Listening label or animation', async () => {
  vi.useFakeTimers()
  const { bridge, display } = await fixture()
  display.show(' ', false, true)
  await vi.runAllTimersAsync()
  expect(bridge.textContainerUpgrade.mock.calls.map(([v]) => v)).toEqual([
    expect.objectContaining({ containerID: 1, content: ' ' }),
    expect.objectContaining({ containerID: 2, content: '23:35' }),
  ])
  bridge.textContainerUpgrade.mockClear()
  display.show(' ', false, true)
  await vi.runAllTimersAsync()
  expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
  display.show('Answer', false)
  await vi.runAllTimersAsync()
  // The clock is already showing and unchanged, so only the body is written.
  expect(bridge.textContainerUpgrade.mock.calls.map(([v]) => v)).toEqual([
    expect.objectContaining({ containerID: 1, content: 'Answer' }),
  ])
})

it('does not restore a stale listening status if pause arrives while the main text is clearing', async () => {
  const { bridge, display } = await fixture()
  let finish!: (ok: boolean) => void
  bridge.textContainerUpgrade.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  display.show(' ', true, true)
  display.show('Microphone off', true)
  finish(true)
  await vi.waitFor(() => expect(bridge.textContainerUpgrade).toHaveBeenLastCalledWith(expect.objectContaining({ containerID: 2, content: '23:35' })))
  expect(bridge.textContainerUpgrade.mock.calls.some(([v]) => (v as { content: string }).content.includes('Listening'))).toBe(false)
})

it('clears an in-flight checking status before sleeping and restores it on the next active render', async () => {
  const { bridge, display } = await fixture()
  let finish!: (ok: boolean) => void
  bridge.textContainerUpgrade.mockImplementation(async (v: unknown) => {
    if ((v as { content: string }).content.includes('Checking')) return new Promise(resolve => { finish = resolve })
    return true
  })
  display.show(' ', true, 'checking')
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  display.show(' ', true)
  finish(true)
  await vi.waitFor(() => expect(bridge.textContainerUpgrade).toHaveBeenLastCalledWith(expect.objectContaining({ containerID: 2, content: ' ' })))
  bridge.textContainerUpgrade.mockImplementation(() => Promise.resolve(true))
  display.show(' ', true, 'checking')
  await vi.waitFor(() => expect(bridge.textContainerUpgrade).toHaveBeenLastCalledWith(expect.objectContaining({ containerID: 2, content: '23:35  Checking…' })))
})

it('retries a failed indicator write on the next render', async () => {
  vi.useFakeTimers()
  const { bridge, display } = await fixture()
  bridge.textContainerUpgrade.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
  display.show(' ', false, 'checking'); await vi.runAllTimersAsync()
  display.show(' ', false, 'checking'); await vi.runAllTimersAsync()
  expect(bridge.textContainerUpgrade.mock.calls.filter(([v]) => (v as { content: string }).content.includes('Checking'))).toHaveLength(2)
})

it('updates the clock, shows a static Checking… only during work, then stays blank after sleep', async () => {
  vi.useFakeTimers()
  const bridge = { createStartUpPageContainer: vi.fn(() => Promise.resolve(StartUpPageCreateResult.success)), textContainerUpgrade: vi.fn(() => Promise.resolve(true)) }
  let now = new Date('2026-10-27T23:35:00')
  const display = new AgentsDisplayController(bridge as never, 160, () => now)
  await display.initialize('Answer'); display.show('Answer', true)
  await vi.advanceTimersByTimeAsync(0)
  expect(bridge.textContainerUpgrade).toHaveBeenLastCalledWith(expect.objectContaining({ content: '23:35' }))
  now = new Date('2026-10-27T23:36:00'); display.refreshStatus()
  await vi.advanceTimersByTimeAsync(0)
  expect(bridge.textContainerUpgrade).toHaveBeenLastCalledWith(expect.objectContaining({ content: '23:36' }))
  display.show('Checking', true, 'checking')
  await vi.advanceTimersByTimeAsync(0)
  expect(bridge.textContainerUpgrade).toHaveBeenLastCalledWith(expect.objectContaining({ content: '23:36  Checking…' }))
  bridge.textContainerUpgrade.mockClear(); display.refreshStatus()
  await vi.advanceTimersByTimeAsync(0)
  expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
  display.show(' ', true)
  await vi.advanceTimersByTimeAsync(0)
  expect(bridge.textContainerUpgrade).toHaveBeenCalledWith(expect.objectContaining({ containerID: 2, content: ' ' }))
  bridge.textContainerUpgrade.mockClear(); display.refreshStatus(); expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
})

it('marks interrupted capture with one short word and active capture with the clock alone', async () => {
  const { bridge, display } = await fixture()
  display.show(' ', true, 'interrupted')
  await vi.waitFor(() => expect(bridge.textContainerUpgrade).toHaveBeenLastCalledWith(expect.objectContaining({ containerID: 2, content: '23:35  Mic off' })))
  display.show(' ', true, 'listening')
  await vi.waitFor(() => expect(bridge.textContainerUpgrade).toHaveBeenLastCalledWith(expect.objectContaining({ containerID: 2, content: '23:35' })))
  display.show(' ', true, 'paused')
  await vi.waitFor(() => expect(bridge.textContainerUpgrade).toHaveBeenLastCalledWith(expect.objectContaining({ containerID: 2, content: '23:35  Paused' })))
})
