import { z } from 'zod'

const SpeechEvent = z.object({
  type: z.string(), is_final: z.boolean().optional(), speech_final: z.boolean().optional(),
  message: z.string().max(250).optional(),
  code: z.string().max(60).optional(),
  start: z.number().nonnegative().optional(), duration: z.number().nonnegative().optional(),
  channel: z.object({ alternatives: z.array(z.object({ transcript: z.string().max(8000).optional(), words: z.array(z.object({ word: z.string().max(100), punctuated_word: z.string().max(100).optional(), start: z.number().nonnegative(), end: z.number().nonnegative(), speaker: z.number().int().min(0).max(99).optional() })).max(2000).optional() })).max(10).optional() }).optional(),
})
export type SpeechModel = 'openai-buffered' | 'nova-3' | 'nova-2'
export interface SpeechCallbacks {
  segment?(text: string, metadata: { at: number; endAt: number; streamId: string; speaker: number | null }): void
  transcript(text: string, final: boolean, lagMs: number): void
  utterance(text: string): void
  error(error: Error): void
}
type SocketFactory = (url: string, protocols: string[]) => WebSocket

export class SpeechStreamError extends Error {
  constructor(message: string, readonly code: string, readonly recoverable = false) { super(message); this.name = 'SpeechStreamError' }
}

// Raw PCM streams through the paired main by default; direct Deepgram is optional.
// Only a G2-scoped credential or ephemeral voice token enters this object.
export class LiveSpeech {
  private socket: WebSocket | null = null
  private closed = false
  private ready = false
  private bytes = 0
  private queue: { pcm: Uint8Array; offset: number; at: number }[] = []
  private queuedBytes = 0
  private audioCredit = 640
  private creditAt = Date.now()
  private drainTimer: ReturnType<typeof setTimeout> | undefined
  private closeSent = false
  private stable = ''
  private full = ''
  private lastFinalEnd = -1
  private streamId = crypto.randomUUID()
  private streamAt = Date.now()
  private keepalive: ReturnType<typeof setInterval> | undefined
  private rejectOpen: ((error: Error) => void) | undefined
  private finishResolve: ((text: string) => void) | undefined
  private finishReject: ((error: Error) => void) | undefined
  private finishTimer: ReturnType<typeof setTimeout> | undefined
  constructor(private readonly callbacks: SpeechCallbacks, private readonly factory: SocketFactory = (url, protocols) => new WebSocket(url, protocols)) {}

  async open(token: string, model: Exclude<SpeechModel, 'openai-buffered'>, wakePhrase: string, relayUrl?: string): Promise<void> {
    if (this.closed) throw new Error('Speech start cancelled.')
    const params = new URLSearchParams({ model, encoding: 'linear16', sample_rate: '16000', channels: '1', language: 'en', interim_results: 'true', endpointing: '500', utterance_end_ms: '1000', vad_events: 'true', smart_format: 'true', mip_opt_out: 'true', diarize: 'true' })
    if (model === 'nova-3' && wakePhrase.trim()) params.set('keyterm', wakePhrase.trim().slice(0, 40))
    const ws = this.factory(relayUrl ?? `wss://api.deepgram.com/v1/listen?${params}`, [relayUrl ? 'openagi-g2-speech' : 'bearer', token])
    this.socket = ws
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.failure('Live speech did not connect. Check your main and Deepgram access, then retry.'), relayUrl ? 12_000 : 10_000)
      this.rejectOpen = error => { clearTimeout(timer); reject(error) }
      const markReady = (): void => {
        if (this.closed || this.ready) return
        clearTimeout(timer); this.rejectOpen = undefined; this.ready = true; this.creditAt = Date.now()
        this.keepalive = setInterval(() => { if (ws.readyState === 1 && !this.finishResolve) ws.send(JSON.stringify({ type: 'KeepAlive' })) }, 4000)
        resolve()
      }
      ws.onopen = () => { if (!relayUrl) markReady() }
      ws.onmessage = event => {
        if (this.closed) return
        if (relayUrl && !this.ready && typeof event.data === 'string' && event.data.length < 256) {
          try { if (SpeechEvent.parse(JSON.parse(event.data)).type === 'Ready') { markReady(); return } } catch { /* regular validation below */ }
        }
        this.receive(event.data)
      }
      ws.onerror = () => this.failure('Live speech connection failed. Check Deepgram access and your network. No audio was retried.', 'connection_failed')
      ws.onclose = event => {
        if (this.closed) return
        // CloseStream drains final results before closing. Other closes are failures.
        if (this.finishResolve && this.closeSent && event.code === 1000) {
          const resolveFinish = this.finishResolve; this.finishResolve = undefined; this.finishReject = undefined
          const text = this.full.trim(); this.close(); resolveFinish(text)
        } else this.failure('Live speech disconnected.', event.code === 1006 || event.code === 1011 ? 'stream_disconnected' : 'stream_closed')
      }
    })
  }

  push(pcm: Uint8Array): void {
    if (this.closed || this.finishResolve) return
    if (!this.ready || !this.socket || this.socket.readyState !== 1) { this.failure('Live speech is not connected. Please retry.'); return }
    if (!pcm.byteLength || pcm.byteLength % 2) { this.failure('Invalid PCM frame: expected non-empty 16-bit mono audio.', 'invalid_pcm'); return }
    if (this.queuedBytes + this.socket.bufferedAmount + pcm.byteLength > 64_000) { this.failure('Audio queue exceeded two seconds. Some audio was not transcribed.', 'audio_backlog'); return }
    if (this.bytes === 0 && !this.queue.length) this.streamAt = Date.now()
    this.queue.push({ pcm: pcm.slice(), offset: 0, at: Date.now() }); this.queuedBytes += pcm.byteLength
    this.drain()
  }

  private drain(): void {
    clearTimeout(this.drainTimer); this.drainTimer = undefined
    if (this.closed || !this.socket || this.socket.readyState !== 1) return
    const now = Date.now(), frame = this.queue[0]
    if (frame && now - frame.at >= 2000) { this.failure('Audio became stale in the two-second queue. Some audio was not transcribed.', 'audio_backlog'); return }
    // Never catch up by dumping a burst after the event loop or BLE stalls.
    this.audioCredit = Math.min(3200, this.audioCredit + Math.max(0, now - this.creditAt) * 32); this.creditAt = now
    while (this.queue.length && this.socket.bufferedAmount < 6400 && this.audioCredit >= 2) {
      const frame = this.queue[0]
      const length = Math.min(frame.pcm.length - frame.offset, Math.floor(this.audioCredit / 2) * 2, 640)
      if (length > 0) {
        try { this.socket.send(frame.pcm.subarray(frame.offset, frame.offset + length)) }
        catch { this.failure('Speech upload interrupted.', 'stream_disconnected'); return }
        frame.offset += length; this.audioCredit -= length; this.queuedBytes -= length; this.bytes += length
        if (frame.offset === frame.pcm.length) this.queue.shift()
      }
    }
    if (this.queue.length) this.drainTimer = setTimeout(() => this.drain(), 20)
    else if (this.finishResolve && !this.closeSent) {
      this.closeSent = true
      clearTimeout(this.finishTimer)
      this.finishTimer = setTimeout(() => this.failure('Speech finalization took too long. The question was not sent.'), 5000)
      try { this.socket.send(JSON.stringify({ type: 'CloseStream' })) }
      catch { this.failure('Speech finalization connection failed.', 'stream_disconnected') }
    }
  }

  finish(): Promise<string> {
    if (this.closed || !this.ready || !this.socket || this.finishResolve) return Promise.reject(new Error('Live speech is not ready to finish. Please retry.'))
    return new Promise((resolve, reject) => {
      this.finishResolve = resolve; this.finishReject = reject
      this.finishTimer = setTimeout(() => this.failure('Speech finalization took too long. Your transcript remains visible; the question was not sent.'), 7000)
      // Drain the bounded PCM queue in order before requesting final words.
      this.drain()
    })
  }

  close(reason = new Error('Speech cancelled.')): void {
    if (this.closed) return
    this.closed = true; this.ready = false
    clearInterval(this.keepalive); clearTimeout(this.finishTimer)
    clearTimeout(this.drainTimer); this.queue = []; this.queuedBytes = 0
    this.rejectOpen?.(reason); this.rejectOpen = undefined
    this.finishReject?.(reason); this.finishResolve = undefined; this.finishReject = undefined
    if (this.socket) {
      this.socket.onopen = null; this.socket.onmessage = null; this.socket.onclose = null; this.socket.onerror = null
      this.socket.close()
    }
  }

  private failure(message: string, code = 'speech_error'): void {
    if (this.closed) return
    const error = new SpeechStreamError(message, code, ['audio_backlog', 'audio_rate', 'upstream_backlog', 'stream_disconnected'].includes(code))
    this.close(error); this.callbacks.error(error)
  }
  private receive(data: unknown): void {
    if (typeof data !== 'string' || data.length > 128_000) return
    let event: z.infer<typeof SpeechEvent>
    try { event = SpeechEvent.parse(JSON.parse(data)) } catch { return }
    if (event.type === 'Error') {
      // Legacy mains used one error for rate and backlog failures. Retries remain bounded.
      const code = event.code ?? (event.message === 'Speech upload fell behind or exceeded real-time PCM limits. Listening paused.' ? 'audio_backlog' : 'speech_error')
      this.failure(event.message ?? 'Deepgram reported a speech error. Check your speech model and account configuration.', code); return
    }
    if (event.type === 'UtteranceEnd') { this.endUtterance(); return }
    if (event.type !== 'Results') return
    const text = event.channel?.alternatives?.[0]?.transcript?.trim() ?? ''
    const end = (event.start ?? 0) + (event.duration ?? 0)
    if (event.is_final && text && end > this.lastFinalEnd) {
      this.lastFinalEnd = end
      const words = event.channel?.alternatives?.[0]?.words
      if (words?.length) {
        let group = '', start = 0, stop = 0, speaker: number | null = null
        const emit = (): void => { if (group) this.callbacks.segment?.(group, { at: this.streamAt + start * 1000, endAt: this.streamAt + stop * 1000, streamId: this.streamId, speaker }) }
        for (const w of words) {
          if (w.end < w.start || w.end > end + 1) continue
          if (group && ((w.speaker ?? null) !== speaker || group.length > 800)) { emit(); group = '' }
          if (!group) { start = w.start; speaker = w.speaker ?? null }
          group = `${group} ${w.punctuated_word || w.word}`.trim(); stop = w.end
        }
        emit()
      } else this.callbacks.segment?.(text, { at: this.streamAt + (event.start ?? 0) * 1000, endAt: this.streamAt + end * 1000, streamId: this.streamId, speaker: null })
      this.stable = `${this.stable} ${text}`.trim().slice(-4000)
      this.full = `${this.full} ${text}`.trim().slice(-4000)
    }
    const preview = event.is_final ? this.stable : `${this.stable} ${text}`.trim().slice(-4000)
    if (preview) this.callbacks.transcript(preview, event.is_final === true, Math.max(0, Math.round((this.bytes / 32_000 - end) * 1000)))
    if (event.speech_final) this.endUtterance()
  }
  private endUtterance(): void {
    const text = this.stable.trim(); this.stable = ''
    if (text && !this.finishResolve) this.callbacks.utterance(text)
  }
}

export function speechTrigger(text: string, phrase: string, questions: boolean, armed: boolean): { prompt: string; armed: boolean } {
  const words = phrase.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
  const matcher = words.length ? new RegExp(`\\b${words.join('[^a-zA-Z0-9]*')}\\b[\\s,;:.!?—-]*`, 'i') : null
  const wake = matcher?.test(text) === true
  const isQuestion = /^(who|what|when|where|why|how|which|whose|can|could|would|should|will|is|are|am|was|were|do|does|did|may|might|tell me|show me|explain)\b/i.test(text.trim()) || text.trim().endsWith('?')
  const prompt = wake && matcher ? text.replace(matcher, '').trim() : text.trim()
  return { prompt: wake || armed || (questions && isQuestion) ? prompt : '', armed: wake && !prompt }
}
