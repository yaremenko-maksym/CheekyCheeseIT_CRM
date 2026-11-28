import { z } from 'zod'
import { DESCRIPTION_MD_MAX, externalHttpsUrlSchema } from './job-sourcing'

/**
 * The payload the bookmarklet (or the parse route) hands to the "register external submission"
 * dialog through `#external=<base64url JSON>`. It comes from an untrusted page, so this schema is
 * forgiving by design: an over-length field is cut, a bad link or a null / non-string text field is
 * dropped, an unknown key is stripped. Nothing here rejects the whole payload except a wrong
 * version, recognition or status, and then the dialog simply opens empty.
 */

/** How sure the extractor is about one field: read from the page, inferred, or not found. */
export const externalFieldStatusSchema = z.enum(['found', 'guessed', 'missing'])
export type ExternalFieldStatus = z.infer<typeof externalFieldStatusSchema>

/** Upper bound for the raw page text carried for a later parse (the hash has a transport cap). */
export const EXTERNAL_PAGE_TEXT_MAX = 15000

/** Transport cap for the encoded block map and full payload carried in the fragment. */
export const EXTERNAL_PREFILL_HASH_MAX = 32000

/** Trimmed text cut to `n` characters; a null or non-string value is dropped, never rejected. */
const capped = (n: number) =>
  z
    .string()
    .trim()
    .transform((v) => v.slice(0, n))
    .optional()
    .catch(undefined)

export const externalVacancyPrefillSchema = z
  .object({
    v: z.literal(1),
    recognition: z.enum(['recognized', 'partial', 'none']),
    url: externalHttpsUrlSchema.optional().catch(undefined),
    title: capped(500),
    company: capped(255),
    description: capped(DESCRIPTION_MD_MAX),
    pageText: capped(EXTERNAL_PAGE_TEXT_MAX),
    b: z.string().max(EXTERNAL_PREFILL_HASH_MAX).optional().catch(undefined),
    status: z.object({
      url: externalFieldStatusSchema,
      title: externalFieldStatusSchema,
      company: externalFieldStatusSchema,
      description: externalFieldStatusSchema,
    }),
  })
  // A link the schema dropped is a link the dialog must ask for.
  .transform((p) =>
    p.url === undefined ? { ...p, status: { ...p.status, url: 'missing' as const } } : p,
  )

export type ExternalVacancyPrefill = z.infer<typeof externalVacancyPrefillSchema>
