import { afterEach, expect, it, vi } from 'vitest'
import { StartUpPageCreateResult } from '@evenrealities/even_hub_sdk'
import { AgentsDisplayController } from '../display-controller'

afterEach(() => vi.useRealTimers())

async function fixture() {
  const bridge = {
    createStartUpPageContainer: vi.fn(async () => StartUpPageCreateResult.success),
    textContainerUpgrade: vi.fn(async (_value: unknown) => true),
  }
  const display = new AgentsDisplayController(bridge as never)
  await display.initialize('Starting')
  return { bridge, display }
}

it('positions the dot in the upper-right without giving it gesture ownership', async () => {
  const { bridge } = await fixture()
  const page = bridge.createStartUpPageContainer.mock.calls[0] as unknown as [{ textObject: Array<Record<string, unknown>>; containerTotalNum: number }]
  expect(page[0].containerTotalNum).toBe(2)
  expect(page[0].textObject[0]).toMatchObject({ containerID: 1, width: 576, height: 288, isEventCapture: 1 })
  expect(page[0].textObject[1]).toMatchObject({ containerID: 2, xPosition: 540, yPosition: 4, width: 32, height: 32, isEventCapture: 0, content: ' ' })
})

it('clears the main text before showing the dot and clears the dot before answers', async () => {
  vi.useFakeTimers()
  const { bridge, display } = await fixture()
  display.show('●', false, true)
  await vi.runAllTimersAsync()
  expect(bridge.textContainerUpgrade.mock.calls.map(([v]) => v)).toEqual([
    expect.objectContaining({ containerID: 1, content: ' ' }),
    expect.objectContaining({ containerID: 2, content: '●' }),
  ])
  bridge.textContainerUpgrade.mockClear()
  display.show('Answer', false)
  await vi.runAllTimersAsync()
  expect(bridge.textContainerUpgrade.mock.calls.map(([v]) => v)).toEqual([
    expect.objectContaining({ containerID: 2, content: ' ' }),
    expect.objectContaining({ containerID: 1, content: 'Answer' }),
  ])
})

it('does not restore a stale dot if pause arrives while the main text is clearing', async () => {
  const { bridge, display } = await fixture()
  let finish!: (ok: boolean) => void
  bridge.textContainerUpgrade.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  display.show('●', true, true)
  display.show('Microphone off', true)
  finish(true)
  await vi.waitFor(() => expect(bridge.textContainerUpgrade).toHaveBeenLastCalledWith(expect.objectContaining({ containerID: 1, content: 'Microphone off' })))
  expect(bridge.textContainerUpgrade.mock.calls.some(([v]) => (v as { content: string }).content === '●')).toBe(false)
})

it('clears an in-flight dot before sleeping and restores it on the next active render', async () => {
  const { bridge, display } = await fixture()
  let finish!: (ok: boolean) => void
  bridge.textContainerUpgrade.mockImplementation(async (v: unknown) => {
    if ((v as { content: string }).content === '●') return new Promise(resolve => { finish = resolve })
    return true
  })
  display.show('●', true, true)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  display.show(' ', true)
  finish(true)
  await vi.waitFor(() => expect(bridge.textContainerUpgrade).toHaveBeenLastCalledWith(expect.objectContaining({ containerID: 2, content: ' ' })))
  bridge.textContainerUpgrade.mockImplementation(async () => true)
  display.show('●', true, true)
  await vi.waitFor(() => expect(bridge.textContainerUpgrade).toHaveBeenLastCalledWith(expect.objectContaining({ containerID: 2, content: '●' })))
})

it('retries a failed indicator write on the next render', async () => {
  vi.useFakeTimers()
  const { bridge, display } = await fixture()
  bridge.textContainerUpgrade.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
  display.show('●', false, true); await vi.runAllTimersAsync()
  display.show('●', false, true); await vi.runAllTimersAsync()
  expect(bridge.textContainerUpgrade.mock.calls.filter(([v]) => (v as { content: string }).content === '●')).toHaveLength(2)
})
