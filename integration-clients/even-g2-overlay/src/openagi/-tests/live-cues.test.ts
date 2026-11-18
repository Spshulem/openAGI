import { expect, it, vi } from 'vitest'
import { LiveCueContext } from '../live-cues'
import { checkServers, normalizeServerAddress } from '../server-discovery'
import { OpenAGIGlassesRenderer } from '../../ui/openagi-glasses-renderer'
import { OpenAGIPhoneCompanion } from '../../ui/openagi-phone-companion'

it('bounds live context and does not replay earlier conversations after a pause', () => {
  const context = new LiveCueContext()
  expect(context.add('First question', 1000)).toBe('First question')
  expect(context.add('Second words', 2000)).toBeNull()
  expect(context.add('Another question', 32000)).toContain('Second words')
  context.clear(); expect(context.add('New conversation', 33000)).toBe('New conversation')
})

it('checks only explicit HTTPS candidates without sending credentials or following redirects', async () => {
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ service: 'openagi', role: 'main' }))))
  expect(normalizeServerAddress('main.example.ts.net')).toBe('https://main.example.ts.net')
  expect(() => normalizeServerAddress('https://localhost')).toThrow('this phone')
  expect(() => normalizeServerAddress('https://main.example.com/?token=secret')).toThrow()
  expect(await checkServers(['https://main.example.com', 'https://main.example.com'], fetcher)).toEqual([{ name: 'main.example.com', origin: 'https://main.example.com' }])
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://main.example.com/health?client=g2', expect.objectContaining({ credentials: 'omit', redirect: 'error' }))
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ service: 'unrelated' })))
  expect(await checkServers(['https://main.example.com'], fetcher)).toEqual([])
})

it('keeps transcript visibility independent of listening and renders brief and expanded cues', () => {
  const surface = { show: vi.fn() }, renderer = new OpenAGIGlassesRenderer(surface as never)
  renderer.liveTranscript('Private live words'); renderer.passive(true)
  expect(surface.show).toHaveBeenLastCalledWith(' ', false, 'listening')
  renderer.transcriptVisible(true); renderer.passive(true)
  expect(surface.show).toHaveBeenLastCalledWith('Private live words', false, 'listening')
  renderer.cue('Tomorrow', 'Two meetings.'); expect(surface.show.mock.calls.at(-1)?.[0]).toContain('Tap: expand')
  renderer.cueDetail('Meeting details', 0, 1); expect(surface.show.mock.calls.at(-1)?.[0]).toContain('Meeting details')
})

it('uses one tap to toggle transcript without granting recording consent and safely expands cue text', () => {
  document.body.innerHTML = '<div id="app"></div>'
  const toggleTranscript = vi.fn(), configureLiveCues = vi.fn(), recordingConsent = vi.fn()
  const phone = new OpenAGIPhoneCompanion({ pair: vi.fn(), ask: vi.fn(), newConversation: vi.fn(), unlink: vi.fn(), connectAgent: vi.fn(), toggleTranscript, configureLiveCues, recordingConsent }, [])
  phone.paired(true)
  expect(document.querySelector<HTMLElement>('#cue-panel')!.hidden).toBe(false)
  phone.interfaceStyle('classic'); expect(document.querySelector<HTMLElement>('#cue-panel')!.hidden).toBe(false)
  phone.interfaceStyle('focused'); expect(document.querySelector<HTMLElement>('#cue-panel')!.hidden).toBe(false)
  document.querySelector<HTMLButtonElement>('#toggle-transcript')!.click(); expect(toggleTranscript).toHaveBeenCalledOnce(); expect(recordingConsent).not.toHaveBeenCalled()
  phone.cue({ id: 'cue', kind: 'answer', title: '<script>Question</script>', brief: 'Brief', detail: 'Expanded calendar details', at: 1 })
  expect(document.querySelector('#live-cues script')).toBeNull(); expect(document.querySelector('#live-cues details')!.textContent).toContain('Expanded calendar details')
  phone.paired(false); expect(document.querySelector('#live-cues')!.textContent).toBe('')
})
