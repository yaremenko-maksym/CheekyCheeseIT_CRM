import { createHash } from 'node:crypto'
import type { JobSourceType } from '@crm/shared'
import { normalizeCompanyName } from '@crm/shared'

/**
 * Provider contract for external job sources — task-job-sourcing-slice1.
 *
 * Slice 1 ships ONE provider (DOU RSS). The seam exists because slice 2 adds
 * aggregators (LinkedIn / Indeed via Google for Jobs) and the collector must
 * not need to change when it does: `JobSourcingService` talks only to this
 * interface, and everything source-specific (endpoint, feed shape, title
 * grammar) stays inside the implementation.
 *
 * Adding a source means: a new `JobSourceType` member (shared enum + pg enum),
 * a class implementing `JobSourceProvider`, and one line in the module's
 * provider registry. Nothing else.
 *
 * SCRAPING IS OUT OF BOUNDS (task §Границы): a provider may only read an
 * official feed or API.
 */

/** A posting normalized to OUR shape, ready to be persisted. */
export interface NormalizedPosting {
  sourceType: JobSourceType
  /** Stable identity within the source — the canonical URL. */
  externalId: string
  /** Original posting URL (https, query-stripped). */
  url: string
  title: string
  companyName: string
  companyNameNormalized: string
  location: string | null
  /** Markdown, NO raw HTML (see html-to-markdown.ts). */
  descriptionMd: string
  publishedAt: Date | null
  /** Dedupe key — see `computePostingFingerprint`. */
  fingerprint: string
}

export interface JobSourceProvider {
  readonly type: JobSourceType
  /**
   * Fetch + normalize. Implementations MUST NOT throw for a single unparseable
   * entry (skip it); they MAY throw when the source itself is unreachable — the
   * collector catches that and logs it as a failed run.
   */
  collect(config: Record<string, unknown>): Promise<NormalizedPosting[]>
}

/**
 * Canonical form of a posting URL — `https://host/path` with query, fragment,
 * default port and trailing slash removed, host lowercased.
 *
 * THIS IS THE DEDUPE SPINE (AC1). DOU's `<guid>` carries a FRESH TIMESTAMP
 * query on every fetch (`…/vacancies/356562/?1786092518`) and `<link>` carries
 * `?utm_source=jobsrss`, so a fingerprint over the raw URL would treat the very
 * same vacancy as brand new on every single collection run — the feed would
 * duplicate itself daily.
 *
 * Returns `null` when the URL is unusable or is not https (a `javascript:` or
 * `data:` URL from a hostile feed dies right here, before it can ever be
 * persisted and handed to `window.open`).
 */
export function canonicalizePostingUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.hostname.length === 0) return null

  const path = parsed.pathname.replace(/\/+$/, '')
  return `https://${parsed.host.toLowerCase()}${path}`
}

/**
 * sha256(sourceType + '|' + canonicalUrl), hex. Stored in
 * `job_postings.fingerprint` behind a unique index, so a re-collected posting
 * hits ON CONFLICT instead of inserting a twin.
 *
 * Same idiom as `apps/api/src/telemetry/fingerprint.ts` (sha256 over a
 * normalized identity string) — deliberately consistent with the existing
 * dedupe convention in this codebase.
 */
export function computePostingFingerprint(sourceType: JobSourceType, canonicalUrl: string): string {
  return createHash('sha256').update(`${sourceType}|${canonicalUrl}`).digest('hex')
}

/** Convenience: normalize a company name the same way everywhere. */
export function normalizedCompany(name: string): string {
  return normalizeCompanyName(name)
}
