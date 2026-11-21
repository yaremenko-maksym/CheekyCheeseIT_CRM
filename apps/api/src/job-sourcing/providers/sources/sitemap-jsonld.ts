import type { JobSourceType } from '@crm/shared'
import { z } from 'zod'
import { atsJobKey } from '../../identity/ats-job-key'
import { buildIdentity } from '../../normalize/identity-key'
import {
  buildSourceObservation,
  type RawObservationFields,
  type SourceObservation,
} from '../../normalize/observation'
import { type Random, jitteredGapMs } from '../../scheduling/jitter'
import {
  extractJobPostings,
  type IdentitySelection,
  type JsonLdJobPosting,
} from '../../structuring/json-ld'
import { xmlPort } from '../../xml/bounded-xml-port'
import { DEFAULT_XML_LIMITS } from '../../xml/xml-limits'
import type { XmlElementNode, XmlLimits } from '../../xml/xml-port'
import { findChildren } from '../../xml/xml-tree'
import { baseSourceConfigSchema } from '../api-json.provider'
import { type Sleep } from '../html/html-ports'
import {
  buildCollectionBatch,
  buildInvalidSample,
  buildRequestReport,
  type CollectionContext,
  type CollectionCounts,
  type InvalidSample,
  type RequestReport,
  type StopReason,
  type ValidatedCheckpoint,
} from '../reporting-provider'
import { decodeXmlBody } from '../xml-source.provider'
import { createMeteredFetch, type Failure } from './metered-fetch'

/**
 * The sitemap + JSON-LD adapter (sources-12, generalised in sources-13): a job board that lists
 * every posting in a sitemap and describes each on its own page with one JSON-LD `JobPosting`.
 * Parsed deterministically; no model. Next Level Jobs, The Hub, JustJoin.it and Landing.jobs are
 * each one `SitemapJsonLdSite` on it; only what really differs between them is a field here.
 *
 * A DELTA SOURCE. A run reads the sitemap, asks the store which postings it already holds
 * (`ctx.heldIdentityKeys`), and fetches the detail page of at most `maxDetails` of the rest, in the
 * site's own newest-first order. A held posting is never re-fetched.
 *
 * COVERAGE IS NEVER FULL. The run reads the sitemap whole but the details of only the unseen part,
 * so it ends `PAGE_CAP` with no query: SUCCEEDED, PARTIAL coverage. It must never claim
 * FULL_INVENTORY or WINDOW, because the postings it did not re-read would then be closed or
 * expired by the availability reconcilers.
 */

/** The most child sitemaps a sitemap index may name, each one request. */
export const MAX_SITEMAP_PARTS = 2

export interface SitemapJob {
  readonly id: string
  readonly url: string
  /** Epoch ms of `<lastmod>`, read only for a site ordered by it (`null`: absent or unparseable). */
  readonly lastmod?: number | null
}

export type SitemapResult =
  | { readonly ok: true; readonly jobs: SitemapJob[] }
  | { readonly ok: false; readonly message: string }

export interface SitemapJsonLdSite {
  readonly type: JobSourceType
  readonly adapterVersion: string
  readonly namespace: string
  readonly sitemapUrl: string
  /** The sitemap's limits: its byte cap and, for a large one, a wider parse budget. */
  readonly sitemapLimits: XmlLimits
  /** A job page URL; group 1 is its native id. Any other `<loc>` is skipped. */
  readonly jobUrl: RegExp
  /** `ID`: the id sorts by creation (descending). `LASTMOD`: by `<lastmod>`, newest first. */
  readonly order: 'ID' | 'LASTMOD'
  /** The child sitemaps a `<sitemapindex>` may name. Absent: an index is drift. */
  readonly sitemapPart?: RegExp
  readonly descriptionKind: 'html' | 'text'
  /** The page's posting for this job (the JSON-LD rarely carries the same key on every site). */
  readonly select: (
    postings: JsonLdJobPosting[],
    job: SitemapJob,
    html: string,
  ) => IdentitySelection
  /** The employer's original posting the page links, when the site has one (dedup); else null. */
  readonly applyUrl?: (html: string) => string | null
}

export interface SitemapJsonLdBounds {
  /** Detail pages fetched per run, at most. */
  readonly maxDetails: number
  /** The floor of the gap before every request after the first. */
  readonly minGapMs: number
}

export interface SitemapJsonLdDeps {
  readonly sleep: Sleep
  readonly random: Random
}

/**
 * The ONE ATS-hosted job every candidate apply link names, or null: none, a link that is not an
 * ATS-hosted job, or two distinct jobs. A wrong apply URL would merge two postings, so any doubt
 * answers null (dedup lost for that posting, never poisoned).
 */
export function oneAtsHostedJob(urls: Iterable<string>): string | null {
  const found = new Map<string, string>()
  for (const url of urls) {
    const key = atsJobKey(url)
    if (key === null || key.scope !== 'ATS_HOSTED') return null
    if (!found.has(key.key)) found.set(key.key, url)
  }
  return found.size === 1 ? [...found.values()][0]! : null
}

/** A site's config: its namespace and the base fields, no query, no window. */
export function sitemapConfigSchema(namespace: string, name: string) {
  return baseSourceConfigSchema
    .extend({ namespace: z.literal(namespace).default(namespace) })
    .strict()
    .refine((c) => c.query === null, { message: `${name} has no search parameter` })
    .refine((c) => c.window === null, { message: `${name} has no date window` })
}

interface SiteConfig {
  readonly namespace: string
  readonly configVersion: number
}

/** The default limits with another byte cap (and optionally parse budget). */
export function sitemapLimits(maxBytes: number, maxWallClockMs?: number): XmlLimits {
  return {
    ...DEFAULT_XML_LIMITS,
    maxBytes,
    ...(maxWallClockMs === undefined ? {} : { maxWallClockMs }),
  }
}

type Decoded =
  | { readonly ok: true; readonly root: XmlElementNode }
  | { readonly ok: false; readonly message: string }

function decode(site: SitemapJsonLdSite, bodyText: string): Decoded {
  const decoded = decodeXmlBody(bodyText, site.sitemapLimits, xmlPort)
  return decoded.ok
    ? { ok: true, root: decoded.value.root }
    : { ok: false, message: decoded.message }
}

function jobsOf(site: SitemapJsonLdSite, root: XmlElementNode): SitemapResult {
  if (root.localName !== 'urlset') return { ok: false, message: `root is <${root.localName}>` }
  const seen = new Set<string>()
  const jobs: SitemapJob[] = []
  for (const entry of findChildren(root, 'url')) {
    const loc = findChildren(entry, 'loc')[0]
    // Stryker disable next-line StringLiteral: any fallback fails jobUrl the same way; the missing-<loc> case is tested
    const url = loc?.text.trim() ?? ''
    const id = site.jobUrl.exec(url)?.[1]
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    if (site.order === 'LASTMOD') {
      const raw = findChildren(entry, 'lastmod')[0]?.text.trim()
      // Stryker disable next-line ConditionalExpression: equivalent, Date.parse(undefined) is NaN too
      const ms = raw === undefined ? Number.NaN : Date.parse(raw)
      jobs.push({ id, url, lastmod: Number.isNaN(ms) ? null : ms })
    } else {
      jobs.push({ id, url })
    }
  }
  return { ok: true, jobs }
}

/** Every job URL of a `<urlset>` sitemap, once each, in document order. A non-job `<loc>` is skipped. */
export function parseSitemapOf(site: SitemapJsonLdSite, bodyText: string): SitemapResult {
  const decoded = decode(site, bodyText)
  return decoded.ok ? jobsOf(site, decoded.root) : decoded
}

/** The child sitemaps a `<sitemapindex>` names that the site allows, at most `MAX_SITEMAP_PARTS`. */
export function sitemapPartsOf(pattern: RegExp, root: XmlElementNode): string[] {
  const parts: string[] = []
  for (const entry of findChildren(root, 'sitemap')) {
    // Stryker disable next-line StringLiteral: any fallback fails the pattern the same way
    const url = findChildren(entry, 'loc')[0]?.text.trim() ?? ''
    if (pattern.test(url) && !parts.includes(url)) parts.push(url)
  }
  return parts.slice(0, MAX_SITEMAP_PARTS)
}

/** The identity key a record of this posting is stored under (the same encoder the store uses). */
export function siteIdentityKey(site: SitemapJsonLdSite, id: string): string {
  const built = buildIdentity({
    provider: site.type,
    namespace: site.namespace,
    nativeId: id,
    url: null,
  })
  // Stryker disable next-line ConditionalExpression,StringLiteral: a jobUrl-matched id under a constant namespace always builds; the throw (and its message) guards the encoder, not the input
  if (!built.ok) throw new Error(`no identity for ${id}: ${built.reason}`)
  return built.identity.identityKey
}

const byLastmod = (a: SitemapJob, b: SitemapJob) =>
  (b.lastmod ?? Number.NEGATIVE_INFINITY) - (a.lastmod ?? Number.NEGATIVE_INFINITY)

/** The jobs not held yet, newest first in the site's order, at most `max`. */
export function unseenNewestFirstOf(
  site: SitemapJsonLdSite,
  jobs: readonly SitemapJob[],
  heldKeys: ReadonlySet<string>,
  max: number,
): SitemapJob[] {
  const unseen = jobs.filter((j) => !heldKeys.has(siteIdentityKey(site, j.id)))
  // Lowercase hex ids: collation order is code-point order. A ternary comparator here has mutants
  // V8's insertion sort cannot tell apart (a 0 for "less" sorts the same as a 1). A lastmod tie
  // keeps document order (the sort is stable).
  const sorted =
    site.order === 'ID' ? unseen.sort((a, b) => b.id.localeCompare(a.id)) : unseen.sort(byLastmod)
  return sorted.slice(0, max)
}

const CANONICAL_LINK = /<link\b[^>]*\brel="canonical"[^>]*>/
const HREF = /\bhref="([^"]{1,2000})"/

/** The page's `<link rel="canonical">` href, or null. */
export function canonicalUrlOf(html: string): string | null {
  const tag = CANONICAL_LINK.exec(html)?.[0]
  // Stryker disable next-line ConditionalExpression: equivalent, HREF.exec(undefined) reads "undefined" and matches nothing
  return tag === undefined ? null : (HREF.exec(tag)?.[1] ?? null)
}

/**
 * For a page whose JSON-LD names neither an identifier nor a url (JustJoin.it): the page's one
 * posting, only when the page's canonical link IS the sitemap URL. Two postings: ambiguous.
 */
export function selectByCanonical(
  postings: JsonLdJobPosting[],
  job: SitemapJob,
  html: string,
): IdentitySelection {
  const first = postings[0]
  if (first === undefined || canonicalUrlOf(html) !== job.url) return { kind: 'none' }
  if (postings.length > 1) return { kind: 'ambiguous', count: postings.length }
  return { kind: 'match', posting: first }
}

/** The page's JobPosting, mapped. */
export function mapSitePosting(
  site: SitemapJsonLdSite,
  posting: JsonLdJobPosting,
  job: SitemapJob,
  applyUrl: string | null,
): RawObservationFields {
  return {
    provider: site.type,
    adapterVersion: site.adapterVersion,
    namespace: site.namespace,
    nativeId: job.id,
    url: applyUrl ?? posting.url ?? job.url,
    title: posting.title,
    companyName: posting.hiringOrganization,
    location: posting.jobLocations.length > 0 ? posting.jobLocations.join('; ') : null,
    description: posting.description,
    descriptionKind: site.descriptionKind,
    remote: posting.jobLocationType === 'TELECOMMUTE' ? true : null,
    employmentType: posting.employmentType[0] ?? null,
    tags: posting.skills,
    applicationUrl: applyUrl,
    dates: [
      ...(posting.datePosted === null
        ? []
        : [
            {
              raw: posting.datePosted.raw,
              contract: 'ISO_ZONED' as const,
              semantics: 'PUBLISHED' as const,
            },
          ]),
      ...(posting.validThrough === null
        ? []
        : [
            {
              raw: posting.validThrough.raw,
              contract: 'ISO_ZONED' as const,
              semantics: 'EXPIRY' as const,
            },
          ]),
    ],
  }
}

/** A sitemap read: its jobs, or (an index) the child sitemaps still to read. */
interface Listing {
  readonly ok: true
  readonly jobs: SitemapJob[]
  readonly parts: string[]
}

function readListing(
  site: SitemapJsonLdSite,
  bodyText: string,
  partPattern: RegExp | undefined,
): Listing | { readonly ok: false; readonly message: string } {
  const decoded = decode(site, bodyText)
  if (!decoded.ok) return decoded
  if (partPattern !== undefined && decoded.root.localName === 'sitemapindex') {
    const parts = sitemapPartsOf(partPattern, decoded.root)
    if (parts.length === 0)
      return { ok: false, message: 'the index names no allowed child sitemap' }
    return { ok: true, jobs: [], parts }
  }
  const listed = jobsOf(site, decoded.root)
  return listed.ok ? { ok: true, jobs: listed.jobs, parts: [] } : listed
}

const emptyCounts = (): CollectionCounts => ({
  raw: 0,
  normalized: 0,
  invalid: 0,
  quarantined: 0,
  discarded: 0,
})

const scopeOf = (config: SiteConfig) => ({
  namespace: config.namespace,
  query: null,
  configVersion: config.configVersion,
  window: null,
})

/** One run of a site: the sitemap (and its parts), then the unseen details. */
export async function collectSitemapJsonLd(
  site: SitemapJsonLdSite,
  bounds: SitemapJsonLdBounds,
  deps: SitemapJsonLdDeps,
  config: SiteConfig,
  ctx: CollectionContext,
) {
  const scope = scopeOf(config)
  const observations: SourceObservation[] = []
  const requests: RequestReport[] = []
  const samples: InvalidSample[] = []
  const counts = emptyCounts()
  let checkpoint: ValidatedCheckpoint | null = null
  let pagesCompleted = 0
  let stop: StopReason = 'PAGE_CAP'

  const report = (
    at: number,
    url: string,
    status: number | null,
    startedAt: Date,
    cost: RequestReport['cost'],
    error: Failure | null,
  ) =>
    requests.push(
      buildRequestReport(
        {
          attempt: 1,
          page: at,
          url,
          status,
          startedAt,
          endedAt: ctx.now(),
          cost,
          error: error === null ? null : { code: error.code, message: error.message },
        },
        ctx.secrets,
      ),
    )
  // Stryker disable next-line ConditionalExpression: a backstop the run never reaches; a site without parts makes at most 1 + maxDetails requests whatever this adds
  const listRequests = 1 + (site.sitemapPart === undefined ? 0 : MAX_SITEMAP_PARTS)
  const metered = createMeteredFetch(ctx, listRequests + bounds.maxDetails, report)
  const finish = () =>
    buildCollectionBatch({
      observations,
      // Every run lists the sitemap whole and never resumes from a stored position. It always ends
      // on PAGE_CAP or a failure, so its coverage is PARTIAL whatever this flag says.
      // Stryker disable next-line BooleanLiteral: unobservable, see above (deriveCoverage)
      facts: { stop, pagesCompleted, counts, scope, resumed: false },
      requests,
      checkpoint,
      invalidSamples: samples,
    })
  let page = 1
  /**
   * One sitemap document: fetched, decoded and read as a job list (or, given `partPattern`, as an index
   * of child sitemaps), with exactly ONE request report. null when the run must stop.
   */
  const readSitemap = async (
    url: string,
    partPattern: RegExp | undefined,
  ): Promise<Listing | null> => {
    if (page > 1) {
      try {
        await deps.sleep(jitteredGapMs(bounds.minGapMs, deps.random), ctx.signal)
      } catch {
        report(page, url, null, ctx.now(), null, {
          code: 'CANCELLED',
          message: 'the run was cancelled before this request',
          status: null,
        })
        stop = 'CANCELLED'
        return null
      }
    }
    const listed = await metered(
      page,
      { url, headers: { accept: 'application/xml' }, maxBytes: site.sitemapLimits.maxBytes },
      false,
    )
    if (!listed.ok) {
      stop = listed.stop
      return null
    }
    const read = readListing(site, listed.bodyText, partPattern)
    report(
      page,
      url,
      listed.status,
      listed.startedAt,
      listed.cost,
      read.ok
        ? null
        : { code: 'PARSE_DRIFT', message: `sitemap: ${read.message}`, status: listed.status },
    )
    if (!read.ok) {
      stop = 'ERROR'
      return null
    }
    return read
  }

  const first = await readSitemap(site.sitemapUrl, site.sitemapPart)
  if (first === null) return finish()
  const jobs = first.jobs
  const seen = new Set<string>()
  for (const part of first.parts) {
    page += 1
    const listed = await readSitemap(part, undefined)
    if (listed === null) return finish()
    for (const j of listed.jobs) {
      if (seen.has(j.id)) continue
      seen.add(j.id)
      jobs.push(j)
    }
  }
  const sitemapUrl = site.sitemapUrl

  let held: ReadonlySet<string>
  try {
    held = (await ctx.heldIdentityKeys?.(jobs.map((j) => siteIdentityKey(site, j.id)))) ?? new Set()
  } catch (error) {
    report(page, sitemapUrl, null, ctx.now(), null, {
      code: 'PERSISTENCE',
      message: `the held postings could not be read: ${error instanceof Error ? error.message : 'the store failed'}`,
      status: null,
    })
    stop = 'ERROR'
    return finish()
  }

  for (const job of unseenNewestFirstOf(site, jobs, held, bounds.maxDetails)) {
    page += 1
    try {
      await deps.sleep(jitteredGapMs(bounds.minGapMs, deps.random), ctx.signal)
    } catch {
      report(page, job.url, null, ctx.now(), null, {
        code: 'CANCELLED',
        message: 'the run was cancelled before this request',
        status: null,
      })
      stop = 'CANCELLED'
      break
    }
    const fetched = await metered(page, { url: job.url, headers: { accept: 'text/html' } }, true)
    if (!fetched.ok) {
      stop = fetched.stop
      break
    }
    report(page, job.url, fetched.status, fetched.startedAt, fetched.cost, null)
    // A 404 is an answer: the posting left between the sitemap and its page. Nothing to record.
    if (fetched.status === 404) continue
    counts.raw += 1
    const selected = site.select(
      extractJobPostings(fetched.bodyText, { now: ctx.now() }).postings,
      job,
      fetched.bodyText,
    )
    if (selected.kind !== 'match') {
      counts.invalid += 1
      samples.push(
        buildInvalidSample(page, `json-ld: ${selected.kind}`, { url: job.url }, ctx.secrets),
      )
      continue
    }
    const applyUrl = site.applyUrl?.(fetched.bodyText) ?? null
    const built = buildSourceObservation(mapSitePosting(site, selected.posting, job, applyUrl), {
      now: ctx.now(),
    })
    if (!built.ok) {
      counts.quarantined += 1
      samples.push(buildInvalidSample(page, built.reason, { url: job.url }, ctx.secrets))
      continue
    }
    const next: ValidatedCheckpoint = {
      configVersion: config.configVersion,
      policyVersion: ctx.policyVersion,
      adapterVersion: site.adapterVersion,
      position: { kind: 'RESTART', page },
      completedAt: ctx.now(),
    }
    try {
      await ctx.checkpoints.savePage({ observations: [built.observation], checkpoint: next })
    } catch (error) {
      counts.discarded += 1
      report(page, job.url, fetched.status, ctx.now(), null, {
        code: 'PERSISTENCE',
        message: error instanceof Error ? error.message : 'the page could not be persisted',
        status: fetched.status,
      })
      stop = 'ERROR'
      break
    }
    counts.normalized += 1
    observations.push(built.observation)
    checkpoint = next
    pagesCompleted += 1
  }
  // Drift, not bad luck: most pages read had no usable posting. Fails the run so health sees it.
  if (stop === 'PAGE_CAP' && counts.invalid > counts.normalized && counts.invalid >= 3) {
    report(page, sitemapUrl, null, ctx.now(), null, {
      code: 'PARSE_DRIFT',
      message: `${counts.invalid} of ${counts.raw} job pages had no matching JSON-LD JobPosting`,
      status: null,
    })
    stop = 'ERROR'
  }
  return finish()
}
