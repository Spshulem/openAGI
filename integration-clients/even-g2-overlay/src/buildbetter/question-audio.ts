import { AUDIO_BYTES_PER_SAMPLE, AUDIO_CHANNELS, AUDIO_SAMPLE_RATE_HZ } from './audio-frame'

const MAX_QUESTION_SECONDS = 30
const MAX_PCM_BYTES = AUDIO_SAMPLE_RATE_HZ * AUDIO_BYTES_PER_SAMPLE * AUDIO_CHANNELS * MAX_QUESTION_SECONDS

export class QuestionAudioBuffer {
  private readonly chunks: Uint8Array[] = []
  private byteLength = 0

  push(pcm: Uint8Array): void {
    if (pcm.byteLength % 2 !== 0) throw new Error('Question PCM has a partial sample')
    if (this.byteLength + pcm.byteLength > MAX_PCM_BYTES) throw new Error('Question reached the 30 second limit')
    this.chunks.push(pcm.slice())
    this.byteLength += pcm.byteLength
  }

  toWav(): Blob {
    const wav = new Uint8Array(44 + this.byteLength)
    const view = new DataView(wav.buffer)
    ascii(wav, 0, 'RIFF')
    view.setUint32(4, 36 + this.byteLength, true)
    ascii(wav, 8, 'WAVE')
    ascii(wav, 12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, AUDIO_CHANNELS, true)
    view.setUint32(24, AUDIO_SAMPLE_RATE_HZ, true)
    view.setUint32(28, AUDIO_SAMPLE_RATE_HZ * AUDIO_CHANNELS * AUDIO_BYTES_PER_SAMPLE, true)
    view.setUint16(32, AUDIO_CHANNELS * AUDIO_BYTES_PER_SAMPLE, true)
    view.setUint16(34, 16, true)
    ascii(wav, 36, 'data')
    view.setUint32(40, this.byteLength, true)
    let offset = 44
    for (const chunk of this.chunks) {
      wav.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new Blob([wav], { type: 'audio/wav' })
  }

  get durationSeconds(): number { return this.byteLength / (AUDIO_SAMPLE_RATE_HZ * AUDIO_CHANNELS * AUDIO_BYTES_PER_SAMPLE) }
}

function ascii(target: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) target[offset + index] = text.charCodeAt(index)
}
