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

it('positions the clock and animated status in the upper-right without giving it gesture ownership', async () => {
  const { bridge } = await fixture()
  const page = bridge.createStartUpPageContainer.mock.calls[0] as unknown as [{ textObject: Array<Record<string, unknown>>; containerTotalNum: number }]
  expect(page[0].containerTotalNum).toBe(2)
  expect(page[0].textObject[0]).toMatchObject({ containerID: 1, width: 576, height: 248, yPosition: 40, isEventCapture: 1 })
  expect(page[0].textObject[1]).toMatchObject({ containerID: 2, xPosition: 312, yPosition: 4, width: 260, height: 32, isEventCapture: 0, content: ' ' })
})

it('shows compact listening status and keeps the clock on answers', async () => {
  vi.useFakeTimers()
  const { bridge, display } = await fixture()
  display.show(' ', false, true)
  await vi.runAllTimersAsync()
  expect(bridge.textContainerUpgrade.mock.calls.map(([v]) => v)).toEqual([
    expect.objectContaining({ containerID: 1, content: ' ' }),
    expect.objectContaining({ containerID: 2, content: expect.stringMatching(/^23:35 {2}Listening\.+$/) as unknown }),
  ])
  bridge.textContainerUpgrade.mockClear()
  display.show('Answer', false)
  await vi.runAllTimersAsync()
  expect(bridge.textContainerUpgrade.mock.calls.map(([v]) => v)).toEqual([
    expect.objectContaining({ containerID: 1, content: 'Answer' }),
    expect.objectContaining({ containerID: 2, content: '23:35' }),
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

it('clears an in-flight listening status before sleeping and restores it on the next active render', async () => {
  const { bridge, display } = await fixture()
  let finish!: (ok: boolean) => void
  bridge.textContainerUpgrade.mockImplementation(async (v: unknown) => {
    if ((v as { content: string }).content.includes('Listening')) return new Promise(resolve => { finish = resolve })
    return true
  })
  display.show(' ', true, true)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  display.show(' ', true)
  finish(true)
  await vi.waitFor(() => expect(bridge.textContainerUpgrade).toHaveBeenLastCalledWith(expect.objectContaining({ containerID: 2, content: ' ' })))
  bridge.textContainerUpgrade.mockImplementation(() => Promise.resolve(true))
  display.show(' ', true, true)
  await vi.waitFor(() => expect(bridge.textContainerUpgrade).toHaveBeenLastCalledWith(expect.objectContaining({ containerID: 2, content: expect.stringMatching(/^23:35 {2}Listening\.+$/) as unknown })))
})

it('retries a failed indicator write on the next render', async () => {
  vi.useFakeTimers()
  const { bridge, display } = await fixture()
  bridge.textContainerUpgrade.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
  display.show(' ', false, true); await vi.runAllTimersAsync()
  display.show(' ', false, true); await vi.runAllTimersAsync()
  expect(bridge.textContainerUpgrade.mock.calls.filter(([v]) => (v as { content: string }).content.includes('Listening'))).toHaveLength(2)
})

it('updates the clock and animates checking without new body content, then stays blank after sleep', async () => {
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
  expect(bridge.textContainerUpgrade).toHaveBeenLastCalledWith(expect.objectContaining({ content: '23:36  Checking.' }))
  display.refreshStatus()
  await vi.advanceTimersByTimeAsync(0)
  expect(bridge.textContainerUpgrade).toHaveBeenLastCalledWith(expect.objectContaining({ content: '23:36  Checking..' }))
  display.show(' ', true)
  await vi.advanceTimersByTimeAsync(0)
  expect(bridge.textContainerUpgrade).toHaveBeenCalledWith(expect.objectContaining({ containerID: 2, content: ' ' }))
  bridge.textContainerUpgrade.mockClear(); display.refreshStatus(); expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
})
