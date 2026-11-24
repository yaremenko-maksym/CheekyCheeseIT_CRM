import { selectByIdentity } from '../../structuring/json-ld'
import { definePagedProvider } from '../api-json.provider'
import { MIN_HOST_GAP_MS, realSleep } from '../html/html-ports'
import {
  collectSitemapJsonLd,
  lastmodCreatedAtMs,
  sitemapConfigSchema,
  type SitemapJsonLdBounds,
  type SitemapJsonLdDeps,
  type SitemapJsonLdSite,
  sitemapLimits,
} from './sitemap-jsonld'

/**
 * ReactJobs (React and frontend roles) on the sitemap + JSON-LD adapter (wave 3, sitemap family).
 *
 * `https://reactjobs.io/sitemap.xml` is an index of three parts. Only `sitemap3.xml` lists job pages
 * (`reactjobs.io/react-jobs/<company>/<numeric id>-<slug>`, ~3 500 on the captured day); `sitemap1.xml`
 * lists category pages and `sitemap2.xml` company pages. The index is read whole and only that one part
 * is requested (`sitemapPart`). `<lastmod>` orders the postings, newest first. The JSON-LD `JobPosting`
 * carries no `identifier`, so the posting is selected by its `url`, which equals the sitemap `<loc>`.
 * The page links no employer ATS job, so the posting URL is ReactJobs' own page (ATS_COPY joins it to
 * the employer's posting, `../../identity/resolver.ts`).
 *
 * robots.txt is `User-agent: *` with an empty `Disallow:`, so every path is allowed.
 */

export const REACTJOBS_SOURCE_STATUS = {
  blocked: false,
  permission: 'UNCLEAR',
  reason:
    'robots.txt allows every path; the privacy policy has no automated-access clause and the terms page is not found; reactjobs.io/sitemap3.xml and the job pages it lists only, no evasion of any block',
} as const

export const REACTJOBS_ADAPTER_VERSION = 'reactjobs-1'
export const REACTJOBS_HOST = 'reactjobs.io'
export const REACTJOBS_NAMESPACE = 'reactjobs'
export const REACTJOBS_ENDPOINT_VARIANT = 'jobs-sitemap'

/** One index request, one part request, plus at most 25 detail pages per run. */
export const REACTJOBS_BOUNDS: SitemapJsonLdBounds = { maxDetails: 25, minGapMs: MIN_HOST_GAP_MS }

export const REACTJOBS_SITE: SitemapJsonLdSite = {
  type: 'REACTJOBS_HTML',
  adapterVersion: REACTJOBS_ADAPTER_VERSION,
  namespace: REACTJOBS_NAMESPACE,
  sitemapUrl: `https://${REACTJOBS_HOST}/sitemap.xml`,
  // The job part is ~900 KB; the cap leaves room for growth of about 2x.
  sitemapLimits: sitemapLimits(2 * 1024 * 1024),
  jobUrl: /^https:\/\/reactjobs\.io\/react-jobs\/[a-z0-9-]+\/(\d+)-[a-z0-9-]+$/,
  order: 'LASTMOD',
  // Only the job part. The company and category parts list no job pages.
  sitemapPart: /^https:\/\/reactjobs\.io\/sitemap3\.xml$/,
  descriptionKind: 'html',
  createdAtMs: lastmodCreatedAtMs,
  select: (postings, job) => selectByIdentity(postings, { url: job.url }),
}

const configSchema = sitemapConfigSchema(REACTJOBS_NAMESPACE, 'ReactJobs')

export function createReactJobsProvider(
  bounds: SitemapJsonLdBounds = REACTJOBS_BOUNDS,
  deps: SitemapJsonLdDeps = { sleep: realSleep, random: Math.random },
) {
  // Stryker disable next-line StringLiteral,ObjectLiteral: manifest.drift.spec.ts reads this literal from the source text; instrumenting it hides the type from that scan, and the registry specs pin the type
  return definePagedProvider({ type: 'REACTJOBS_HTML', configSchema }, (config, ctx) =>
    collectSitemapJsonLd(REACTJOBS_SITE, bounds, deps, config, ctx),
  )
}

export const reactJobsProvider = createReactJobsProvider()

/** The one host this adapter's requests may reach; a transport is pinned to it. */
export const reactJobsAllowedHosts = (): readonly string[] => [REACTJOBS_HOST]
