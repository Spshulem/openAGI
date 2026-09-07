import { expect, it, vi } from 'vitest'
import { OpenAGIGlassesRenderer } from '../../ui/openagi-glasses-renderer'

it('keeps retained quiet listening minimal while preserving sleep and wake controls', () => {
  const surface = { show: vi.fn() }
  const renderer = new OpenAGIGlassesRenderer(surface as never)
  renderer.inboxCount(80); renderer.passive(true, false, 'Peri')
  expect(surface.show).toHaveBeenLastCalledWith('Listening .', false)
  renderer.notice('Action identified', 'Send proposal')
  expect(surface.show).toHaveBeenLastCalledWith('Action identified\n\nSend proposal', false)
  renderer.sleep(true); renderer.passive(true, false, 'Peri')
  expect(surface.show).toHaveBeenLastCalledWith(' ', false)
  renderer.sleep(false)
  expect(surface.show).toHaveBeenLastCalledWith('Listening ..', false)
})
