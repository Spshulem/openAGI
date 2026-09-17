import { expect, it, vi } from 'vitest'
import { OpenAGIGlassesRenderer } from '../../ui/openagi-glasses-renderer'

it('keeps retained quiet listening minimal while preserving sleep and wake controls', () => {
  const surface = { show: vi.fn() }
  const renderer = new OpenAGIGlassesRenderer(surface as never)
  renderer.inboxCount(80); renderer.passive(true, false, 'Peri')
  expect(surface.show).toHaveBeenLastCalledWith('●', false, true)
  renderer.notice('Action identified', 'Send proposal')
  expect(surface.show).toHaveBeenLastCalledWith('Action identified\n\nSend proposal', false)
  renderer.sleep(true); renderer.passive(true, false, 'Peri')
  expect(surface.show).toHaveBeenLastCalledWith(' ', false)
  renderer.sleep(false)
  expect(surface.show).toHaveBeenLastCalledWith('●', false, true)
})

it('never shows a recording dot for paused or non-retained listening', () => {
  const surface = { show: vi.fn() }
  const renderer = new OpenAGIGlassesRenderer(surface as never)
  renderer.passive(false, false, 'Peri')
  expect(surface.show.mock.calls.at(-1)?.[0]).not.toBe('●')
  renderer.paused(true)
  expect(surface.show.mock.calls.at(-1)?.[0]).toContain('Microphone off')
  renderer.paused(true, true)
  expect(surface.show.mock.calls.at(-1)?.[0]).toContain('including from other participants')
})

it('describes native exit at home and keeps the Recent gesture on swipe', () => {
  const surface = { show: vi.fn<(content: string, immediate?: boolean, recording?: boolean) => void>() }
  const renderer = new OpenAGIGlassesRenderer(surface as never)
  for (const count of [0, 80]) {
    renderer.inboxCount(count); renderer.home()
    const content = surface.show.mock.calls.at(-1)?.[0]
    expect(content).toContain('Double-tap: exit')
    expect(content).toContain('Recent')
    expect(content).not.toContain('double-tap: Recent')
  }
  renderer.unpaired()
  expect(surface.show.mock.calls.at(-1)?.[0]).toContain('Double-tap: exit')
})
