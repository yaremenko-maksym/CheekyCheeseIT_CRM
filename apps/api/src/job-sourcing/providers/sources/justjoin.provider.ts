import { MAX_XML_ELEMENTS } from '../../xml/xml-limits'
import { definePagedProvider } from '../api-json.provider'
import { MIN_HOST_GAP_MS, realSleep } from '../html/html-ports'
import {
  collectSitemapJsonLd,
  lastmodCreatedAtMs,
  oneAtsHostedJob,
  selectByCanonical,
  sitemapConfigSchema,
  type SitemapJsonLdBounds,
  type SitemapJob,
  type SitemapJsonLdDeps,
  type SitemapJsonLdSite,
  sitemapLimits,
} from './sitemap-jsonld'

/**
 * JustJoin.it (Poland) on the sitemap + JSON-LD adapter (task sources-13).
 *
 * The active-jobs sitemap is an INDEX: `justjoin.it/sitemaps/active-jobs.xml` redirects to
 * `public.justjoin.com/justjoinit/sitemaps/active-jobs.xml`, which names
 * `justjoin.it/sitemaps/active-jobs/part0.xml`, which redirects to the same CDN host. The part is
 * large (2.6 MB, 11 054 job URLs on 2026-11-21), so it gets its own byte cap, element cap and a
 * parse budget of 1.0 s, i.e. a 100 000-item ceiling (about 1.8x the part; see `JUSTJOIN_SITE`).
 * `<lastmod>` is the REFRESH time (6 378 entries on the capture day) and orders the postings.
 *
 * The page's JSON-LD `JobPosting` has neither `identifier` nor `url`, so it is selected by the
 * page's canonical URL, which must equal the job URL. The page payload names the employer's
 * application form as `applyUrl`; when that is one ATS-hosted job it is the posting URL (ATS
 * dedup), else the JustJoin page is. An offer that applies through JustJoin's own form writes
 * `applyUrl: null`. SALARY (sources-17) is the JSON-LD `baseSalary` (the capture: PLN, HOUR,
 * 120-140), read by the shared JSON-LD parser.
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

export const JUSTJOIN_ADAPTER_VERSION = 'justjoin-2'
export const JUSTJOIN_HOST = 'justjoin.it'
export const JUSTJOIN_SITEMAP_HOST = 'public.justjoin.com'
export const JUSTJOIN_NAMESPACE = 'justjoin'
export const JUSTJOIN_ENDPOINT_VARIANT = 'jobs-sitemap'

/** The index, at most two parts, and 20 detail pages (~650 KB each) per run. */
export const JUSTJOIN_BOUNDS: SitemapJsonLdBounds = { maxDetails: 20, minGapMs: MIN_HOST_GAP_MS }

/**
 * The employer's application link in the page payload (escaped once inside a script string), tied
 * to the offer it belongs to. The ~650 KB payload holds other offers too, so a bare `applyUrl` could
 * be a similar offer's (CR-M-1, PR #1444). In every captured page (2026-11-21) the offer object
 * writes `applyUrl`, `publishedAt`, `lastPublishedAt`, `coverImage` in that order, and the cover
 * image URL ends in the offer's slug: group 2. Another key order reads nothing (dedup lost, never
 * poisoned). The payload writes `&` as `\u0026`, the only backslash sequence a URL in it carries.
 */
const APPLY_URL =
  /\\"applyUrl\\":\\"(https:\/\/(?:[^"\\\s]|\\u0026){1,2000})\\",\\"publishedAt\\":\\"[^"\\]{1,40}\\",\\"lastPublishedAt\\":\\"[^"\\]{1,40}\\",\\"coverImage\\":\\"https:\/\/og-image\.justjoin\.it\/ogimage\/justjoinit\/([a-z0-9-]{1,200})\\"/gi

/** The one ATS-hosted job this offer's own `applyUrl` names, or null (another offer's is ignored). */
export function justJoinApplyUrl(html: string, job: SitemapJob): string | null {
  return oneAtsHostedJob(
    [...html.matchAll(APPLY_URL)]
      .filter((match) => match[2]!.toLowerCase() === job.id)
      .map((match) => match[1]!.replaceAll('\\u0026', '&')),
  )
}

export const JUSTJOIN_SITE: SitemapJsonLdSite = {
  type: 'JUSTJOIN_HTML',
  adapterVersion: JUSTJOIN_ADAPTER_VERSION,
  namespace: JUSTJOIN_NAMESPACE,
  // The site's own URL (it redirects to the CDN), so the host key `justjoin.it` scopes every
  // request the adapter itself makes; the transport follows the redirect to the CDN host.
  sitemapUrl: `https://${JUSTJOIN_HOST}/sitemaps/active-jobs.xml`,
  // The captured part: 2 645 173 bytes, 11 054 URLs of 5 elements each = 55 271 elements, 55 272
  // items with the xmlns attribute. 8 MiB bytes (3.2x, under the 10 MiB ceiling); a 1 000 ms budget
  // = 100 000 items (about 1.8x the part); 100 000 elements = MAX_XML_ELEMENTS, the global memory cap.
  // shortcut: about 1.8x over the measured part; past ~20k active jobs every run fails loud as PARSE_DRIFT. Upgrade to a streaming parse (or parse in the extraction worker) before raising the caps.
  sitemapLimits: sitemapLimits(8 * 1024 * 1024, 1000, MAX_XML_ELEMENTS),
  jobUrl: /^https:\/\/justjoin\.it\/job-offer\/([a-z0-9-]{1,200})$/i,
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
