import { z } from 'zod'
import { RESUME_ERROR_CODES, type ResumeErrorCode } from './resume'
import type { ParamsFor } from './index'

/**
 * A resume message stored in a text column (`senior_resumes.error_message`,
 * `senior_resumes.pdf_render_error`) — backlog 443. The column holds JSON
 * `{"code": ..., "params": {...}}` instead of display text, so the web renders
 * the catalog line in the viewer's locale. No DDL: both columns are plain text.
 *
 * Rows written before this change still hold Russian text; `decodeResumeMessage`
 * returns `null` for them and the web shows the text as it is.
 */
const storedResumeMessageSchema = z.object({
  code: z.enum(RESUME_ERROR_CODES),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
})
export type StoredResumeMessage = z.infer<typeof storedResumeMessageSchema>

export function encodeResumeMessage<C extends ResumeErrorCode>(
  code: C,
  ...args: [ParamsFor<C>] extends [never] ? [] : [params: ParamsFor<C>]
): string {
  return JSON.stringify(args[0] === undefined ? { code } : { code, params: args[0] })
}

/** The code and params of a stored message, or `null` for legacy free text. */
export function decodeResumeMessage(stored: string | null): StoredResumeMessage | null {
  if (stored === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(stored)
  } catch {
    return null
  }
  const parsed = storedResumeMessageSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}
