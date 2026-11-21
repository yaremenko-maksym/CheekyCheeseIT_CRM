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
 * Landing.jobs (Portugal and remote Europe) on the sitemap + JSON-LD adapter (task sources-13).
 *
 * `https://landing.jobs/sitemap.xml` (~150 KB) lists every page of the site; only
 * `landing.jobs/at/<company>/<job slug>` is a job. The job slug alone is not unique across
 * companies, so the native id is `<company>/<job slug>`. `<lastmod>` is a bare date and orders the
 * postings, newest first. The JSON-LD `JobPosting` carries the job slug as `identifier` and
 * `url: null`, so it is selected by that slug. The page links no employer ATS job, so the posting URL
 * is Landing.jobs' own page (no ATS dedup key). No `baseSalary` is published.
 *
 * Terms PROHIBITED: collected under the owner's ACCEPT_PROHIBITED_RISK decision of 2026-11-20.
 */

export const LANDINGJOBS_SOURCE_STATUS = {
  blocked: false,
  permission: 'PROHIBITED',
  reason:
    'permitted by the owner decision of 2026-11-20 (ACCEPT_PROHIBITED_RISK on terms that forbid collection; landing.jobs/sitemap.xml and the /at/ job pages it lists only, no evasion of any block)',
} as const

export const LANDINGJOBS_ADAPTER_VERSION = 'landingjobs-1'
export const LANDINGJOBS_HOST = 'landing.jobs'
export const LANDINGJOBS_NAMESPACE = 'landingjobs'
export const LANDINGJOBS_ENDPOINT_VARIANT = 'jobs-sitemap'

/** One sitemap request plus 25 detail pages (~95 KB each) per run. */
export const LANDINGJOBS_BOUNDS: SitemapJsonLdBounds = {
  maxDetails: 25,
  minGapMs: MIN_HOST_GAP_MS,
}

export const LANDINGJOBS_SITE: SitemapJsonLdSite = {
  type: 'LANDINGJOBS_HTML',
  adapterVersion: LANDINGJOBS_ADAPTER_VERSION,
  namespace: LANDINGJOBS_NAMESPACE,
  sitemapUrl: `https://${LANDINGJOBS_HOST}/sitemap.xml`,
  // ~14x the captured size: the sitemap carries every page of the site, not only jobs.
  sitemapLimits: sitemapLimits(2 * 1024 * 1024),
  jobUrl: /^https:\/\/landing\.jobs\/at\/([a-z0-9-]{1,100}\/[a-z0-9-]{1,150})$/,
  order: 'LASTMOD',
  descriptionKind: 'html',
  select: (postings, job) =>
    selectByIdentity(postings, { identifier: job.id.slice(job.id.indexOf('/') + 1) }),
}

const configSchema = sitemapConfigSchema(LANDINGJOBS_NAMESPACE, 'Landing.jobs')

export function createLandingJobsProvider(
  bounds: SitemapJsonLdBounds = LANDINGJOBS_BOUNDS,
  deps: SitemapJsonLdDeps = { sleep: realSleep, random: Math.random },
) {
  // Stryker disable next-line StringLiteral,ObjectLiteral: manifest.drift.spec.ts reads this literal from the source text; instrumenting it hides the type from that scan, and the registry specs pin the type
  return definePagedProvider({ type: 'LANDINGJOBS_HTML', configSchema }, (config, ctx) =>
    collectSitemapJsonLd(LANDINGJOBS_SITE, bounds, deps, config, ctx),
  )
}

export const landingJobsProvider = createLandingJobsProvider()

/** The one host this adapter's requests may reach; a transport is pinned to it. */
export const landingJobsAllowedHosts = (): readonly string[] => [LANDINGJOBS_HOST]
