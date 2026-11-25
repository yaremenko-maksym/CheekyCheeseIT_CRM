import { definePagedProvider } from '../api-json.provider'
import { MIN_HOST_GAP_MS, realSleep } from '../html/html-ports'
import {
  collectSitemapJsonLd,
  lastmodCreatedAtMs,
  selectByCanonical,
  sitemapConfigSchema,
  type SitemapJsonLdBounds,
  type SitemapJsonLdDeps,
  type SitemapJsonLdSite,
  sitemapLimits,
} from './sitemap-jsonld'

/**
 * Jobspresso (remote roles, mostly technology) on the sitemap + JSON-LD adapter (wave 3, sitemap family).
 *
 * `https://jobspresso.co/sitemap_index.xml` is a Yoast index. Only its job-listing parts
 * (`job_listing-sitemap1.xml`, `job_listing-sitemap2.xml`; ~1 580 job pages on the captured day) are
 * requested (`sitemapPart`), the newest (highest-numbered) first; the page, company and category parts are not read. A job is
 * `jobspresso.co/job/<slug>/`. Jobspresso has no numeric id, so the id is the slug, and `<lastmod>`
 * orders the postings, newest first. The JSON-LD `JobPosting` names neither a `url` nor an `identifier`
 * the sitemap lists (its identifier is the WordPress post address), so the posting is selected by the
 * page's canonical link, which must be the sitemap URL (`selectByCanonical`). The page links no employer
 * ATS job, so the posting URL is Jobspresso's own page (ATS_COPY joins it to the employer's posting,
 * `../../identity/resolver.ts`).
 *
 * The listing includes non-technical roles; the scope gate (`../../funnel/role-scope-gate.ts`) rejects
 * them after the read, as for the other general boards.
 *
 * robots.txt disallows query-string URLs (`/*?`) and calendar or event actions; the job paths are allowed.
 */

export const JOBSPRESSO_SOURCE_STATUS = {
  blocked: false,
  permission: 'UNCLEAR',
  reason:
    'the terms restrict commercial use and copying of the materials, and do not mention automated access; jobspresso.co job-listing sitemaps and the job pages they list only, no evasion of any block',
} as const

export const JOBSPRESSO_ADAPTER_VERSION = 'jobspresso-1'
export const JOBSPRESSO_HOST = 'jobspresso.co'
export const JOBSPRESSO_NAMESPACE = 'jobspresso'
export const JOBSPRESSO_ENDPOINT_VARIANT = 'jobs-sitemap'

/** One index request, at most two part requests, plus at most 25 detail pages per run. */
export const JOBSPRESSO_BOUNDS: SitemapJsonLdBounds = { maxDetails: 25, minGapMs: MIN_HOST_GAP_MS }

export const JOBSPRESSO_SITE: SitemapJsonLdSite = {
  type: 'JOBSPRESSO_HTML',
  adapterVersion: JOBSPRESSO_ADAPTER_VERSION,
  namespace: JOBSPRESSO_NAMESPACE,
  sitemapUrl: `https://${JOBSPRESSO_HOST}/sitemap_index.xml`,
  // The larger part: ~310 KB, ~1 000 URLs of at most 6 elements each (url, loc, lastmod and an
  // image:image with its loc and title) = ~6 000 elements, plus 4 attributes. 2 MiB bytes (about
  // 6.8x); the default 250 ms budget = 25 000 items (about 4x), the cap that binds first.
  sitemapLimits: sitemapLimits(2 * 1024 * 1024),
  jobUrl: /^https:\/\/jobspresso\.co\/job\/([a-z0-9-]+)\/$/,
  order: 'LASTMOD',
  // Only the job-listing parts, the highest-numbered (newest) first, at most MAX_SITEMAP_PARTS: a
  // third part reads parts 3 and 2. At most 4 digits bounds the parts an index can name (SR4-H-1).
  // The page, company and category parts list no job pages.
  sitemapPart: /^https:\/\/jobspresso\.co\/job_listing-sitemap(\d{1,4})\.xml$/,
  descriptionKind: 'html',
  createdAtMs: lastmodCreatedAtMs,
  select: (postings, job, html) => selectByCanonical(postings, job, html),
}

const configSchema = sitemapConfigSchema(JOBSPRESSO_NAMESPACE, 'Jobspresso')

export function createJobspressoProvider(
  bounds: SitemapJsonLdBounds = JOBSPRESSO_BOUNDS,
  deps: SitemapJsonLdDeps = { sleep: realSleep, random: Math.random },
) {
  // Stryker disable next-line StringLiteral,ObjectLiteral: manifest.drift.spec.ts reads this literal from the source text; instrumenting it hides the type from that scan, and the registry specs pin the type
  return definePagedProvider({ type: 'JOBSPRESSO_HTML', configSchema }, (config, ctx) =>
    collectSitemapJsonLd(JOBSPRESSO_SITE, bounds, deps, config, ctx),
  )
}

export const jobspressoProvider = createJobspressoProvider()

/** The one host this adapter's requests may reach; a transport is pinned to it. */
export const jobspressoAllowedHosts = (): readonly string[] => [JOBSPRESSO_HOST]
