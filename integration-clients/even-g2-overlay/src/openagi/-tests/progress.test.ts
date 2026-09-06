import { expect, it, vi } from 'vitest'
import { progressDetail, progressLabel } from '../progress'
import { OpenAGIGlassesRenderer } from '../../ui/openagi-glasses-renderer'

it('distinguishes tool work from thinking and transcription', () => {
  expect(progressLabel('tool')).toBe('Using a tool')
  expect(progressLabel('model')).toBe('Thinking')
  expect(progressLabel('transcribing')).toBe('Transcribing speech')
  expect(progressLabel('routing')).toBe('Choosing agent')
})

it('distinguishes connected progress from silence and no streaming response', () => {
  expect(progressDetail(0, 29000, true, 30000)).toContain('not task progress')
  expect(progressDetail(0, 0, true, 30000)).toContain('No server data for 30s')
  expect(progressDetail(0, 0, false, 30000)).toContain('Waiting for server data')
})

it('shows partial output without a misleading tap-to-continue instruction', () => {
  const show = vi.fn()
  const renderer = new OpenAGIGlassesRenderer({ show, initialize: () => Promise.resolve() })
  renderer.progress('Answer arriving', '12s elapsed', 'The answer so far')
  expect(show).toHaveBeenCalledWith(expect.stringContaining('The answer so far'), false)
  expect(show.mock.calls[0][0]).toContain('Cancel on phone')
  expect(show.mock.calls[0][0]).not.toContain('Tap to continue')
})
