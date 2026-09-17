import { z } from 'zod'
import { AgentOriginSchema } from './config'

const Card = z.object({ format: z.literal('openagi-g2'), version: z.literal(1), origin: AgentOriginSchema, code: z.string().regex(/^\d{6}$/), expiresAt: z.string().datetime() }).strict()
export function parseConnectionCard(text: string, now = Date.now()): z.infer<typeof Card> {
  if (text.length > 2048) throw new Error('Connection card is too long.')
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error('Paste the complete connection card from OpenAGI on your main computer.') }
  const result = Card.safeParse(parsed)
  if (!result.success) throw new Error('That is not a valid connection card. It should contain a main HTTPS URL and one pairing code, never an owner token.')
  const expiry = Date.parse(result.data.expiresAt)
  if (expiry <= now || expiry > now + 31 * 60_000) throw new Error('This card expired or the phone clock is incorrect. Create a new card on main.')
  return result.data
}
