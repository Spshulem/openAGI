import type { AudioSource } from '../even/audio-source'
import type { InboxItem } from './proactive'

export interface VoiceFocus { view: 'supervisor'; cardId?: string; questionId?: string; threadKey?: string; prRef?: string }
export function supervisorVoiceFocus(item?: Pick<InboxItem, 'id' | 'supervisor' | 'cardId' | 'questionId' | 'threadKey' | 'prRef'> | null): VoiceFocus {
  if (!item?.supervisor) return { view: 'supervisor' }
  return {
    view: 'supervisor',
    ...(item.cardId ? { cardId: item.cardId } : {}),
    ...(item.questionId ? { questionId: item.questionId } : {}),
    ...(item.threadKey ? { threadKey: item.threadKey } : {}),
    ...(item.prRef ? { prRef: item.prRef } : {}),
  }
}

export type VoiceState = 'idle' | 'connecting' | 'listening' | 'waiting' | 'replying'
export interface VoiceCallbacks {
  state(state: VoiceState): void
  reply(text: string, final: boolean): void
  transcript(text: string): void
  notice(text: string): void
  error(error: Error): void
}
export type VoiceSocket = Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send' | 'close' | 'onopen' | 'onmessage' | 'onerror' | 'onclose'>

// The microphone opens only after the authenticated hub session is ready.
export class G2VoiceSession {
  private socket: VoiceSocket | null = null
  private ready = false
  private pressed = false
  private opening = false
  private stopping = false
  private pendingPress: { relay: { url: string; token: string }; focus: VoiceFocus; released: boolean } | null = null
  private discardReply = false
  private released = false
  private focus: VoiceFocus = { view: 'supervisor' }
  private text = ''
  private currentState: VoiceState = 'idle'
  private timer: ReturnType<typeof setTimeout> | undefined
  private captureTimer: ReturnType<typeof setTimeout> | undefined
  private bytes = 0
  get state(): VoiceState { return this.currentState }
  constructor(private readonly audio: AudioSource, private readonly callbacks: VoiceCallbacks,
    private readonly socketFactory: (url: string, protocols: string[]) => VoiceSocket = (url, protocols) => new WebSocket(url, protocols)) {}

  press(relay: { url: string; token: string }, focus: VoiceFocus): void {
    if (this.stopping) {
      this.pendingPress ??= { relay, focus, released: false }
      this.setState('connecting')
      return
    }
    if (this.pressed || this.opening) return
    if (this.state === 'replying') this.discardReply = true
    clearTimeout(this.timer)
    this.pressed = true; this.released = false; this.focus = focus; this.text = ''; this.bytes = 0
    if (this.socket && this.ready) {
      if (this.state === 'waiting' || this.state === 'replying') this.send({ type: 'barge' })
      this.send({ type: 'context', focus })
      this.setState('connecting')
      void this.openMicrophone(this.socket)
      return
    }
    this.setState('connecting')
    let socket: VoiceSocket
    try { socket = this.socketFactory(relay.url, ['openagi-voice', relay.token]) }
    catch { this.fail('Could not open voice. Check your main connection.'); return }
    this.socket = socket
    socket.onopen = () => { if (this.socket === socket) this.send({ type: 'start', gesture: 'tap', mode: 'ptt', focus: this.focus }) }
    socket.onmessage = event => { if (this.socket === socket) this.receive(event.data) }
    socket.onerror = () => { if (this.socket === socket) this.fail('Voice connection failed. Check that voice is enabled on your main and the G2 is paired.') }
    socket.onclose = () => { if (this.socket === socket) this.fail('Voice disconnected. Tap to start again.') }
    this.timer = setTimeout(() => this.fail('Voice did not become ready. Check the hub voice configuration.'), 15_000)
  }

  release(): void {
    if (this.pendingPress) { this.pendingPress.released = true; return }
    if (!this.pressed || this.released) return
    this.released = true
    if (!this.ready || this.opening) return
    void this.commit()
  }

  private async openMicrophone(socket: VoiceSocket): Promise<void> {
    this.opening = true
    try {
      await this.audio.start(pcm => {
        if (this.socket !== socket || !this.pressed || this.released) return
        if (!pcm.length || pcm.length % 2) { this.fail('Invalid microphone audio. Start again.'); return }
        if (socket.bufferedAmount + pcm.length > 256_000) { this.fail('Voice upload fell behind. Start again.'); return }
        const chunk = pcm.subarray(0, Math.max(0, 960_000 - this.bytes))
        for (let offset = 0; offset < chunk.length; offset += 32_000) socket.send(chunk.slice(offset, offset + 32_000).buffer)
        this.bytes += chunk.length
        if (this.bytes >= 960_000) { this.callbacks.notice('30-second limit: sending what you said.'); this.release() }
      })
      if (this.socket !== socket) return
      this.opening = false
      this.setState('listening')
      this.captureTimer = setTimeout(() => { this.callbacks.notice('30-second limit: sending what you said.'); this.release() }, 30_000)
      if (this.released) void this.commit()
    } catch { if (this.socket === socket) this.fail('Could not open the glasses microphone. Check its connection and permission.') }
    finally { if (this.socket === socket) this.opening = false }
  }

  private async commit(): Promise<void> {
    this.pressed = false
    this.stopping = true
    clearTimeout(this.captureTimer)
    const socket = this.socket
    this.setState('waiting')
    try { await this.audio.stop() }
    catch { if (this.socket === socket) this.fail('Could not stop the glasses microphone.'); return }
    finally { if (this.socket === socket) this.stopping = false }
    if (this.socket !== socket) return
    this.send({ type: 'commit' }); this.armIdle()
    const pending = this.pendingPress; this.pendingPress = null
    if (pending) {
      this.setState('waiting')
      this.press(pending.relay, pending.focus)
      if (pending.released) this.release()
    }
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return
    let event: { type?: string; text?: string; message?: string; code?: string }
    try { event = JSON.parse(data) as typeof event } catch { return }
    if (!event || typeof event !== 'object') return
    if (event.type === 'ready' && !this.ready) {
      clearTimeout(this.timer); this.ready = true
      this.send({ type: 'context', focus: this.focus })
      if (this.socket) void this.openMicrophone(this.socket)
    } else if (event.type === 'reply.delta' || event.type === 'reply.done') {
      // A cancelled partial reply can finish after the next recording sends.
      if (this.discardReply) {
        if (event.type === 'reply.done') this.discardReply = false
        return
      }
      if (this.pressed || this.opening) {
        if (event.type === 'reply.delta') this.discardReply = true
        return
      }
      if (typeof event.text !== 'string') return
      const final = event.type === 'reply.done'
      this.text = final ? event.text.slice(0, 4000) : (this.text + event.text).slice(0, 4000)
      this.setState(final ? 'idle' : 'replying')
      this.callbacks.reply(this.text, final); this.armIdle()
    } else if (event.type === 'transcript' && typeof event.text === 'string') this.callbacks.transcript(event.text)
    else if (event.type === 'notice' && typeof event.message === 'string') {
      if (!this.pressed) this.setState('idle')
      this.callbacks.notice(event.message); this.armIdle()
    } else if (event.type === 'error') this.fail('The voice model reported an error. Check your main configuration and try again.')
    else if (event.type === 'end') {
      if (event.code === 'idle' || event.code === 'stopped') this.close()
      else this.fail(event.code === 'voice_cap' ? 'Voice reached the hub spending cap. Check the cap on main.' : 'Voice ended on the hub. Tap to start again.')
    }
  }
  private setState(state: VoiceState): void { this.currentState = state; this.callbacks.state(state) }
  private send(frame: object): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(frame))
  }
  private armIdle(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      if (this.state === 'waiting' || this.state === 'replying') this.fail('Voice reply timed out. Tap to start again.')
      else this.close()
    }, 120_000)
  }
  private fail(message: string): void { this.close(); this.callbacks.error(new Error(message)) }
  close(): void {
    clearTimeout(this.timer); clearTimeout(this.captureTimer)
    const socket = this.socket; this.socket = null; this.ready = false; this.pressed = false; this.released = false
    if (socket) { socket.onopen = null; socket.onmessage = null; socket.onclose = null; socket.onerror = null; socket.close() }
    if (this.audio.active || this.opening) void this.audio.stop().catch(() => undefined)
    this.opening = false; this.stopping = false; this.pendingPress = null; this.discardReply = false
    this.setState('idle')
  }
}
