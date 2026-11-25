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
 * Remote.io (remote roles, all functions) on the sitemap + JSON-LD adapter (wave 3, sitemap family).
 *
 * `https://remote.io/sitemap-active-jobs.xml` (~1.7 MB, ~7 600 jobs on the captured day) lists every
 * active job as `remote.io/remote-jobs/<category>/<slug>-<numeric id>`. Only the IT categories are
 * kept, by the URL itself, before any page is fetched: `software-development`, `devops-sysadmin`,
 * `data` and `quality-assurance`. A detail page is then read only for an IT role, so the per-run cap
 * is not spent on sales or marketing postings. `<lastmod>` is on every entry and orders the postings,
 * newest first. The JSON-LD `JobPosting` carries the numeric id as `identifier` (`value`).
 *
 * robots.txt is `User-agent: *` with `Allow: /`; the job paths are not disallowed. Remote.io's terms
 * could not be read without JavaScript (research doc, 2026-11-24).
 */

export const REMOTEIO_SOURCE_STATUS = {
  blocked: false,
  permission: 'UNCLEAR',
  reason:
    'the terms page renders only with JavaScript and could not be read; robots.txt allows the sitemap and the job pages; remote.io/sitemap-active-jobs.xml and the IT job pages it lists only, no evasion of any block',
} as const

export const REMOTEIO_ADAPTER_VERSION = 'remoteio-1'
export const REMOTEIO_HOST = 'remote.io'
export const REMOTEIO_NAMESPACE = 'remoteio'
export const REMOTEIO_ENDPOINT_VARIANT = 'jobs-sitemap'

/** One sitemap request plus 25 detail pages (~15 KB each) per run. */
export const REMOTEIO_BOUNDS: SitemapJsonLdBounds = { maxDetails: 25, minGapMs: MIN_HOST_GAP_MS }

export const REMOTEIO_SITE: SitemapJsonLdSite = {
  type: 'REMOTEIO_HTML',
  adapterVersion: REMOTEIO_ADAPTER_VERSION,
  namespace: REMOTEIO_NAMESPACE,
  sitemapUrl: `https://${REMOTEIO_HOST}/sitemap-active-jobs.xml`,
  // The captured sitemap: 1 742 490 bytes, ~7 581 URLs of 5 elements each = ~37 906 elements, plus
  // the xmlns attribute. The default 250 ms budget (25 000 items) refused it on every run. 4 MiB
  // bytes (about 2.4x); a 900 ms budget = 90 000 items (about 2.4x); elements stay under the 100 000
  // default cap. A full-size synthetic copy (7 600 URLs, 1.6 MB) parses in ~54 ms median, ~68 ms
  // worst of 7 on a dev laptop (2026-11-25), well inside the 900 ms budget.
  sitemapLimits: sitemapLimits(4 * 1024 * 1024, 900),
  jobUrl:
    /^https:\/\/remote\.io\/remote-jobs\/(?:software-development|devops-sysadmin|data|quality-assurance)\/[a-z0-9-]+-(\d+)$/,
  order: 'LASTMOD',
  descriptionKind: 'html',
  createdAtMs: lastmodCreatedAtMs,
  select: (postings, job) => selectByIdentity(postings, { identifier: job.id }),
}

const configSchema = sitemapConfigSchema(REMOTEIO_NAMESPACE, 'Remote.io')

export function createRemoteIoProvider(
  bounds: SitemapJsonLdBounds = REMOTEIO_BOUNDS,
  deps: SitemapJsonLdDeps = { sleep: realSleep, random: Math.random },
) {
  // Stryker disable next-line StringLiteral,ObjectLiteral: manifest.drift.spec.ts reads this literal from the source text; instrumenting it hides the type from that scan, and the registry specs pin the type
  return definePagedProvider({ type: 'REMOTEIO_HTML', configSchema }, (config, ctx) =>
    collectSitemapJsonLd(REMOTEIO_SITE, bounds, deps, config, ctx),
  )
}

export const remoteIoProvider = createRemoteIoProvider()

/** The one host this adapter's requests may reach; a transport is pinned to it. */
export const remoteIoAllowedHosts = (): readonly string[] => [REMOTEIO_HOST]
