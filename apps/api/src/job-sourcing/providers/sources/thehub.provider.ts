import { selectByIdentity } from '../../structuring/json-ld'
import { definePagedProvider } from '../api-json.provider'
import { MIN_HOST_GAP_MS, realSleep } from '../html/html-ports'
import {
  collectSitemapJsonLd,
  type SitemapJsonLdBounds,
  type SitemapJsonLdDeps,
  type SitemapJsonLdSite,
  sitemapConfigSchema,
  sitemapLimits,
} from './sitemap-jsonld'

/**
 * The Hub (thehub.io), Nordic startup jobs, on the sitemap + JSON-LD adapter (task sources-13).
 *
 * `https://thehub.io/sitemap-jobs.xml` lists every job page as `thehub.io/jobs/<24-hex id>` (1 327 on
 * 2026-11-21, ~240 KB). Its `<lastmod>` is the EDIT time and reaches back to 2022, so it does not
 * order postings; the id is a Mongo ObjectId whose first 4 bytes are the creation second, so the id
 * descending is newest first. The page's JSON-LD `JobPosting` carries the same id as `identifier`
 * and `url: null`, so the posting is selected by identifier. The page links no employer ATS job, so
 * the posting URL is The Hub's own page (no ATS dedup key). No `baseSalary` is published.
 *
 * Terms PROHIBITED: collected under the owner's ACCEPT_PROHIBITED_RISK decision of 2026-11-20.
 */

export const THEHUB_SOURCE_STATUS = {
  blocked: false,
  permission: 'PROHIBITED',
  reason:
    'permitted by the owner decision of 2026-11-20 (ACCEPT_PROHIBITED_RISK on terms that forbid collection; thehub.io/sitemap-jobs.xml and the job pages it lists only, no evasion of any block)',
} as const

export const THEHUB_ADAPTER_VERSION = 'thehub-1'
export const THEHUB_HOST = 'thehub.io'
export const THEHUB_NAMESPACE = 'thehub'
export const THEHUB_ENDPOINT_VARIANT = 'jobs-sitemap'

/** One sitemap request plus 25 detail pages (~60 KB each) per run. */
export const THEHUB_BOUNDS: SitemapJsonLdBounds = { maxDetails: 25, minGapMs: MIN_HOST_GAP_MS }

export const THEHUB_SITE: SitemapJsonLdSite = {
  type: 'THEHUB_HTML',
  adapterVersion: THEHUB_ADAPTER_VERSION,
  namespace: THEHUB_NAMESPACE,
  sitemapUrl: `https://${THEHUB_HOST}/sitemap-jobs.xml`,
  // 8x the captured size.
  sitemapLimits: sitemapLimits(2 * 1024 * 1024),
  jobUrl: /^https:\/\/thehub\.io\/jobs\/([0-9a-f]{24})$/,
  order: 'ID',
  descriptionKind: 'html',
  select: (postings, job) => selectByIdentity(postings, { identifier: job.id }),
}

const configSchema = sitemapConfigSchema(THEHUB_NAMESPACE, 'The Hub')

export function createTheHubProvider(
  bounds: SitemapJsonLdBounds = THEHUB_BOUNDS,
  deps: SitemapJsonLdDeps = { sleep: realSleep, random: Math.random },
) {
  // Stryker disable next-line StringLiteral,ObjectLiteral: manifest.drift.spec.ts reads this literal from the source text; instrumenting it hides the type from that scan, and the registry specs pin the type
  return definePagedProvider({ type: 'THEHUB_HTML', configSchema }, (config, ctx) =>
    collectSitemapJsonLd(THEHUB_SITE, bounds, deps, config, ctx),
  )
}

export const theHubProvider = createTheHubProvider()

/** The one host this adapter's requests may reach; a transport is pinned to it. */
export const theHubAllowedHosts = (): readonly string[] => [THEHUB_HOST]
