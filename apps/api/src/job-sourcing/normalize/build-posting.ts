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

export function parseDateish(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null
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
  const canonicalUrl = canonicalizePostingUrl(raw.url, raw.keepQueryParams)
  if (!canonicalUrl) return null

  const title = stripUnstorableChars(raw.title ?? '')
    .trim()
    .slice(0, 500)
  const companyName = stripUnstorableChars(raw.companyName ?? '')
    .trim()
    .slice(0, 255)
  if (title.length === 0 || companyName.length === 0) return null

  const location = raw.location ? stripUnstorableChars(raw.location).trim().slice(0, 500) : ''
  const descriptionMd =
    raw.descriptionKind === 'text'
      ? stripUnstorableChars(raw.description ?? '').slice(0, MAX_DESCRIPTION_CHARS)
      : stripUnstorableChars(htmlToMarkdown(raw.description))

  return {
    sourceType,
    externalId: canonicalUrl,
    url: canonicalUrl,
    title,
    companyName,
    companyNameNormalized: normalizedCompany(companyName).slice(0, 255),
    location: location.length > 0 ? location : null,
    descriptionMd,
    publishedAt: parseDateish(raw.publishedAt),
    fingerprint: computePostingFingerprint(sourceType, canonicalUrl),
    remote: raw.remote ?? null,
    employmentType: raw.employmentType
      ? stripUnstorableChars(raw.employmentType).slice(0, 100)
      : null,
    seniorityHint: raw.seniorityHint ? stripUnstorableChars(raw.seniorityHint).slice(0, 100) : null,
    tags: (raw.tags ?? [])
      .slice(0, MAX_TAGS)
      .map((t) => stripUnstorableChars(t).trim().slice(0, MAX_TAG_CHARS))
      .filter((t) => t.length > 0),
  }
}
