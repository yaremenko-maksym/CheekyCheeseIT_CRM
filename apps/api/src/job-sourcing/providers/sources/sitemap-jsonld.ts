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
  /**
   * When the posting was created, as far as the sitemap says (null: unknown). A bad page counts
   * toward drift only while its posting is younger than `DRIFT_WINDOW_MS` (CR-L-1, PR #1443).
   */
  readonly createdAtMs: (job: SitemapJob) => number | null
  /** The page's posting for this job (the JSON-LD rarely carries the same key on every site). */
  readonly select: (
    postings: JsonLdJobPosting[],
    job: SitemapJob,
    html: string,
  ) => IdentitySelection
  /**
   * The employer's original posting the page links for THIS job, when the site has one (dedup);
   * else null. `job` carries the identity URL and the lower-cased id.
   */
  readonly applyUrl?: (html: string, job: SitemapJob) => string | null
  /**
   * Whether the page carries the site's apply button, for a site that always has one (D-3, PR
   * #1443). A posting read whole without it leaves an `apply-button: none` sample: a renamed button
   * would otherwise stop ATS dedup silently. Absent: the site has no such notion, no sample.
   */
  readonly hasApplyButton?: (html: string) => boolean
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

/** The default limits with another byte cap (and optionally parse budget and element cap). */
export function sitemapLimits(
  maxBytes: number,
  maxWallClockMs?: number,
  maxElements?: number,
): XmlLimits {
  return {
    ...DEFAULT_XML_LIMITS,
    maxBytes,
    ...(maxWallClockMs === undefined ? {} : { maxWallClockMs }),
    ...(maxElements === undefined ? {} : { maxElements }),
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
    const listedId = site.jobUrl.exec(url)?.[1]
    if (listedId === undefined) continue
    // The id is the identity: one spelling of it, whatever case the sitemap lists.
    const id = listedId.toLowerCase()
    if (seen.has(id)) continue
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
export function siteIdentityKey(
  site: Pick<SitemapJsonLdSite, 'type' | 'namespace'>,
  id: string,
): string {
  const built = buildIdentity({
    provider: site.type,
    namespace: site.namespace,
    nativeId: id,
    url: null,
  })
  // A sitemap id always builds; an id with no identity (the empty one) throws, and a spec pins it.
  if (!built.ok) throw new Error(`no identity for ${id}: ${built.reason}`)
  return built.identity.identityKey
}

/**
 * The URL a posting is matched by: the id part spelled as `jobsOf` keys it, lower-cased (D-4, PR
 * #1443). A URL that is not a job page is returned as is. The fetch keeps the sitemap's spelling.
 */
export function identityUrlOf(site: SitemapJsonLdSite, url: string): string {
  const id = site.jobUrl.exec(url)?.[1]
  return id === undefined ? url : `${url.slice(0, -id.length)}${id.toLowerCase()}`
}

const byLastmod = (a: SitemapJob, b: SitemapJob) =>
  (b.lastmod ?? Number.NEGATIVE_INFINITY) - (a.lastmod ?? Number.NEGATIVE_INFINITY)

const HOUR_MS = 3_600_000
/** One detail slot in this many turns through the unseen jobs below the newest (CR-L-1). */
const TURNING_SHARE = 5
/** A bad page counts toward drift only while its posting is younger than this (CR-L-1). */
export const DRIFT_WINDOW_MS = 24 * HOUR_MS

/** A 24-hex id that starts with Unix seconds (a MongoDB ObjectId): its first 8 digits. */
export const hexIdCreatedAtMs = (job: SitemapJob): number => parseInt(job.id.slice(0, 8), 16) * 1000

/**
 * A site whose ids carry no time: the `<lastmod>`. It is the last change, not the creation, so a
 * page edited today counts as new; the error is toward reporting drift, never toward hiding it.
 */
export const lastmodCreatedAtMs = (job: SitemapJob): number | null => job.lastmod ?? null

/**
 * The jobs not held yet to read this run, at most `max`: the newest first in the site's order,
 * plus one slot in `TURNING_SHARE` for the unseen jobs below them, taken at an offset the run draws
 * (`turn`, in [0, 1)). A wall-clock offset aliased with the 2 h / 6 h schedule and never reached
 * some jobs (D-1, PR #1443).
 *
 * Why the turning slots (CR-L-1, PR #1443): a page that keeps failing (a 404, or a 200 without its
 * JSON-LD) is never held, so it is unseen again on the next run. Newest first alone lets enough
 * such jobs at the top fill every slot of every run, and nothing below them would ever be read.
 *
 * shortcut: the adapter keeps no record of which jobs failed before, so it cannot skip them; the
 * turning slots only guarantee the rest is still reached. Upgrade to a per-id failure ledger if
 * stuck jobs ever crowd out the newest slots.
 */
export function detailsToReadOf(
  site: SitemapJsonLdSite,
  jobs: readonly SitemapJob[],
  heldKeys: ReadonlySet<string>,
  max: number,
  turn: number,
): SitemapJob[] {
  const unseen = jobs.filter((j) => !heldKeys.has(siteIdentityKey(site, j.id)))
  // Lowercase hex ids: collation order is code-point order. A ternary comparator here has mutants
  // V8's insertion sort cannot tell apart (a 0 for "less" sorts the same as a 1). A lastmod tie
  // keeps document order (the sort is stable).
  const sorted =
    site.order === 'ID' ? unseen.sort((a, b) => b.id.localeCompare(a.id)) : unseen.sort(byLastmod)
  return turningSelectionOf(sorted, max, turn)
}

/**
 * At most `max` of `sorted` (newest first): the head, plus one slot in `TURNING_SHARE` taken from
 * the rest at the run's offset `turn` (in [0, 1)). Shared by every detail loop (S1, PR #1445).
 */
export function turningSelectionOf<J>(sorted: readonly J[], max: number, turn: number): J[] {
  const turning = Math.floor(max / TURNING_SHARE)
  const below = sorted.slice(max - turning)
  const start = Math.floor(turn * below.length)
  return [
    ...sorted.slice(0, max - turning),
    ...Array.from(
      { length: Math.min(turning, below.length) },
      (_, i) => below[(start + i) % below.length]!,
    ),
  ]
}

/**
 * Whether a bad page of a posting created at `createdAtMs` counts toward drift: only while the
 * posting is under `DRIFT_WINDOW_MS` old. Unknown age counts; a future-dated one (negative age) is
 * not recent, not inside the window.
 */
export function countsTowardDrift(createdAtMs: number | null, nowMs: number): boolean {
  const ageMs = createdAtMs === null ? 0 : nowMs - createdAtMs
  return ageMs >= 0 && ageMs < DRIFT_WINDOW_MS
}

/** Drift, not bad luck: most pages read were bad and recent, and at least three of them. */
export const isDetailDrift = (recentInvalid: number, normalized: number): boolean =>
  recentInvalid > normalized && recentInvalid >= 3

const CANONICAL_REL = /\brel="canonical"/
const HREF = /\bhref="([^"]{1,2000})"/

/**
 * The page's `<link rel="canonical">` href, or null. A linear scan (SR2-M-1, PR #1445): a regex
 * spanning `<link\b[^>]*` was quadratic on a page of unclosed `<link ` (2 MiB of untrusted NFJ
 * page). Each `<link` is read up to its `>` once; a `<link` inside that span shares the same `>`,
 * so its tag is a suffix of the one already tested and the scan resumes after the `>`.
 */
export function canonicalUrlOf(html: string): string | null {
  // A fresh literal per call: its `lastIndex` is this scan's cursor.
  const open = /<link\b/g
  for (let m = open.exec(html); m !== null; m = open.exec(html)) {
    const end = html.indexOf('>', m.index)
    if (end === -1) return null
    const tag = html.slice(m.index, end + 1)
    if (CANONICAL_REL.test(tag)) return HREF.exec(tag)?.[1] ?? null
    // The `>` itself cannot open a `<link`: resuming on it reads nothing twice.
    open.lastIndex = end
  }
  return null
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
  // Drawn once, first, before any gap: this run's turning offset (D-1).
  const turn = deps.random()
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

  // Bad pages that count toward drift: only those of postings created within DRIFT_WINDOW_MS.
  let recentInvalid = 0
  const nowMs = ctx.now().getTime()
  for (const job of detailsToReadOf(site, jobs, held, bounds.maxDetails, turn)) {
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
    // shortcut: a 410 or a lasting 5xx ends the run here (shared metered fetch), so a newest job
    // that keeps answering one blocks every page after it, every run; upgrade with the backlog item.
    if (!fetched.ok) {
      stop = fetched.stop
      break
    }
    report(page, job.url, fetched.status, fetched.startedAt, fetched.cost, null)
    // A 404 is an answer: the posting left between the sitemap and its page. Nothing to record.
    if (fetched.status === 404) continue
    counts.raw += 1
    // Both sides by their normalised URL; the fetch above kept the sitemap's own spelling (D-4).
    const postings = extractJobPostings(fetched.bodyText, { now: ctx.now() }).postings.map((p) => ({
      ...p,
      url: p.url && identityUrlOf(site, p.url),
    }))
    const identityJob = { ...job, url: identityUrlOf(site, job.url) }
    const selected = site.select(postings, identityJob, fetched.bodyText)
    if (selected.kind !== 'match') {
      counts.invalid += 1
      if (countsTowardDrift(site.createdAtMs(job), nowMs)) recentInvalid += 1
      samples.push(
        buildInvalidSample(page, `json-ld: ${selected.kind}`, { url: job.url }, ctx.secrets),
      )
      continue
    }
    const applyUrl = site.applyUrl?.(fetched.bodyText, identityJob) ?? null
    const built = buildSourceObservation(
      mapSitePosting(site, selected.posting, identityJob, applyUrl),
      {
        now: ctx.now(),
      },
    )
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
    // Read whole, but no apply button: a renamed button stops ATS dedup silently (D-3).
    if (site.hasApplyButton?.(fetched.bodyText) === false) {
      samples.push(buildInvalidSample(page, 'apply-button: none', { url: job.url }, ctx.secrets))
    }
  }
  // Drift, not bad luck: most pages read had no usable posting. Fails the run so health sees it.
  // CR-L-1 (PR #1443), the choice: a bad page counts only while its posting is under a day old. A
  // page that keeps failing is never held, so it is read again every run; counted forever, a few of
  // them would fail every run once new postings are few. A real markup change breaks the new
  // postings too, and those are inside the window. A 404 never counts: it is an answer (the posting
  // left), not a page we could not read. Older bad pages still leave their invalid sample.
  if (stop === 'PAGE_CAP' && isDetailDrift(recentInvalid, counts.normalized)) {
    report(page, sitemapUrl, null, ctx.now(), null, {
      code: 'PARSE_DRIFT',
      message: `${recentInvalid} of ${counts.raw} job pages had no matching JSON-LD JobPosting`,
      status: null,
    })
    stop = 'ERROR'
  }
  return finish()
}
