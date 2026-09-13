export type AskState =
  | { kind: 'idle' }
  | { kind: 'capturing'; elapsedMs: number }
  | { kind: 'transcribing' }
  | { kind: 'answering'; question: string; answer: string; scope: string | null }
  | { kind: 'answered'; question: string; pages: string[]; page: number; scope: string | null }
  | { kind: 'error'; message: string }

export function paginateText(text: string, maxCharacters = 420): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return ['No answer was returned.']
  const pages: string[] = []
  let remaining = normalized
  while (remaining.length > maxCharacters) {
    const candidate = remaining.slice(0, maxCharacters + 1)
    const breakAt = Math.max(candidate.lastIndexOf(' '), maxCharacters > 40 ? maxCharacters - 40 : 1)
    const safeBreak = avoidSurrogateSplit(remaining, Math.min(breakAt, maxCharacters))
    pages.push(remaining.slice(0, safeBreak).trim())
    remaining = remaining.slice(safeBreak).trim()
  }
  if (remaining) pages.push(remaining)
  return pages
}

function avoidSurrogateSplit(text: string, index: number): number {
  const code = text.charCodeAt(index - 1)
  return code >= 0xd800 && code <= 0xdbff ? index - 1 : index
}
