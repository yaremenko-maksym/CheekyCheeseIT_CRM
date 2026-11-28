import type { JobSourceType } from '@crm/shared'
import {
  buildSourceObservation,
  type RawObservationFields,
  type SourceObservation,
} from '../../normalize/observation'
import { type Random, jitteredGapMs } from '../../scheduling/jitter'
import { extractJobPostings, type JsonLdJobPosting } from '../../structuring/json-ld'
import { RobotsPolicy } from '../../structuring/robots-policy'
import { hostGapMs, type Sleep } from '../html/html-ports'
import {
  buildCollectionBatch,
  buildInvalidSample,
  buildRequestReport,
  type CollectionBatch,
  type CollectionContext,
  type CollectionCounts,
  type InvalidSample,
  type RequestReport,
  type StopReason,
  type ValidatedCheckpoint,
} from '../reporting-provider'
import { createMeteredFetch, type Failure } from './metered-fetch'
import {
  isNotRobotsFile,
  MAX_REDIRECTED_DETAILS,
  ROBOTS_MAX_BYTES,
  ROBOTS_PRODUCT_TOKEN,
} from './robots-file'
import {
  countsTowardDrift,
  isDetailDrift,
  siteIdentityKey,
  turningSelectionOf,
} from './sitemap-jsonld'

export { isNotRobotsFile, MAX_REDIRECTED_DETAILS, ROBOTS_MAX_BYTES, ROBOTS_PRODUCT_TOKEN }

/**
 * A listing + JSON-LD detail run (sources-14: Dice, No Fluff Jobs). The same delta shape as Next
 * Level Jobs (sources-12), with listing PAGES in place of a sitemap:
 *
 *  1. `robots.txt` of the one host, through the metered fetch (it is counted in the budget). Any
 *     failure to read it ends the run before anything else is fetched (fail closed): a 3xx, a
 *     non-404 error, or a 200 that is not a robots file (an HTML body or a non-text/plain type).
 *  2. Each listing URL, in order, only when robots allows it; the items are deduplicated by id.
 *  3. The store is asked which items it already holds (`ctx.heldIdentityKeys`); the detail pages of
 *     at most `maxDetails` of the rest are fetched, each only when robots allows it. The rest is
 *     taken round-robin across the listing pages (one category cannot take every slot), then by
 *     the sitemap loop's own turning share (`turningSelectionOf`).
 *  4. Each detail's JSON-LD JobPosting is selected by the source's own rule and mapped.
 *
 * NO REDIRECT IS FOLLOWED (`followRedirects: false`): robots is checked on the URL we ask for, so
 * a redirect target is never requested. A detail's 3xx is an answer like its 404 (the posting is
 * gone): reported, nothing recorded. Two detail 3xx in a row (a 404 or a page between resets the
 * count) are a redirect block: the run ends `ACCESS_POLICY`. A listing's 3xx cannot be read: the
 * run fails `PARSE_DRIFT`.
 *
 * A CHALLENGE SERVED AS 200 (no status to go by) shows as detail pages with no JSON-LD posting at
 * all. Two in a row take a tiebreaker: the far end of what is still unread (the turning slot), so
 * the same bad newest pages cannot end every run before the rest is read. A bad tiebreaker (or none
 * left) ends the run as `PARSE_DRIFT`; a good one resets the streak. It is a stop, never an attempt
 * around the block.
 *
 * Every request after the first waits a jittered gap of at least `minGapMs` (or robots'
 * Crawl-delay, when larger). A URL robots refuses is never fetched: the run stops on it as
 * `ACCESS_POLICY`, because the URLs are fixed shapes robots allowed when they were chosen, so a
 * refusal means robots changed. Coverage is always PARTIAL (the run ends `PAGE_CAP`): see the Next
 * Level Jobs adapter for why it must never claim FULL_INVENTORY.
 */

export interface ListingItem {
  /** The source's own id of the posting; the record's native id. */
  readonly id: string
  /** The absolute detail page URL. */
  readonly url: string
}

export type ListingResult<T extends ListingItem> =
  | {
      readonly ok: true
      readonly items: readonly T[]
      /** Why each skipped item was refused; each becomes an invalid sample (CR-L-2). */
      readonly skipped?: readonly string[]
    }
  | { readonly ok: false; readonly message: string }

/**
 * A listing page's items with the malformed ones skipped. Drift only when the page has no valid
 * item at all or most of its items are malformed (CR-L-2, PR #1445).
 */
export function listingOf<T extends ListingItem>(
  items: readonly T[],
  skipped: readonly string[],
): ListingResult<T> {
  if (items.length === 0) return { ok: false, message: `no valid job of ${skipped.length}` }
  if (skipped.length > items.length) {
    return {
      ok: false,
      message: `${skipped.length} of ${items.length + skipped.length} jobs malformed`,
    }
  }
  return { ok: true, items, skipped }
}

/**
 * Two detail pages in a row with no JSON-LD posting at all, and then a third (the tiebreaker), end
 * the run (SR-L-2, CR2-L-1, PR #1445).
 */
export const MAX_PAGES_WITHOUT_POSTING = 2

/** The posting the page describes, or why there is none (`none`, `ambiguous`, ...). */
export type Selected =
  { readonly kind: 'match'; readonly posting: JsonLdJobPosting } | { readonly kind: string }

export interface ListingDetailSource<T extends ListingItem> {
  readonly type: JobSourceType
  readonly namespace: string
  readonly adapterVersion: string
  readonly robotsUrl: string
  readonly listingUrls: readonly string[]
  readonly listingMaxBytes: number
  /** A detail page's own cap. */
  readonly detailMaxBytes: number
  readonly parseListing: (bodyText: string) => ListingResult<T>
  readonly select: (postings: JsonLdJobPosting[], html: string, item: T) => Selected
  readonly map: (posting: JsonLdJobPosting, item: T) => RawObservationFields
  /** When the posting was created, as far as the listing says (null: unknown, which counts). */
  readonly createdAtMs: (item: T) => number | null
}

export interface ListingDetailBounds {
  /** Detail pages fetched per run, at most. */
  readonly maxDetails: number
  /** The floor of the gap before every request after the first. */
  readonly minGapMs: number
}

export interface ListingDetailDeps {
  readonly sleep: Sleep
  readonly random: Random
}

/** Every request one run may make: robots, every listing page, the detail cap. */
export const requestsOf = (listingPages: number, bounds: ListingDetailBounds): number =>
  1 + listingPages + bounds.maxDetails

/** Every listing's items, taken in turn: the first of each listing, then the second of each, ... */
export function roundRobin<T>(lists: readonly (readonly T[])[]): T[] {
  const out: T[] = []
  const longest = Math.max(0, ...lists.map((l) => l.length))
  // Stryker disable next-line EqualityOperator: one more pass at i === longest pushes nothing.
  for (let i = 0; i < longest; i += 1)
    for (const list of lists) if (i < list.length) out.push(list[i]!)
  return out
}

/** A JobPosting's `datePosted` / `validThrough`, as observation dates (zoned ISO, raw kept). */
export function jsonLdDates(posting: JsonLdJobPosting): NonNullable<RawObservationFields['dates']> {
  return [
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
  ]
}

/**
 * `metered` lets through only a 2xx, an unfollowed 3xx and (for a detail) a 404, so any status
 * from 300 up is an answer without a page: a redirect, or a posting that is gone.
 */
const isNoPage = (status: number) => status >= 300

const emptyCounts = (): CollectionCounts => ({
  raw: 0,
  normalized: 0,
  invalid: 0,
  quarantined: 0,
  discarded: 0,
})

export async function collectListingDetail<T extends ListingItem>(
  source: ListingDetailSource<T>,
  bounds: ListingDetailBounds,
  deps: ListingDetailDeps,
  config: { readonly namespace: string; readonly configVersion: number },
  ctx: CollectionContext,
): Promise<CollectionBatch> {
  const scope = {
    namespace: config.namespace,
    query: null,
    configVersion: config.configVersion,
    window: null,
  }
  const observations: SourceObservation[] = []
  const requests: RequestReport[] = []
  const samples: InvalidSample[] = []
  const counts = emptyCounts()
  let checkpoint: ValidatedCheckpoint | null = null
  let pagesCompleted = 0
  let stop: StopReason = 'PAGE_CAP'
  let at = 1
  // Drawn once per run, before anything else, like the sitemap loop's turn.
  const turn = deps.random()

  const report = (
    page: number,
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
          page,
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
  const fail = (url: string, failure: Failure, why: StopReason = 'ERROR') => {
    report(at, url, failure.status, ctx.now(), null, failure)
    stop = why
  }
  const metered = createMeteredFetch(ctx, requestsOf(source.listingUrls.length, bounds), report)
  const finish = () =>
    buildCollectionBatch({
      observations,
      // Never resumes from a stored position: always PAGE_CAP or a failure, so PARTIAL coverage.
      // Stryker disable next-line BooleanLiteral: unobservable, see above (deriveCoverage)
      facts: { stop, pagesCompleted, counts, scope, resumed: false },
      requests,
      checkpoint,
      invalidSamples: samples,
    })

  const robotsFetched = await metered(
    at,
    {
      url: source.robotsUrl,
      headers: { accept: 'text/plain' },
      maxBytes: ROBOTS_MAX_BYTES,
      followRedirects: false,
    },
    true,
  )
  if (!robotsFetched.ok) {
    stop = robotsFetched.stop
    return finish()
  }
  const notRobots =
    robotsFetched.status === 200 &&
    isNotRobotsFile(robotsFetched.bodyText, robotsFetched.headers['content-type'])
  report(
    at,
    source.robotsUrl,
    robotsFetched.status,
    robotsFetched.startedAt,
    robotsFetched.cost,
    notRobots
      ? {
          code: 'PARSE_DRIFT',
          message: 'robots: the body is not a robots.txt file',
          status: robotsFetched.status,
        }
      : null,
  )
  if (notRobots) {
    stop = 'ERROR'
    return finish()
  }
  const robots = new RobotsPolicy({
    productToken: ROBOTS_PRODUCT_TOKEN,
    fetchRobots: () =>
      Promise.resolve({
        status: robotsFetched.status,
        bodyText: robotsFetched.bodyText,
        headers: {},
        etag: null,
      }),
  })

  /** Robots, then the gap, then the request. `null` when the run must stop (already reported). */
  const politeFetch = async (url: string, maxBytes: number, accept: string, notFound: boolean) => {
    at += 1
    const check = await robots.check(url)
    if (check.verdict !== 'ALLOWED') {
      fail(url, { code: 'ACCESS_POLICY', message: `robots: ${check.reason}`, status: null })
      return null
    }
    const gapMs = Math.max(bounds.minGapMs, hostGapMs(check.crawlDelaySeconds))
    try {
      await deps.sleep(jitteredGapMs(gapMs, deps.random), ctx.signal)
    } catch {
      fail(
        url,
        { code: 'CANCELLED', message: 'the run was cancelled before this request', status: null },
        'CANCELLED',
      )
      return null
    }
    // An unfollowed 3xx comes back as itself; the caller decides what it means.
    const fetched = await metered(
      at,
      { url, headers: { accept }, maxBytes, followRedirects: false },
      notFound,
      true,
    )
    if (!fetched.ok) {
      stop = fetched.stop
      return null
    }
    return fetched
  }

  const seen = new Set<string>()
  const lists: T[][] = []
  for (const url of source.listingUrls) {
    const listed = await politeFetch(url, source.listingMaxBytes, 'text/html', false)
    if (listed === null) return finish()
    const parsed: ListingResult<T> = isNoPage(listed.status)
      ? { ok: false, message: `redirected (HTTP ${listed.status})` }
      : source.parseListing(listed.bodyText)
    report(
      at,
      url,
      listed.status,
      listed.startedAt,
      listed.cost,
      parsed.ok
        ? null
        : { code: 'PARSE_DRIFT', message: `listing: ${parsed.message}`, status: listed.status },
    )
    if (!parsed.ok) {
      stop = 'ERROR'
      return finish()
    }
    for (const reason of parsed.skipped ?? []) {
      samples.push(buildInvalidSample(at, `listing: ${reason}`, { url }, ctx.secrets))
    }
    const fresh = parsed.items.filter((item) => !seen.has(item.id))
    for (const item of fresh) seen.add(item.id)
    lists.push(fresh)
  }
  const items = roundRobin(lists)

  const keyOf = (item: T) => siteIdentityKey(source, item.id)
  let held: ReadonlySet<string>
  try {
    held = (await ctx.heldIdentityKeys?.(items.map(keyOf))) ?? new Set()
  } catch (error) {
    fail(source.robotsUrl, {
      code: 'PERSISTENCE',
      message: `the held postings could not be read: ${error instanceof Error ? error.message : 'the store failed'}`,
      status: null,
    })
    return finish()
  }

  const due = turningSelectionOf(
    items.filter((i) => !held.has(keyOf(i))),
    bounds.maxDetails,
    turn,
  )
  // Bad pages that count toward drift: only those of postings created within DRIFT_WINDOW_MS.
  let recentInvalid = 0
  let withoutPosting = 0
  // Whether the current streak already took its tiebreaker (CR2-L-1).
  let tieTaken = false
  let redirects = 0
  const nowMs = ctx.now().getTime()
  for (let item = due.shift(); item !== undefined; item = due.shift()) {
    const fetched = await politeFetch(item.url, source.detailMaxBytes, 'text/html', true)
    if (fetched === null) break
    // A 404 or an unfollowed 3xx is an answer: the posting left between the listing and its page.
    // Nothing to record, and its target is never requested. Redirects in a row are a block.
    if (isNoPage(fetched.status)) {
      // `metered` lets through only an unfollowed 3xx or a 404 here.
      redirects = fetched.status === 404 ? 0 : redirects + 1
      const blocked = redirects >= MAX_REDIRECTED_DETAILS
      report(
        at,
        item.url,
        fetched.status,
        fetched.startedAt,
        fetched.cost,
        blocked
          ? {
              code: 'ACCESS_POLICY',
              message: `${redirects} job pages in a row answered with a redirect (HTTP ${fetched.status})`,
              status: fetched.status,
            }
          : null,
      )
      if (!blocked) continue
      stop = 'ERROR'
      break
    }
    redirects = 0
    counts.raw += 1
    const postings = extractJobPostings(fetched.bodyText, { now: ctx.now() }).postings
    withoutPosting = postings.length === 0 ? withoutPosting + 1 : 0
    if (withoutPosting === 0) tieTaken = false
    // A stuck head (the same newest pages bad on every run, never held) must not starve the run:
    // at the streak, the far end of what is unread (the turning slot) breaks the tie first.
    const drifted = withoutPosting >= MAX_PAGES_WITHOUT_POSTING && (tieTaken || due.length === 0)
    report(
      at,
      item.url,
      fetched.status,
      fetched.startedAt,
      fetched.cost,
      drifted
        ? {
            code: 'PARSE_DRIFT',
            message: `${withoutPosting} job pages in a row had no JSON-LD JobPosting at all`,
            status: fetched.status,
          }
        : null,
    )
    if (drifted) {
      counts.invalid += 1
      samples.push(buildInvalidSample(at, 'json-ld: none', { url: item.url }, ctx.secrets))
      stop = 'ERROR'
      break
    }
    if (withoutPosting >= MAX_PAGES_WITHOUT_POSTING) {
      tieTaken = true
      due.unshift(due.pop()!)
    }
    const selected = source.select(postings, fetched.bodyText, item)
    if (!('posting' in selected)) {
      counts.invalid += 1
      if (countsTowardDrift(source.createdAtMs(item), nowMs)) recentInvalid += 1
      samples.push(
        buildInvalidSample(at, `json-ld: ${selected.kind}`, { url: item.url }, ctx.secrets),
      )
      continue
    }
    const built = buildSourceObservation(source.map(selected.posting, item), { now: ctx.now() })
    if (!built.ok) {
      counts.quarantined += 1
      samples.push(buildInvalidSample(at, built.reason, { url: item.url }, ctx.secrets))
      continue
    }
    const next: ValidatedCheckpoint = {
      configVersion: config.configVersion,
      policyVersion: ctx.policyVersion,
      adapterVersion: source.adapterVersion,
      position: { kind: 'RESTART', page: at },
      completedAt: ctx.now(),
    }
    try {
      await ctx.checkpoints.savePage({ observations: [built.observation], checkpoint: next })
    } catch (error) {
      counts.discarded += 1
      fail(item.url, {
        code: 'PERSISTENCE',
        message: error instanceof Error ? error.message : 'the page could not be persisted',
        status: fetched.status,
      })
      break
    }
    counts.normalized += 1
    observations.push(built.observation)
    checkpoint = next
    pagesCompleted += 1
  }
  // Drift, not bad luck: most recent pages read had no usable posting (the sitemap loop's rule).
  if (stop === 'PAGE_CAP' && isDetailDrift(recentInvalid, counts.normalized)) {
    fail(source.robotsUrl, {
      code: 'PARSE_DRIFT',
      message: `${recentInvalid} of ${counts.raw} job pages had no matching JSON-LD JobPosting`,
      status: null,
    })
  }
  return finish()
}
