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
 * Remote First Jobs (remote roles, all functions) on the sitemap + JSON-LD adapter (wave 3, sitemap family).
 *
 * `https://remotefirstjobs.com/sitemap_jobs_0.xml` (~415 KB, 2 161 job pages on the captured day) lists
 * every job as `remotefirstjobs.com/companies/<company>/jobs/<slug>-<numeric id>`. `<lastmod>` is on
 * every entry and orders the postings, newest first. The JSON-LD `JobPosting` carries the job slug as
 * `identifier` (`propertyId: slug`), so the posting is selected by the slug, the last part of the id.
 * The page links no employer ATS job, so the posting URL is Remote First Jobs' own page (ATS_COPY joins
 * it to the employer's posting, `../../identity/resolver.ts`).
 *
 * The listing mixes every function (finance and administration included). No pre-fetch IT filter is
 * possible from the URL; the scope gate (`../../funnel/role-scope-gate.ts`) rejects the non-IT postings
 * after the read, as for the other general boards.
 *
 * robots.txt disallows `/api/`, `/cdn-cgi/` and a few other paths; the job paths are allowed.
 */

export const REMOTEFIRSTJOBS_SOURCE_STATUS = {
  blocked: false,
  permission: 'UNCLEAR',
  reason:
    'robots.txt disallows /api/ only, and the terms do not address automated access, but they restrict copying and downloading without permission; remotefirstjobs.com/sitemap_jobs_0.xml and the job pages it lists only, no evasion of any block',
} as const

export const REMOTEFIRSTJOBS_ADAPTER_VERSION = 'remotefirstjobs-1'
export const REMOTEFIRSTJOBS_HOST = 'remotefirstjobs.com'
export const REMOTEFIRSTJOBS_NAMESPACE = 'remotefirstjobs'
export const REMOTEFIRSTJOBS_ENDPOINT_VARIANT = 'jobs-sitemap'

/** One sitemap request plus 25 detail pages per run. */
export const REMOTEFIRSTJOBS_BOUNDS: SitemapJsonLdBounds = {
  maxDetails: 25,
  minGapMs: MIN_HOST_GAP_MS,
}

export const REMOTEFIRSTJOBS_SITE: SitemapJsonLdSite = {
  type: 'REMOTEFIRSTJOBS_HTML',
  adapterVersion: REMOTEFIRSTJOBS_ADAPTER_VERSION,
  namespace: REMOTEFIRSTJOBS_NAMESPACE,
  sitemapUrl: `https://${REMOTEFIRSTJOBS_HOST}/sitemap_jobs_0.xml`,
  // ~8x the captured size.
  sitemapLimits: sitemapLimits(4 * 1024 * 1024),
  jobUrl: /^https:\/\/remotefirstjobs\.com\/companies\/[a-z0-9-]+\/jobs\/([a-z0-9-]+-\d+)$/,
  order: 'LASTMOD',
  descriptionKind: 'html',
  createdAtMs: lastmodCreatedAtMs,
  select: (postings, job) => selectByIdentity(postings, { identifier: job.id }),
}

const configSchema = sitemapConfigSchema(REMOTEFIRSTJOBS_NAMESPACE, 'Remote First Jobs')

export function createRemoteFirstJobsProvider(
  bounds: SitemapJsonLdBounds = REMOTEFIRSTJOBS_BOUNDS,
  deps: SitemapJsonLdDeps = { sleep: realSleep, random: Math.random },
) {
  // Stryker disable next-line StringLiteral,ObjectLiteral: manifest.drift.spec.ts reads this literal from the source text; instrumenting it hides the type from that scan, and the registry specs pin the type
  return definePagedProvider({ type: 'REMOTEFIRSTJOBS_HTML', configSchema }, (config, ctx) =>
    collectSitemapJsonLd(REMOTEFIRSTJOBS_SITE, bounds, deps, config, ctx),
  )
}

export const remoteFirstJobsProvider = createRemoteFirstJobsProvider()

/** The one host this adapter's requests may reach; a transport is pinned to it. */
export const remoteFirstJobsAllowedHosts = (): readonly string[] => [REMOTEFIRSTJOBS_HOST]
