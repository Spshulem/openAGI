import { z } from 'zod'

export const AgentOriginSchema = z.string().trim().url().refine(value => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
}, { message: 'Enter your main server HTTPS origin, without a path or credentials.' }).transform(value => new URL(value).origin)

const OpenAGIConfigSchema = z.object({
  origin: z.union([z.literal(''), AgentOriginSchema]),
  allowedOrigins: z.array(AgentOriginSchema).max(16),
})

export type OpenAGIConfig = z.infer<typeof OpenAGIConfigSchema>

export function loadOpenAGIConfig(env: Record<string, string | boolean | undefined> = import.meta.env): OpenAGIConfig {
  const rawOrigin = String(env.VITE_AGENT_DEFAULT_ORIGIN ?? env.VITE_OPENAGI_ORIGIN ?? '')
  const configured = String(env.VITE_AGENT_ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean)
  const origin = rawOrigin ? AgentOriginSchema.parse(rawOrigin) : ''
  const allowedOrigins = [...new Set([rawOrigin, ...configured].filter(Boolean).map(value => AgentOriginSchema.parse(value)))]
  return OpenAGIConfigSchema.parse({ origin, allowedOrigins })
}

export class OpenAGIApiError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message)
    this.name = 'OpenAGIApiError'
  }
}

export function safeOpenAGIError(error: unknown): string {
  if (error instanceof OpenAGIApiError) return error.message
  return error instanceof Error ? error.message : 'The agent could not complete the request.'
}
