import type { JobSourceType } from '@crm/shared'
import { MAX_DESCRIPTION_CHARS } from '../html-to-markdown'
import type { NormalizedPosting } from '../job-source.provider'
import {
  buildNormalizedPosting,
  cleanLine,
  RAW_DESCRIPTION_HEADROOM,
  safeSlice,
} from './build-posting'
import { computeContentHash } from './content-hash'
import { type DateInput, type ObservedDate, parseSourceDate } from './date-policy'
import { buildIdentity, type IdentityFailure, type ObservationIdentity } from './identity-key'
import { checkStoredLink } from './url-policy'

/**
 * The provider <-> collector contract inside the API (Task 2.1). Lives here, not in
 * `packages/shared`: nothing in `apps/web` consumes it, and the wire shapes already live in shared.
 *
 * `buildSourceObservation` WRAPS `buildNormalizedPosting` and does not replace it: display
 * limits, markdown conversion, DOU canonicalisation and the DOU fingerprint stay byte-for-byte what
 * shipped. This seam adds identity, bounded originals, dated evidence and a content hash on top.
 *
 * Policy-gated cooperative HTML (ordinary pages whose owner permits collection) enters through this
 * same seam as any other source: the adapter hands over untrusted fields, and nothing here fetches.
 */

/** Bump when normalization output changes in a way that should re-evaluate stored observations. */
export const NORMALIZER_VERSION = 'n1'

/** Retention caps for ORIGINAL (pre-normalization) text. Larger than display limits on purpose. */
export const ORIGINAL_LIMITS = {
  title: 2_000,
  companyName: 1_000,
  location: 2_000,
  description: MAX_DESCRIPTION_CHARS * RAW_DESCRIPTION_HEADROOM + 20_000,
  tag: 200,
  tags: 200,
} as const

/** Display limits as shipped by `buildNormalizedPosting` (title 500 / company 255 / tags 50x60). */
const DISPLAY_TAGS = 50
const DISPLAY_TAG_CHARS = 60

export interface BoundedText {
  /** The original, NUL-stripped, cut at the retention cap. */
  value: string
  /** Length of the original as received. */
  originalLength: number
  /** True iff `value` is shorter than the original (retention cap hit). */
  truncated: boolean
  /** True iff the normalized display value is shorter than the cleaned original. */
  displayTruncated: boolean
}

export interface BoundedTags {
  values: string[]
  originalCount: number
  truncated: boolean
  displayTruncated: boolean
}

export interface BoundedOriginalFields {
  title: BoundedText
  companyName: BoundedText
  location: BoundedText | null
  description: BoundedText & { kind: 'html' | 'text' }
  tags: BoundedTags
}

export type NormalizedVacancyFields = Omit<
  NormalizedPosting,
  'sourceType' | 'externalId' | 'fingerprint' | 'url'
> & { dates: ObservedDate[] }

export type EvidenceKind = 'DISPLAY_TRUNCATED' | 'DATE_UNCERTAIN' | 'REJECTED_LINK'

/** One entry per field whose normalized value is less certain or less complete than the original. */
export interface FieldEvidence {
  field: string
  kind: EvidenceKind
  detail: string
}

export interface SourceObservation {
  identity: ObservationIdentity
  sourcePostingUrl: string
  applicationUrl: string | null
  originalFields: BoundedOriginalFields
  normalized: NormalizedVacancyFields
  evidence: FieldEvidence[]
  adapterVersion: string
  normalizerVersion: string
  contentHash: string
}

export type QuarantineReason =
  IdentityFailure | 'UNSAFE_URL' | 'MISSING_TITLE' | 'MISSING_COMPANY' | 'INVALID_RECORD'

export type ObservationResult =
  { ok: true; observation: SourceObservation } | { ok: false; reason: QuarantineReason }

/** Untrusted adapter output. */
export interface RawObservationFields {
  provider: JobSourceType
  /** Verified board/account + regional endpoint variant. */
  namespace: string
  nativeId?: string | null
  url: string | null | undefined
  /** Query params that identify a posting on this source; every other param is noise. */
  identityParams?: readonly string[]
  title: string | null | undefined
  companyName: string | null | undefined
  location?: string | null
  description?: string | null
  descriptionKind?: 'html' | 'text'
  remote?: boolean | null
  employmentType?: string | null
  seniorityHint?: string | null
  tags?: string[]
  applicationUrl?: string | null
  dates?: Array<Omit<DateInput, 'raw'> & { raw: DateInput['raw'] }>
  adapterVersion: string
  /** Accepted so adapters can pass it through; deliberately never read by anything that hashes. */
  fetch?: { fetchedAt?: Date; requestId?: string }
}

/**
 * `{ [key]: value }`, typed as an optional property so `exactOptionalPropertyTypes` targets accept it.
 * An undefined value stays an own key holding `undefined`: every consumer here reads the property
 * and none tests for the key's presence (`in` / `Object.keys`), so absent and undefined coincide.
 */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return { [key]: value } as { [P in K]?: V }
}

function noNul(value: string): string {
  return value.replace(/\u0000/g, '')
}

/**
 * Display truncation for a single-line field: a length limit cut the value. Measured on the
 * post-strip, pre-cap text (the display pipeline's own `cleanLine`, uncapped), so characters removed
 * for safety (NUL, bidi marks) and trimmed whitespace never count as a cut.
 */
function cutAtDisplayLimit(displayLength: number) {
  return (text: string) => cleanLine(text, Infinity).length > displayLength
}

function boundedText(
  original: unknown,
  retentionMax: number,
  /** Decides `displayTruncated` from the NUL-stripped original. */
  isDisplayTruncated: (text: string) => boolean,
): BoundedText {
  const received = typeof original === 'string' ? original : ''
  const text = noNul(received)
  const value = safeSlice(text, retentionMax)
  return {
    value,
    originalLength: received.length,
    truncated: value.length < text.length,
    displayTruncated: isDisplayTruncated(text),
  }
}

function descriptionDisplayTruncated(
  raw: string | null | undefined,
  kind: 'html' | 'text',
  descriptionMd: string,
): boolean {
  if (typeof raw !== 'string') return false
  if (kind === 'text') return noNul(raw).trim().length > MAX_DESCRIPTION_CHARS
  // htmlToMarkdown cuts at the cap and appends an ellipsis; the raw input is also pre-cut.
  return (
    raw.length > MAX_DESCRIPTION_CHARS * RAW_DESCRIPTION_HEADROOM ||
    descriptionMd.length > MAX_DESCRIPTION_CHARS
  )
}

function quarantine(reason: QuarantineReason): ObservationResult {
  return { ok: false, reason }
}

export function buildSourceObservation(
  raw: RawObservationFields,
  options: { now?: Date } = {},
): ObservationResult {
  const now = options.now ?? new Date()

  const identity = buildIdentity({
    provider: raw.provider,
    namespace: raw.namespace,
    nativeId: raw.nativeId,
    url: raw.url,
    ...optional('identityParams', raw.identityParams),
  })
  if (!identity.ok) return quarantine(identity.reason)

  const link = checkStoredLink(raw.url)
  if (!link.ok) return quarantine('UNSAFE_URL')
  if (cleanLine(raw.title, Infinity).length === 0) return quarantine('MISSING_TITLE')
  if (cleanLine(raw.companyName, Infinity).length === 0) return quarantine('MISSING_COMPANY')

  // The shipped normalizer receives the already-validated, host-normalized link.
  const posting = buildNormalizedPosting(raw.provider, {
    url: link.url.href,
    title: raw.title,
    companyName: raw.companyName,
    ...optional('location', raw.location),
    ...optional('description', raw.description),
    ...optional('descriptionKind', raw.descriptionKind),
    ...optional('remote', raw.remote),
    ...optional('employmentType', raw.employmentType),
    ...optional('seniorityHint', raw.seniorityHint),
    ...optional('tags', raw.tags),
    ...optional('keepQueryParams', raw.identityParams),
  })
  if (posting === null) return quarantine('INVALID_RECORD')

  const evidence: FieldEvidence[] = []

  const dates: ObservedDate[] = []
  raw.dates?.forEach((input) => {
    const parsed = parseSourceDate(input, now)
    if (parsed === null) return
    dates.push(parsed)
    if (parsed.status !== 'OK') {
      evidence.push({
        field: `date.${parsed.semantics}`,
        kind: 'DATE_UNCERTAIN',
        detail: parsed.status,
      })
    }
  })
  const published = dates.find((d) => d.semantics === 'PUBLISHED' && d.status === 'OK')

  let applicationUrl: string | null = null
  if (raw.applicationUrl !== null && raw.applicationUrl !== undefined) {
    const app = checkStoredLink(raw.applicationUrl)
    if (app.ok) {
      app.url.hash = ''
      applicationUrl = app.url.href
    } else {
      evidence.push({ field: 'applicationUrl', kind: 'REJECTED_LINK', detail: app.reason })
    }
  }

  const kind = raw.descriptionKind === 'text' ? 'text' : 'html'
  const title = boundedText(
    raw.title,
    ORIGINAL_LIMITS.title,
    cutAtDisplayLimit(posting.title.length),
  )
  const companyName = boundedText(
    raw.companyName,
    ORIGINAL_LIMITS.companyName,
    cutAtDisplayLimit(posting.companyName.length),
  )
  const location =
    typeof raw.location === 'string' && raw.location.trim().length > 0
      ? boundedText(
          raw.location,
          ORIGINAL_LIMITS.location,
          cutAtDisplayLimit(posting.location?.length ?? 0),
        )
      : null
  const description = {
    ...boundedText(raw.description, ORIGINAL_LIMITS.description, () =>
      descriptionDisplayTruncated(raw.description, kind, posting.descriptionMd),
    ),
    kind,
  } as const

  const rawTags = Array.isArray(raw.tags)
    ? ((raw.tags as unknown[]).filter((t) => typeof t === 'string') as string[])
    : []
  const tags: BoundedTags = {
    values: rawTags
      .slice(0, ORIGINAL_LIMITS.tags)
      .map((t) => safeSlice(noNul(t), ORIGINAL_LIMITS.tag)),
    originalCount: rawTags.length,
    // A tag's length is measured after NUL stripping, as `values` are, so only a real cut counts.
    truncated:
      rawTags.length > ORIGINAL_LIMITS.tags ||
      rawTags.some((t) => noNul(t).length > ORIGINAL_LIMITS.tag),
    displayTruncated:
      rawTags.length > DISPLAY_TAGS ||
      rawTags.some((t) => cleanLine(t, Infinity).length > DISPLAY_TAG_CHARS),
  }

  for (const [field, b] of [
    ['title', title],
    ['companyName', companyName],
    ['location', location],
    ['description', description],
    ['tags', tags],
  ] as const) {
    if (b?.displayTruncated)
      evidence.push({ field, kind: 'DISPLAY_TRUNCATED', detail: 'exceeds display limit' })
  }

  const { sourceType: _s, externalId: _e, fingerprint: _f, url: _u, ...display } = posting
  const normalized: NormalizedVacancyFields = {
    ...display,
    publishedAt: published?.value ?? null,
    dates,
  }

  return {
    ok: true,
    observation: {
      identity: identity.identity,
      sourcePostingUrl: posting.url,
      applicationUrl,
      originalFields: { title, companyName, location, description, tags },
      normalized,
      evidence,
      adapterVersion: raw.adapterVersion,
      normalizerVersion: NORMALIZER_VERSION,
      contentHash: computeContentHash({
        title: normalized.title,
        companyName: normalized.companyName,
        location: normalized.location,
        descriptionMd: normalized.descriptionMd,
        remote: normalized.remote ?? null,
        employmentType: normalized.employmentType ?? null,
        seniorityHint: normalized.seniorityHint ?? null,
        // `tags` is optional on the provider type; `new Set(undefined)` is empty, and the hash
        // de-duplicates and sorts anyway, so this is the same input without a fallback literal.
        tags: [...new Set(normalized.tags)],
        applicationUrl,
        dates,
      }),
    },
  }
}
