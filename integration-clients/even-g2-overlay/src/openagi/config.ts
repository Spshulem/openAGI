import { z } from 'zod'

const OpenAGIConfigSchema = z.object({
  origin: z.string().url().transform(value => value.replace(/\/$/, '')).refine(
    value => value.startsWith('https://') || value.startsWith('http://localhost') || value.startsWith('http://127.0.0.1'),
    { message: 'OpenAGI must use HTTPS outside localhost' },
  ),
})

export type OpenAGIConfig = z.infer<typeof OpenAGIConfigSchema>

export function loadOpenAGIConfig(env: Record<string, string | boolean | undefined> = import.meta.env): OpenAGIConfig {
  return OpenAGIConfigSchema.parse({ origin: env.VITE_OPENAGI_ORIGIN })
}

export class OpenAGIApiError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message)
    this.name = 'OpenAGIApiError'
  }
}

export function safeOpenAGIError(error: unknown): string {
  if (error instanceof OpenAGIApiError) return error.message
  return error instanceof Error ? error.message : 'OpenAGI could not complete the request.'
}
