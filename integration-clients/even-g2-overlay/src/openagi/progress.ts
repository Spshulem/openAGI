export function progressLabel(stage?: string): string {
  switch (stage) {
    case 'transcribing': return 'Transcribing speech'
    case 'transcribed': return 'Question understood'
    case 'routing': return 'Choosing agent'
    case 'accepted': return 'Question accepted'
    case 'tool': return 'Using a tool'
    case 'model': case 'thinking': return 'Thinking'
    default: return 'Processing question'
  }
}

export function progressDetail(started: number, lastEvent: number, streaming: boolean, now = Date.now()): string {
  const elapsed = Math.max(0, Math.floor((now - started) / 1000))
  const idle = Math.max(0, Math.floor((now - lastEvent) / 1000))
  const connection = !streaming ? 'Waiting for server data' : idle >= 25 ? `No server data for ${idle}s` : 'Stream alive (not task progress)'
  return `${elapsed}s elapsed · ${connection}`
}
