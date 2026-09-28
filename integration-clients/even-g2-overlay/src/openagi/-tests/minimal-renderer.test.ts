import { expect, it, vi } from 'vitest'
import { OpenAGIGlassesRenderer } from '../../ui/openagi-glasses-renderer'

it('keeps retained quiet listening minimal while preserving sleep and wake controls', () => {
  const surface = { show: vi.fn() }
  const renderer = new OpenAGIGlassesRenderer(surface as never)
  renderer.inboxCount(80); renderer.passive(true)
  expect(surface.show).toHaveBeenLastCalledWith('●', false, true)
  renderer.notice('Action identified', 'Send proposal')
  expect(surface.show).toHaveBeenLastCalledWith('Action identified\n\nSend proposal', false)
  renderer.sleep(true); renderer.passive(true)
  expect(surface.show).toHaveBeenLastCalledWith(' ', false)
  renderer.sleep(false)
  expect(surface.show).toHaveBeenLastCalledWith('●', false, true)
})

it('never shows a recording dot for non-retained lifelog, and names the three lifelog waits plainly', () => {
  const surface = { show: vi.fn() }
  const renderer = new OpenAGIGlassesRenderer(surface as never)
  renderer.passive(false)
  expect(surface.show.mock.calls.at(-1)?.[0]).not.toBe('●')
  renderer.lifelogHome('consent')
  expect(surface.show.mock.calls.at(-1)?.[0]).toContain('consent once')
  renderer.lifelogHome('paused')
  expect(surface.show.mock.calls.at(-1)?.[0]).toContain('Swipe down: resume')
  renderer.lifelogHome('waiting', 'Agents is in the background on the glasses.')
  const waiting = surface.show.mock.calls.at(-1)?.[0] as string
  expect(waiting).toContain('Tap: talk to agent'); expect(waiting).not.toContain('Listening paused')
})

it('flashes a short notice for an ignored gesture and restores the previous screen', async () => {
  vi.useFakeTimers()
  try {
    const surface = { show: vi.fn() }
    const renderer = new OpenAGIGlassesRenderer(surface as never)
    renderer.passive(true)
    renderer.flash('Microphone opening', 'Wait for Listening, then tap to stop.')
    expect(surface.show.mock.calls.at(-1)?.[0]).toContain('Microphone opening')
    await vi.advanceTimersByTimeAsync(2500)
    expect(surface.show).toHaveBeenLastCalledWith('●', false, true)
    // A newer screen is never replaced by the old one.
    renderer.flash('Busy', 'One moment'); renderer.home()
    await vi.advanceTimersByTimeAsync(2500)
    expect(surface.show.mock.calls.at(-1)?.[0]).toContain('Tap: talk to agent')
  } finally { vi.useRealTimers() }
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
