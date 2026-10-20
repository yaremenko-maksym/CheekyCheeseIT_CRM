import { createHash } from 'node:crypto'
import type { ObservedDate } from './date-policy'
import { encodeIdentityTuple } from './identity-key'

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

/** Drops tracking params and the fragment; remaining params are sorted. Non-URLs pass through. */
export function stripTrackingParams(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return raw
  }
  const kept = [...url.searchParams].filter(([name]) => !TRACKING_PARAM.test(name))
  kept.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
  const query = kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
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
  const payload = encodeIdentityTuple([
    version,
    fields.title,
    fields.companyName,
    fields.location,
    stripVolatileText(fields.descriptionMd),
    fields.remote,
    fields.employmentType,
    fields.seniorityHint,
    [...new Set(fields.tags)].sort(),
    fields.applicationUrl === null ? null : stripTrackingParams(fields.applicationUrl),
    dates,
  ])
  return createHash('sha256').update(payload).digest('hex')
}
