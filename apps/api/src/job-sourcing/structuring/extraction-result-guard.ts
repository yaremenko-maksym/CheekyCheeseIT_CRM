import { externalHttpsUrlSchema } from '@crm/shared'
import { z } from 'zod'

/** A model reply larger than this is refused unread (UTF-8 bytes). */
export const MAX_MODEL_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_RECORDS = 100
/**
 * A quote shorter than this (non-whitespace chars) proves nothing unless it is the whole field.
 * Any quote must also be about its field: it contains the value, or (text fields) is a passage of
 * it; a URL is quoted whole. Booleans, nulls and nulled URLs never have evidence.
 */
export const MIN_EVIDENCE_QUOTE_CHARS = 8

function nonWhitespaceLength(text: string): number {
  return text.replace(/\s/g, '').length
}

/** Case and whitespace runs do not change what a quote says. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

const URL_FIELDS: ReadonlySet<string> = new Set(['postingUrl', 'applyUrl'])

/** Absent and `null` both mean "not stated on the page". */
const fact = (max: number) => z.string().max(max).nullable().default(null)

const EVIDENCE_FIELDS = [
  'externalId',
  'title',
  'company',
  'location',
  'remote',
  'employmentType',
  'salary',
  'description',
  'postedAt',
  'postingUrl',
  'applyUrl',
] as const

/** URL fields are validated separately, per field, so a bad URL never costs the whole record. */
const recordSchema = z.object({
  externalId: fact(256),
  title: fact(500),
  company: fact(255),
  location: fact(500),
  remote: z.boolean().nullable().default(null),
  employmentType: fact(100),
  salary: fact(300),
  description: fact(20_000),
  postedAt: fact(64),
  postingUrl: z.unknown().optional(),
  applyUrl: z.unknown().optional(),
  evidence: z
    .array(z.object({ field: z.enum(EVIDENCE_FIELDS), quote: z.string().min(1).max(2_000) }))
    .max(100)
    .default([]),
  uncertainty: z.number().min(0).max(1),
})

const outputSchema = z.object({
  extractionVersion: z.string().min(1).max(64),
  records: z.array(z.unknown()).max(MAX_RECORDS),
})

export type ExtractionRecord = Omit<z.infer<typeof recordSchema>, 'postingUrl' | 'applyUrl'> & {
  postingUrl: string | null
  applyUrl: string | null
}

export interface ExtractionContext {
  /** The text the model was given (the fetched page as sent), the only source of evidence. */
  evidenceText: string
  /** URLs already verified as the posting's identity; a model may name them without quoting them. */
  verifiedUrls: readonly string[]
}

export type ExtractionGuardResult =
  | {
      ok: true
      extractionVersion: string
      records: ExtractionRecord[]
      droppedRecords: number
      nulledUrls: number
      droppedEvidence: number
    }
  | { ok: false; reason: 'OUTPUT_TOO_LARGE' | 'NOT_JSON' | 'SCHEMA_INVALID' | 'NO_VALID_RECORD' }

/** Every URL token in the evidence, trailing sentence punctuation removed — matched whole, never as a prefix. */
function evidenceUrls(evidenceText: string): Set<string> {
  const urls = new Set<string>()
  for (const [token] of evidenceText.matchAll(/https?:\/\/[^\s<>"'()[\]]+/gi)) {
    urls.add(token.replace(/[.,;:!?]+$/, ''))
  }
  return urls
}

/**
 * Validates a model reply locally (provider-side schema enforcement is not trusted). The raw text
 * must be the JSON object itself: a fenced block is a failure, there is no fence-stripping fallback.
 */
export function guardExtractionResult(raw: string, ctx: ExtractionContext): ExtractionGuardResult {
  // byteLength defaults to UTF-8.
  if (Buffer.byteLength(raw) > MAX_MODEL_OUTPUT_BYTES) {
    return { ok: false, reason: 'OUTPUT_TOO_LARGE' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'NOT_JSON' }
  }
  const output = outputSchema.safeParse(parsed)
  if (!output.success) return { ok: false, reason: 'SCHEMA_INVALID' }

  const known = evidenceUrls(ctx.evidenceText)
  const checkUrl = (value: unknown): string | null => {
    const url = externalHttpsUrlSchema.safeParse(value)
    return url.success && (known.has(url.data) || ctx.verifiedUrls.includes(url.data))
      ? url.data
      : null
  }

  const records: ExtractionRecord[] = []
  let droppedRecords = 0
  let nulledUrls = 0
  let droppedEvidence = 0
  for (const candidate of output.data.records) {
    const record = recordSchema.safeParse(candidate)
    if (!record.success) {
      droppedRecords += 1
      continue
    }
    const { postingUrl, applyUrl, evidence, ...facts } = record.data
    const urls = { postingUrl: checkUrl(postingUrl), applyUrl: checkUrl(applyUrl) }
    nulledUrls += Number(urls.postingUrl === null && postingUrl != null)
    nulledUrls += Number(urls.applyUrl === null && applyUrl != null)
    const fields = { ...facts, ...urls }
    const quoted = evidence.filter((span) => {
      const value = fields[span.field]
      // Only a stated string can be proved: a boolean, a null or a nulled URL never has evidence.
      if (typeof value !== 'string') return false
      const quote = normalise(span.quote)
      const stated = normalise(value)
      if (stated === '') return false
      // The quote names the value; a text field may also be proved by a passage of it (a long
      // description cannot be quoted whole). A URL must be quoted whole.
      const related =
        quote.includes(stated) || (!URL_FIELDS.has(span.field) && stated.includes(quote))
      // Long enough to be specific, or exactly the value.
      const specific =
        nonWhitespaceLength(span.quote) >= MIN_EVIDENCE_QUOTE_CHARS || quote === stated
      return related && specific && ctx.evidenceText.includes(span.quote)
    })
    droppedEvidence += evidence.length - quoted.length
    records.push({ ...fields, evidence: quoted })
  }

  if (records.length === 0 && droppedRecords > 0) return { ok: false, reason: 'NO_VALID_RECORD' }
  return {
    ok: true,
    extractionVersion: output.data.extractionVersion,
    records,
    droppedRecords,
    nulledUrls,
    droppedEvidence,
  }
}
