import { afterEach, expect, it, vi } from 'vitest'
import { LiveSpeech, speechTrigger } from '../live-speech'
import { OpenAGIGlassesRenderer } from '../../ui/openagi-glasses-renderer'

function fixture() {
  const socket = { bufferedAmount: 0, readyState: 1, send: vi.fn(), close: vi.fn(), onopen: null as null | (() => void), onmessage: null as null | ((event: { data: string }) => void), onclose: null as null | ((event: { code: number }) => void), onerror: null as null | (() => void) }
  const callbacks = { transcript: vi.fn(), utterance: vi.fn(), error: vi.fn() }
  const factory = vi.fn<(url: string, protocols: string[]) => WebSocket>(() => socket as unknown as WebSocket)
  const speech = new LiveSpeech(callbacks, factory)
  const emit = (event: object) => socket.onmessage?.({ data: JSON.stringify(event) })
  const result = (transcript: string, is_final: boolean, start = 0, speech_final = false) => emit({ type: 'Results', is_final, speech_final, start, duration: 1, channel: { alternatives: [{ transcript }] } })
  return { speech, socket, callbacks, factory, emit, result, open: async () => { const pending = speech.open('ephemeral-token', 'nova-3', 'Peri'); socket.onopen?.(); await pending } }
}
afterEach(() => { vi.useRealTimers() })

it('waits for relay Ready before opening the microphone and never puts credentials in the URL', async () => {
  const { speech, socket, factory, emit } = fixture()
  let ready = false
  const opened = speech.open('scoped-node-token', 'nova-3', 'Peri', 'wss://main.example.com/nodes/g2/speech?model=nova-3').then(() => { ready = true })
  socket.onopen?.(); await Promise.resolve(); expect(ready).toBe(false)
  expect(factory).toHaveBeenCalledWith('wss://main.example.com/nodes/g2/speech?model=nova-3', ['openagi-g2-speech', 'scoped-node-token'])
  emit({ type: 'Ready', transport: 'relay' }); await opened
  speech.push(new Uint8Array(640)); expect(socket.send).toHaveBeenCalledOnce()
  speech.close()
})

it('does not send KeepAlive after CloseStream while awaiting final words', async () => {
  vi.useFakeTimers()
  const { speech, socket, open, result } = fixture(); await open(); result('Hello', true)
  const finished = speech.finish(); await vi.advanceTimersByTimeAsync(4000)
  expect(socket.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: 'CloseStream' }))
  socket.onclose?.({ code: 1000 }); expect(await finished).toBe('Hello')
})

it('sends raw PCM immediately to the fixed Deepgram origin with an ephemeral bearer protocol', async () => {
  const { speech, open, socket, factory } = fixture(); await open()
  const pcm = new Uint8Array(640); speech.push(pcm)
  expect(socket.send).toHaveBeenCalledWith(pcm)
  expect(factory).toHaveBeenCalledWith(expect.stringMatching(/^wss:\/\/api.deepgram.com\/v1\/listen\?/), ['bearer', 'ephemeral-token'])
  expect(factory.mock.calls[0]?.[0]).toContain('keyterm=Peri')
  speech.close()
})

it('revises interim words without triggering and emits each complete utterance once', async () => {
  const { speech, open, callbacks, result, emit } = fixture(); await open()
  result('Perry', false); result('Peri', false)
  expect(callbacks.utterance).not.toHaveBeenCalled()
  result('Peri', true); result('what time', false, 1)
  expect(callbacks.transcript).toHaveBeenLastCalledWith('Peri what time', false, 0)
  result('what time is it?', true, 1, true)
  emit({ type: 'UtteranceEnd' }); result('what time is it?', true, 1, true)
  expect(callbacks.utterance).toHaveBeenCalledExactlyOnceWith('Peri what time is it?')
  speech.close()
})

it('flushes the last words before returning a push-to-talk transcript', async () => {
  const { speech, open, socket, result, callbacks } = fixture(); await open()
  result('What', true)
  const finished = speech.finish()
  expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'CloseStream' }))
  result('time is it?', true, 1, true)
  socket.onclose?.({ code: 1000 })
  expect(await finished).toBe('What time is it?')
  expect(callbacks.utterance).not.toHaveBeenCalled()
  expect(socket.close).toHaveBeenCalledOnce()
})

it('fails boundedly on upload backlog, disconnect and finalization timeout', async () => {
  vi.useFakeTimers()
  const slow = fixture(); await slow.open(); slow.socket.bufferedAmount = 64000; slow.speech.push(new Uint8Array(640))
  expect(slow.callbacks.error).toHaveBeenCalledOnce(); expect(slow.socket.send).not.toHaveBeenCalled()
  const lost = fixture(); await lost.open(); lost.socket.onclose?.({ code: 1006 }); expect(lost.callbacks.error).toHaveBeenCalledOnce()
  const stuck = fixture(); await stuck.open(); const finished = expect(stuck.speech.finish()).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(5000); await finished
  expect(stuck.callbacks.error).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('cleans opening and keepalive timers on cancellation', async () => {
  vi.useFakeTimers()
  const cancelled = fixture(); const pending = expect(cancelled.speech.open('token', 'nova-2', '')).rejects.toThrow('cancelled')
  cancelled.speech.close(); await pending
  const connected = fixture(); await connected.open(); await vi.advanceTimersByTimeAsync(4000)
  expect(connected.socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'KeepAlive' }))
  connected.speech.close(); expect(vi.getTimerCount()).toBe(0)
})

it('matches wake word boundaries and supports an armed follow-up without triggering incidental speech', () => {
  expect(speechTrigger('Peri', 'Peri', false, false)).toEqual({ prompt: '', armed: true })
  expect(speechTrigger('Peri, what time is it?', 'Peri', false, false).prompt).toBe('what time is it?')
  expect(speechTrigger('The perimeter is clear', 'Peri', false, false).prompt).toBe('')
  expect(speechTrigger('Remind me tomorrow', 'Peri', false, true).prompt).toBe('Remind me tomorrow')
  expect(speechTrigger('How are you?', 'Peri', true, false).prompt).toBe('How are you?')
})

it('keeps streaming display updates blank and restores the latest page on wake', () => {
  const surface = { show: vi.fn(), initialize: vi.fn() }; const renderer = new OpenAGIGlassesRenderer(surface)
  renderer.home(); renderer.sleep(true); renderer.progress('Thinking', 'Active')
  expect(surface.show).toHaveBeenLastCalledWith(' ', false)
  renderer.answer('Newest answer', 0, 1); renderer.sleep(false)
  expect(surface.show).toHaveBeenLastCalledWith(expect.stringContaining('Newest answer'), true)
})
