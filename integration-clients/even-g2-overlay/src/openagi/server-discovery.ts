import { AgentOriginSchema } from './config'

export function normalizeServerAddress(value: string): string {
  const origin = AgentOriginSchema.parse(value.includes('://') ? value.trim() : `https://${value.trim()}`)
  const host = new URL(origin).hostname
  if (['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(host) || host.endsWith('.localhost')) throw new Error('That address points to this phone. Use your computer’s HTTPS or Tailscale address.')
  return origin
}

export async function checkServers(addresses: string[], fetchImpl: typeof fetch = fetch): Promise<{ origin: string; name: string }[]> {
  const candidates = [...new Set(addresses.filter(Boolean).map(normalizeServerAddress))].slice(0, 8)
  const results = await Promise.allSettled(candidates.map(async origin => {
    const response = await fetchImpl(`${origin}/health?client=g2`, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(4000) })
    const data = await response.json() as Record<string, unknown>
    if (!response.ok || data.service !== 'openagi' || data.role !== 'main') throw new Error('Not an OpenAGI main')
    return { origin, name: new URL(origin).hostname }
  }))
  return results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
}
