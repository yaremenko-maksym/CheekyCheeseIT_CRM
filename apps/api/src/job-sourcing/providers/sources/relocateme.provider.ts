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
 * Relocate.me (relocation roles, tech-heavy) on the sitemap + JSON-LD adapter (wave 3, sitemap family).
 *
 * `https://relocate.me/sitemap-jobs.xml` (3.5 KB, 25 jobs on the captured day) lists every job page as
 * `relocate.me/<country>/<city>/<company>/<title>-<numeric id>`. `<lastmod>` is on every entry and
 * orders the postings, newest first. The JSON-LD `JobPosting` carries the numeric id as `identifier`
 * (`value`), so the posting is selected by that id. The page links no employer ATS job, so the posting
 * URL is Relocate.me's own page (ATS_COPY joins it to the employer's posting, `../../identity/resolver.ts`).
 *
 * robots.txt disallows `/api/`, `/admin/` and `/user/` only; the sitemap and the job pages are allowed.
 * The terms page is not found; the privacy policy has no automated-access clause (research doc, 2026-11-24).
 */

export const RELOCATEME_SOURCE_STATUS = {
  blocked: false,
  permission: 'UNCLEAR',
  reason:
    'the terms page is not found and the privacy policy has no automated-access clause; relocate.me/sitemap-jobs.xml and the job pages it lists only, no evasion of any block',
} as const

export const RELOCATEME_ADAPTER_VERSION = 'relocateme-1'
export const RELOCATEME_HOST = 'relocate.me'
export const RELOCATEME_NAMESPACE = 'relocateme'
export const RELOCATEME_ENDPOINT_VARIANT = 'jobs-sitemap'

/** One sitemap request plus at most 25 detail pages per run. The sitemap holds 25 postings. */
export const RELOCATEME_BOUNDS: SitemapJsonLdBounds = { maxDetails: 25, minGapMs: MIN_HOST_GAP_MS }

export const RELOCATEME_SITE: SitemapJsonLdSite = {
  type: 'RELOCATEME_HTML',
  adapterVersion: RELOCATEME_ADAPTER_VERSION,
  namespace: RELOCATEME_NAMESPACE,
  sitemapUrl: `https://${RELOCATEME_HOST}/sitemap-jobs.xml`,
  // ~600x the captured size: the cap guards against a sitemap that grows by orders of magnitude.
  sitemapLimits: sitemapLimits(2 * 1024 * 1024),
  jobUrl: /^https:\/\/relocate\.me\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+-(\d+)$/,
  order: 'LASTMOD',
  descriptionKind: 'html',
  createdAtMs: lastmodCreatedAtMs,
  select: (postings, job) => selectByIdentity(postings, { identifier: job.id }),
}

const configSchema = sitemapConfigSchema(RELOCATEME_NAMESPACE, 'Relocate.me')

export function createRelocateMeProvider(
  bounds: SitemapJsonLdBounds = RELOCATEME_BOUNDS,
  deps: SitemapJsonLdDeps = { sleep: realSleep, random: Math.random },
) {
  // Stryker disable next-line StringLiteral,ObjectLiteral: manifest.drift.spec.ts reads this literal from the source text; instrumenting it hides the type from that scan, and the registry specs pin the type
  return definePagedProvider({ type: 'RELOCATEME_HTML', configSchema }, (config, ctx) =>
    collectSitemapJsonLd(RELOCATEME_SITE, bounds, deps, config, ctx),
  )
}

export const relocateMeProvider = createRelocateMeProvider()

/** The one host this adapter's requests may reach; a transport is pinned to it. */
export const relocateMeAllowedHosts = (): readonly string[] => [RELOCATEME_HOST]
