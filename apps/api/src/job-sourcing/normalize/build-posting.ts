import type { JobSourceType } from '@crm/shared'
import { stripUnstorableChars } from '../dou.provider'
import { htmlToMarkdown, MAX_DESCRIPTION_CHARS } from '../html-to-markdown'
import {
  canonicalizePostingUrl,
  computePostingFingerprint,
  normalizedCompany,
  type NormalizedPosting,
} from '../job-source.provider'

/** Source-agnostic raw fields a provider extracts before normalization. All UNTRUSTED. */
export interface RawPostingFields {
  url: string | null | undefined
  title: string | null | undefined
  companyName: string | null | undefined
  location?: string | null
  description?: string | null
  /** default 'html' */
  descriptionKind?: 'html' | 'text'
  /** number: < 1e12 → unix seconds, otherwise milliseconds */
  publishedAt?: Date | string | number | null
  remote?: boolean | null
  employmentType?: string | null
  seniorityHint?: string | null
  tags?: string[]
  /** Query params that identify the posting (e.g. HN: ['id']). */
  keepQueryParams?: readonly string[]
}

const MAX_TAGS = 50
const MAX_TAG_CHARS = 60
/** Wire schema (`packages/shared`) caps url/externalId at 2048; longer entries are dropped, not cut. */
const MAX_URL_CHARS = 2048
/** Raw description input is cut to this multiple of MAX_DESCRIPTION_CHARS BEFORE any processing. */
const RAW_DESCRIPTION_HEADROOM = 4

/** Bidi overrides/isolates/marks: can visually spoof a title or company in the UI. */
const BIDI_CHARS = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g

/** Raw JSON from a third party can hold any type; only strings are usable. */
function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** `.slice` that never leaves a lone high surrogate at the cut. */
function safeSlice(value: string, max: number): string {
  if (value.length <= max) return value
  let cut = value.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return cut
}

/** Single-line field: NUL + bidi stripped, trimmed, surrogate-safe capped. */
function cleanLine(value: unknown, max: number): string {
  const str = asString(value)
  if (str === null) return ''
  return safeSlice(stripUnstorableChars(str).replace(BIDI_CHARS, '').trim(), max)
}

/**
 * Plain-text description -> markdown that cannot render links/images/autolinks:
 * `[`/`]` and a `<` opening a tag/autolink are backslash-escaped at ingest, so safety
 * does not depend on the web renderer.
 */
function neutralizeMarkdown(text: string): string {
  // The backslash itself is escaped in the SAME first pass as `[`/`]` (before `<`). Otherwise an
  // input `\<` / `\[` would pair our added escape into a literal backslash and leave the next
  // character active. The `<` pass runs after, so it never re-escapes an escaped backslash.
  return text.replace(/[\\[\]]/g, '\\$&').replace(/<(?=[A-Za-z/!?])/g, '\\<')
}

export function parseDateish(value: Date | string | number | null | undefined): Date | null {
  if (value === null) return null
  // Stryker disable next-line ConditionalExpression: equivalent mutant, verified with node -e — `new Date(undefined)` is an Invalid Date, so without this guard `undefined` still falls through to the `Number.isNaN(date.getTime())` check below and returns null; the guard is an explicit fast path, unobservable (null, unlike undefined, needs its own guard: `new Date(null)` is the epoch, covered by a test).
  if (value === undefined) return null
  const date =
    value instanceof Date
      ? value
      : typeof value === 'number'
        ? new Date(value < 1e12 ? value * 1000 : value)
        : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Shared normalizer for every provider. Returns null (skip) for entries without an
 * https URL, title or company. Never throws on a single bad record.
 */
export function buildNormalizedPosting(
  sourceType: JobSourceType,
  raw: RawPostingFields,
): NormalizedPosting | null {
  const canonicalUrl = canonicalizePostingUrl(asString(raw.url), raw.keepQueryParams)
  if (!canonicalUrl || canonicalUrl.length > MAX_URL_CHARS) return null

  const title = cleanLine(raw.title, 500)
  const companyName = cleanLine(raw.companyName, 255)
  if (title.length === 0 || companyName.length === 0) return null

  const location = cleanLine(raw.location, 500)
  const rawDescription = asString(raw.description) ?? ''
  const descriptionMd =
    raw.descriptionKind === 'text'
      ? safeSlice(
          neutralizeMarkdown(
            stripUnstorableChars(safeSlice(rawDescription, MAX_DESCRIPTION_CHARS)).trim(),
          ),
          MAX_DESCRIPTION_CHARS,
        )
      : stripUnstorableChars(
          htmlToMarkdown(
            safeSlice(rawDescription, MAX_DESCRIPTION_CHARS * RAW_DESCRIPTION_HEADROOM),
          ),
        )

  const publishedAt = raw.publishedAt
  const employmentType = cleanLine(raw.employmentType, 100)
  const seniorityHint = cleanLine(raw.seniorityHint, 100)
  return {
    sourceType,
    externalId: canonicalUrl,
    url: canonicalUrl,
    title,
    companyName,
    companyNameNormalized: normalizedCompany(companyName).slice(0, 255),
    location: location.length > 0 ? location : null,
    descriptionMd,
    publishedAt:
      publishedAt instanceof Date ||
      typeof publishedAt === 'string' ||
      typeof publishedAt === 'number'
        ? parseDateish(publishedAt)
        : null,
    fingerprint: computePostingFingerprint(sourceType, canonicalUrl),
    remote: typeof raw.remote === 'boolean' ? raw.remote : null,
    employmentType: employmentType.length > 0 ? employmentType : null,
    seniorityHint: seniorityHint.length > 0 ? seniorityHint : null,
    tags: (Array.isArray(raw.tags) ? (raw.tags as unknown[]) : [])
      .map((t) => cleanLine(t, MAX_TAG_CHARS))
      .filter((t) => t.length > 0)
      .slice(0, MAX_TAGS),
  }
}
