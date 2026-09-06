import { QuestionAudioBuffer } from '../buildbetter/question-audio'

const PCM_BYTES_PER_SECOND = 16_000 * 2

export interface AmbientSegmenterOptions {
  threshold?: number
  preRollMs?: number
  endSilenceMs?: number
  minimumSpeechMs?: number
  maximumUtteranceMs?: number
}

export class AmbientAudioSegmenter {
  private readonly threshold: number
  private readonly preRollBytes: number
  private readonly endSilenceMs: number
  private readonly minimumSpeechMs: number
  private readonly maximumUtteranceMs: number
  private preRoll: Uint8Array[] = []
  private preRollSize = 0
  private utterance: Uint8Array[] | null = null
  private utteranceMs = 0
  private speechMs = 0
  private silenceMs = 0

  constructor(options: AmbientSegmenterOptions = {}) {
    this.threshold = options.threshold ?? 550
    this.preRollBytes = Math.round(PCM_BYTES_PER_SECOND * (options.preRollMs ?? 400) / 1_000)
    this.endSilenceMs = options.endSilenceMs ?? 800
    this.minimumSpeechMs = options.minimumSpeechMs ?? 250
    this.maximumUtteranceMs = options.maximumUtteranceMs ?? 15_000
  }

  push(pcm: Uint8Array): Blob | null {
    if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) return null
    const durationMs = pcm.byteLength / PCM_BYTES_PER_SECOND * 1_000
    const speech = pcmRms(pcm) >= this.threshold
    if (!this.utterance) {
      this.rememberPreRoll(pcm)
      if (!speech) return null
      this.utterance = this.preRoll.map(chunk => chunk.slice())
      this.utteranceMs = this.preRollSize / PCM_BYTES_PER_SECOND * 1_000
      this.speechMs = durationMs
      this.silenceMs = 0
      this.preRoll = []
      this.preRollSize = 0
      return null
    }

    this.utterance.push(pcm.slice())
    this.utteranceMs += durationMs
    if (speech) {
      this.speechMs += durationMs
      this.silenceMs = 0
    } else this.silenceMs += durationMs

    if (this.utteranceMs >= this.maximumUtteranceMs
        || (this.silenceMs >= this.endSilenceMs && this.speechMs >= this.minimumSpeechMs)) {
      return this.finish()
    }
    return null
  }

  reset(): void {
    this.preRoll = []
    this.preRollSize = 0
    this.utterance = null
    this.utteranceMs = 0
    this.speechMs = 0
    this.silenceMs = 0
  }

  private rememberPreRoll(pcm: Uint8Array): void {
    this.preRoll.push(pcm.slice())
    this.preRollSize += pcm.byteLength
    while (this.preRollSize > this.preRollBytes && this.preRoll.length > 1) {
      this.preRollSize -= this.preRoll.shift()?.byteLength ?? 0
    }
  }

  private finish(): Blob | null {
    const chunks = this.utterance
    const speechMs = this.speechMs
    this.reset()
    if (!chunks || speechMs < this.minimumSpeechMs) return null
    const audio = new QuestionAudioBuffer()
    for (const chunk of chunks) audio.push(chunk)
    return audio.toWav()
  }
}

function pcmRms(pcm: Uint8Array): number {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2)
  let energy = 0
  for (const sample of samples) energy += sample * sample
  return Math.sqrt(energy / samples.length)
}
