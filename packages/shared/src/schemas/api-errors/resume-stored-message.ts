import { z } from 'zod'
import { RESUME_ERROR_CODES, RESUME_ERROR_PARAMS, type ResumeErrorCode } from './resume'
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
  // JSON.stringify drops an undefined `params`, so a code without params stays `{"code":...}`.
  return JSON.stringify({ code, params: args[0] })
}

/** Our JSON shape at its loosest: an object with a string `code`. Anything else is legacy text. */
const storedShapeSchema = z.object({ code: z.string() })

/** A code whose catalog line needs no params, so it can stand in for any message of its area. */
export type ResumeFallbackCode = {
  [C in ResumeErrorCode]: (typeof RESUME_ERROR_PARAMS)[C] extends readonly [] ? C : never
}[ResumeErrorCode]

/**
 * The code and params of a stored message, or `null` for legacy free text.
 *
 * A value in our shape that this build cannot render — an unknown code, or a known code missing a
 * param its line interpolates — decodes to `fallback`, the area's generic line, instead of raw JSON
 * or a line with a gap (QA-LOW-2, QA-LOW-3).
 */
export function decodeResumeMessage(
  stored: string | null,
  fallback: ResumeFallbackCode,
): StoredResumeMessage | null {
  let json: unknown
  try {
    // String(null) is "null", which parses to null and fails the shape.
    json = JSON.parse(String(stored))
  } catch {
    // Not JSON: `json` stays undefined, which fails the shape check below (legacy text).
  }
  if (!storedShapeSchema.safeParse(json).success) return null
  const parsed = storedResumeMessageSchema.safeParse(json)
  if (!parsed.success) return { code: fallback }
  const { code, params } = parsed.data
  return RESUME_ERROR_PARAMS[code].every((name) => params?.[name] !== undefined)
    ? parsed.data
    : { code: fallback }
}
