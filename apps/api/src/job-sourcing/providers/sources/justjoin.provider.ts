import { definePagedProvider } from '../api-json.provider'
import { MIN_HOST_GAP_MS, realSleep } from '../html/html-ports'
import {
  collectSitemapJsonLd,
  lastmodCreatedAtMs,
  oneAtsHostedJob,
  selectByCanonical,
  sitemapConfigSchema,
  type SitemapJsonLdBounds,
  type SitemapJsonLdDeps,
  type SitemapJsonLdSite,
  sitemapLimits,
} from './sitemap-jsonld'

/**
 * JustJoin.it (Poland) on the sitemap + JSON-LD adapter (task sources-13).
 *
 * The active-jobs sitemap is an INDEX: `justjoin.it/sitemaps/active-jobs.xml` redirects to
 * `public.justjoin.com/justjoinit/sitemaps/active-jobs.xml`, which names
 * `justjoin.it/sitemaps/active-jobs/part0.xml`, which redirects to the same CDN host. The part is large (2.6 MB, 11 054 job URLs on
 * 2026-11-21), so it gets its own byte cap and a parse budget of 1 s, i.e. a 100 000-item ceiling.
 * `<lastmod>` is the REFRESH time (6 378 entries on the capture day) and orders the postings.
 *
 * The page's JSON-LD `JobPosting` has neither `identifier` nor `url`, so it is selected by the
 * page's canonical URL, which must equal the job URL. The page payload names the employer's
 * application form as `applyUrl`; when that is one ATS-hosted job it is the posting URL (ATS
 * dedup), else the JustJoin page is. No `baseSalary` is published.
 *
 * COVERAGE: ~11 000 unseen postings against ~20 a run, so the backlog never drains; a run takes the
 * most recently refreshed unseen ones.
 *
 * Terms PROHIBITED: collected under the owner's ACCEPT_PROHIBITED_RISK decision of 2026-11-20.
 */

export const JUSTJOIN_SOURCE_STATUS = {
  blocked: false,
  permission: 'PROHIBITED',
  reason:
    'permitted by the owner decision of 2026-11-20 (ACCEPT_PROHIBITED_RISK on terms that forbid collection; the active-jobs sitemap and the job pages it lists only, no evasion of any block)',
} as const

export const JUSTJOIN_ADAPTER_VERSION = 'justjoin-1'
export const JUSTJOIN_HOST = 'justjoin.it'
export const JUSTJOIN_SITEMAP_HOST = 'public.justjoin.com'
export const JUSTJOIN_NAMESPACE = 'justjoin'
export const JUSTJOIN_ENDPOINT_VARIANT = 'jobs-sitemap'

/** The index, at most two parts, and 20 detail pages (~650 KB each) per run. */
export const JUSTJOIN_BOUNDS: SitemapJsonLdBounds = { maxDetails: 20, minGapMs: MIN_HOST_GAP_MS }

/**
 * The employer's application link in the page payload (escaped once inside a script string). The
 * payload writes `&` as `\u0026`, the only backslash sequence a URL in it carries.
 */
const APPLY_URL = /\\"applyUrl\\":\\"(https:\/\/(?:[^"\\\s]|\\u0026){1,2000})\\"/g

/** The one ATS-hosted job the page's `applyUrl` names, or null. */
export function justJoinApplyUrl(html: string): string | null {
  return oneAtsHostedJob(
    [...html.matchAll(APPLY_URL)].map((match) => match[1]!.replaceAll('\\u0026', '&')),
  )
}

export const JUSTJOIN_SITE: SitemapJsonLdSite = {
  type: 'JUSTJOIN_HTML',
  adapterVersion: JUSTJOIN_ADAPTER_VERSION,
  namespace: JUSTJOIN_NAMESPACE,
  // The site's own URL (it redirects to the CDN), so the host key `justjoin.it` scopes every
  // request the adapter itself makes; the transport follows the redirect to the CDN host.
  sitemapUrl: `https://${JUSTJOIN_HOST}/sitemaps/active-jobs.xml`,
  // ~3x the captured part, and a parse budget that fits it (185 ms measured for 11 054 URLs).
  sitemapLimits: sitemapLimits(8 * 1024 * 1024, 1000),
  jobUrl: /^https:\/\/justjoin\.it\/job-offer\/([a-z0-9-]{1,200})$/,
  order: 'LASTMOD',
  sitemapPart: /^https:\/\/justjoin\.it\/sitemaps\/active-jobs\/part\d{1,3}\.xml$/,
  descriptionKind: 'html',
  createdAtMs: lastmodCreatedAtMs,
  select: selectByCanonical,
  applyUrl: justJoinApplyUrl,
}

const configSchema = sitemapConfigSchema(JUSTJOIN_NAMESPACE, 'JustJoin.it')

export function createJustJoinProvider(
  bounds: SitemapJsonLdBounds = JUSTJOIN_BOUNDS,
  deps: SitemapJsonLdDeps = { sleep: realSleep, random: Math.random },
) {
  // Stryker disable next-line StringLiteral,ObjectLiteral: manifest.drift.spec.ts reads this literal from the source text; instrumenting it hides the type from that scan, and the registry specs pin the type
  return definePagedProvider({ type: 'JUSTJOIN_HTML', configSchema }, (config, ctx) =>
    collectSitemapJsonLd(JUSTJOIN_SITE, bounds, deps, config, ctx),
  )
}

export const justJoinProvider = createJustJoinProvider()

/** The hosts this adapter's requests may reach: the site and the CDN its sitemaps redirect to. */
export const justJoinAllowedHosts = (): readonly string[] => [JUSTJOIN_HOST, JUSTJOIN_SITEMAP_HOST]
