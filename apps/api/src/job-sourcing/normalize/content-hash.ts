import { createHash } from 'node:crypto'
import type { ObservedDate } from './date-policy'
import { canonicalParams, encodeIdentityTuple } from './identity-key'

/**
 * Bump when the canonical payload changes. It is part of the hashed payload, so a layout change
 * shows up as a deliberate one-time churn instead of silently comparing different shapes.
 */
export const CONTENT_HASH_VERSION = 'ch1'

/**
 * The ONLY inputs to the hash — an allowlist, not "everything minus exclusions". Fetch timestamps,
 * request ids, raw date strings and identity fields are not on it, so they cannot leak in later by
 * somebody adding a field to an observation.
 */
export interface HashableFields {
  title: string
  companyName: string
  location: string | null
  descriptionMd: string
  remote: boolean | null
  employmentType: string | null
  seniorityHint: string | null
  tags: string[]
  applicationUrl: string | null
  dates: ObservedDate[]
}

const TRACKING_PARAM =
  /^(?:utm_.*|gclid|dclid|fbclid|msclkid|mc_cid|mc_eid|_ga|ref|ref_src|referrer|trk|trkinfo|tracking_?id)$/i

/** Relative-age phrases change every day while the posting does not. */
const RELATIVE_AGE = new RegExp(
  [
    String.raw`\b(?:(?:posted|updated|published|listed|added)\s+)?(?:\d+|an?|one)\s+(?:second|minute|hour|day|week|month|year)s?\s+ago\b[.,;]?`,
    String.raw`\b(?:(?:posted|updated|published|listed|added)\s+)?(?:today|yesterday|just\s+now)\b[.,;]?`,
  ].join('|'),
  'gi',
)

const URL_IN_TEXT = /https?:\/\/[^\s)>\]"']+/g

/**
 * `ref` is noise on a link buried in prose, but on an APPLICATION url it can be the job or
 * requisition selector (`?ref=job1` vs `?ref=job2` are different apply targets). The hash is the
 * revision dedupe key, so stripping it there would collapse two different links into one revision
 * and leave the stored link stale. Unambiguous trackers (utm_*, click ids, ref_src) stay stripped.
 */
const isApplicationSelector = (name: string): boolean => name.toLowerCase() === 'ref'

/**
 * Drops tracking params and the fragment; remaining params are sorted. Non-URLs pass through.
 * `forApplicationUrl` keeps params that may select the apply target (see above).
 */
export function stripTrackingParams(raw: string, forApplicationUrl = false): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return raw
  }
  // `canonicalParams` IS the order this module used to spell out inline, now shared with identity
  // keys so the family has one canonical order instead of two. Byte-for-byte the same output, which
  // matters: `ch1` hashes already in `job_content_hash` must not move without a version bump.
  const query = canonicalParams(
    [...url.searchParams].filter(
      ([name]) => !TRACKING_PARAM.test(name) || (forApplicationUrl && isApplicationSelector(name)),
    ),
  ).join('&')
  return `${url.origin}${url.pathname}${query ? `?${query}` : ''}`
}

/** Removes relative-age phrases and tracking tokens from links; collapses whitespace. */
export function stripVolatileText(text: string): string {
  return text
    .replace(URL_IN_TEXT, (u) => stripTrackingParams(u))
    .replace(RELATIVE_AGE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s*\n\s*\n\s*/g, '\n\n')
    .trim()
    .replace(/\s+\.$/, '.')
}

/** Composed and decomposed spellings of the same text must hash alike. */
function nfc<T>(value: T): T {
  if (typeof value === 'string') return value.normalize('NFC') as T
  if (Array.isArray(value)) return value.map((v) => nfc(v)) as T
  return value
}

/** UPDATED is excluded: boards bump it on every refresh without the posting changing. */
const HASHED_DATE_SEMANTICS = ['PUBLISHED', 'RELEASED', 'EXPIRY'] as const

export function computeContentHash(
  fields: HashableFields,
  version: string = CONTENT_HASH_VERSION,
): string {
  const dates = HASHED_DATE_SEMANTICS.map((semantics) => {
    const d = fields.dates.find((x) => x.semantics === semantics)
    return [semantics, d?.value ? d.value.toISOString() : null, d?.status ?? null]
  })
  const payload = encodeIdentityTuple(
    nfc([
      version,
      fields.title,
      fields.companyName,
      fields.location,
      stripVolatileText(fields.descriptionMd),
      fields.remote,
      fields.employmentType,
      fields.seniorityHint,
      // NFC BEFORE dedupe and sort: composed and decomposed spellings are one tag, and sorting
      // raw code units first would order them differently than their normalized forms.
      [...new Set(fields.tags.map((t) => t.normalize('NFC')))].sort(),
      fields.applicationUrl && stripTrackingParams(fields.applicationUrl, true),
      dates,
    ]),
  )
  return createHash('sha256').update(payload).digest('hex')
}
