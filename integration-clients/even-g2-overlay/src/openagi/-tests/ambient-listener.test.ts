import { describe, expect, it } from 'vitest'
import { AmbientAudioSegmenter } from '../ambient-listener'

function frame(amplitude: number): Uint8Array {
  const samples = new Int16Array(1_600)
  samples.fill(amplitude)
  return new Uint8Array(samples.buffer)
}

describe('AmbientAudioSegmenter', () => {
  it('ignores silence and emits one bounded WAV after speech followed by silence', () => {
    const segmenter = new AmbientAudioSegmenter({ threshold: 500 })
    for (let index = 0; index < 6; index += 1) expect(segmenter.push(frame(0))).toBeNull()
    for (let index = 0; index < 4; index += 1) expect(segmenter.push(frame(2_000))).toBeNull()
    let utterance: Blob | null = null
    for (let index = 0; index < 8; index += 1) utterance = segmenter.push(frame(0)) ?? utterance
    expect(utterance).not.toBeNull()
    expect(utterance?.type).toBe('audio/wav')
    expect(utterance?.size).toBeGreaterThan(44 + 4 * 3_200)
  })

  it('cuts off a continuous utterance at the configured maximum', () => {
    const segmenter = new AmbientAudioSegmenter({ threshold: 500, preRollMs: 0, maximumUtteranceMs: 500 })
    let utterance: Blob | null = null
    for (let index = 0; index < 6; index += 1) utterance = segmenter.push(frame(2_000)) ?? utterance
    expect(utterance).not.toBeNull()
  })
})
