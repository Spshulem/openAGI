export const AUDIO_FRAME_MAGIC = new Uint8Array([0x42, 0x42, 0x47, 0x32])
export const AUDIO_FRAME_HEADER_BYTES = 24
export const AUDIO_PROTOCOL_VERSION = 1
export const AUDIO_SAMPLE_RATE_HZ = 16_000
export const AUDIO_CHANNELS = 1
export const AUDIO_BYTES_PER_SAMPLE = 2
export const AUDIO_TARGET_SAMPLES = 1_600
export const AUDIO_MAX_SAMPLES = 8_000

export interface DecodedAudioFrame {
  sequence: bigint
  sampleCount: number
  pcm: Uint8Array
}

export class AudioFrameError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'AudioFrameError'
  }
}

export function encodeAudioFrame(sequence: bigint, pcm: Uint8Array): Uint8Array {
  if (sequence < 0n) throw new AudioFrameError('invalid_sequence', 'Sequence must be non-negative')
  if (pcm.byteLength === 0 || pcm.byteLength % AUDIO_BYTES_PER_SAMPLE !== 0) {
    throw new AudioFrameError('invalid_pcm_length', 'PCM must contain complete signed 16-bit samples')
  }
  const sampleCount = pcm.byteLength / AUDIO_BYTES_PER_SAMPLE
  if (sampleCount > AUDIO_MAX_SAMPLES) {
    throw new AudioFrameError('frame_too_large', `Audio frame contains ${sampleCount} samples`)
  }

  const frame = new Uint8Array(AUDIO_FRAME_HEADER_BYTES + pcm.byteLength)
  frame.set(AUDIO_FRAME_MAGIC, 0)
  const view = new DataView(frame.buffer)
  view.setUint8(4, AUDIO_PROTOCOL_VERSION)
  view.setUint8(5, 0)
  view.setUint16(6, AUDIO_FRAME_HEADER_BYTES, false)
  view.setBigUint64(8, sequence, false)
  view.setUint32(16, sampleCount, false)
  view.setUint32(20, pcm.byteLength, false)
  frame.set(pcm, AUDIO_FRAME_HEADER_BYTES)
  return frame
}

export function decodeAudioFrame(input: ArrayBuffer | Uint8Array): DecodedAudioFrame {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.byteLength < AUDIO_FRAME_HEADER_BYTES) {
    throw new AudioFrameError('truncated_header', 'Audio frame header is truncated')
  }
  for (let index = 0; index < AUDIO_FRAME_MAGIC.length; index += 1) {
    if (bytes[index] !== AUDIO_FRAME_MAGIC[index]) throw new AudioFrameError('invalid_magic', 'Invalid audio frame magic')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint8(4) !== AUDIO_PROTOCOL_VERSION) throw new AudioFrameError('unsupported_version', 'Unsupported audio protocol')
  if (view.getUint8(5) !== 0) throw new AudioFrameError('unsupported_flags', 'Audio frame flags must be zero')
  if (view.getUint16(6, false) !== AUDIO_FRAME_HEADER_BYTES) throw new AudioFrameError('invalid_header_length', 'Invalid header length')

  const sequence = view.getBigUint64(8, false)
  const sampleCount = view.getUint32(16, false)
  const payloadBytes = view.getUint32(20, false)
  if (sampleCount === 0 || sampleCount > AUDIO_MAX_SAMPLES) throw new AudioFrameError('invalid_sample_count', 'Invalid sample count')
  if (payloadBytes !== sampleCount * AUDIO_CHANNELS * AUDIO_BYTES_PER_SAMPLE) {
    throw new AudioFrameError('sample_length_mismatch', 'Sample count does not match PCM bytes')
  }
  if (bytes.byteLength !== AUDIO_FRAME_HEADER_BYTES + payloadBytes) {
    throw new AudioFrameError('payload_length_mismatch', 'PCM payload is truncated or has trailing bytes')
  }
  return {
    sequence,
    sampleCount,
    pcm: bytes.slice(AUDIO_FRAME_HEADER_BYTES),
  }
}

export class PcmFrameCoalescer {
  private pending = new Uint8Array(0)

  constructor(private readonly targetBytes = AUDIO_TARGET_SAMPLES * AUDIO_BYTES_PER_SAMPLE) {
    if (targetBytes <= 0 || targetBytes % AUDIO_BYTES_PER_SAMPLE !== 0) throw new Error('targetBytes must contain full samples')
  }

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength % AUDIO_BYTES_PER_SAMPLE !== 0) throw new AudioFrameError('invalid_pcm_length', 'PCM chunk has a partial sample')
    if (chunk.byteLength === 0) return []
    const joined = new Uint8Array(this.pending.byteLength + chunk.byteLength)
    joined.set(this.pending)
    joined.set(chunk, this.pending.byteLength)
    const frames: Uint8Array[] = []
    let offset = 0
    while (joined.byteLength - offset >= this.targetBytes) {
      frames.push(joined.slice(offset, offset + this.targetBytes))
      offset += this.targetBytes
    }
    this.pending = joined.slice(offset)
    return frames
  }

  flush(): Uint8Array | null {
    if (!this.pending.byteLength) return null
    const result = this.pending
    this.pending = new Uint8Array(0)
    return result
  }

  get pendingBytes(): number {
    return this.pending.byteLength
  }
}
