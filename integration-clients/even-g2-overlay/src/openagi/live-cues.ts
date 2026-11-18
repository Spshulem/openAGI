export interface LiveCue { id: string; kind: 'answer' | 'context' | 'task'; title: string; brief: string; detail: string; at: number }

// A final utterance is a reference, never an instruction to execute. Retain
// only a small rolling context in memory and never replay it after a pause.
export class LiveCueContext {
  private parts: string[] = []
  private lastCheck = -Infinity
  add(text: string, now = Date.now()): string | null {
    if (!text.trim()) return null
    this.parts = [...this.parts, text.trim().slice(-1000)].slice(-3)
    if (now - this.lastCheck < 30_000) return null
    this.lastCheck = now
    return this.parts.join('\n').slice(-3000)
  }
  clear(): void { this.parts = []; this.lastCheck = -Infinity }
}
