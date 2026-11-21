import type { JobSourceType } from '@crm/shared'
import { DEFAULT_USER_AGENT } from '../../http/bounded-fetch'
import { buildIdentity } from '../../normalize/identity-key'
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

/**
 * A listing + JSON-LD detail run (sources-14: Dice, No Fluff Jobs). The same delta shape as Next
 * Level Jobs (sources-12), with listing PAGES in place of a sitemap:
 *
 *  1. `robots.txt` of the one host, through the metered fetch (it is counted in the budget). Any
 *     failure to read it ends the run before anything else is fetched (fail closed).
 *  2. Each listing URL, in order, only when robots allows it; the items are deduplicated by id.
 *  3. The store is asked which items it already holds (`ctx.heldIdentityKeys`); the detail page of
 *     at most `maxDetails` of the rest is fetched, in listing order, each only when robots allows it.
 *  4. Each detail's JSON-LD JobPosting is selected by the source's own rule and mapped.
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
  | { readonly ok: true; readonly items: readonly T[] }
  | { readonly ok: false; readonly message: string }

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

/** Our robots product token: the product of the transport's own User-Agent. */
export const ROBOTS_PRODUCT_TOKEN = DEFAULT_USER_AGENT.split('/')[0]!

/** RFC 9309 section 2.5: a crawler may stop parsing robots.txt after 500 KiB. */
export const ROBOTS_MAX_BYTES = 500 * 1024

/** Every request one run may make: robots, every listing page, the detail cap. */
export const requestsOf = (listingPages: number, bounds: ListingDetailBounds): number =>
  1 + listingPages + bounds.maxDetails

/** The identity key a record of this posting is stored under (the same encoder the store uses). */
export function identityKeyOf(type: JobSourceType, namespace: string, id: string): string {
  const built = buildIdentity({ provider: type, namespace, nativeId: id, url: null })
  // Stryker disable next-line ConditionalExpression,StringLiteral: a listed id under a constant namespace always builds; the throw guards the encoder, not the input
  if (!built.ok) throw new Error(`no identity for ${id}: ${built.reason}`)
  return built.identity.identityKey
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
    { url: source.robotsUrl, headers: { accept: 'text/plain' }, maxBytes: ROBOTS_MAX_BYTES },
    true,
  )
  if (!robotsFetched.ok) {
    stop = robotsFetched.stop
    return finish()
  }
  report(
    at,
    source.robotsUrl,
    robotsFetched.status,
    robotsFetched.startedAt,
    robotsFetched.cost,
    null,
  )
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
    const fetched = await metered(at, { url, headers: { accept }, maxBytes }, notFound)
    if (!fetched.ok) {
      stop = fetched.stop
      return null
    }
    return fetched
  }

  const items = new Map<string, T>()
  for (const url of source.listingUrls) {
    const listed = await politeFetch(url, source.listingMaxBytes, 'text/html', false)
    if (listed === null) return finish()
    const parsed = source.parseListing(listed.bodyText)
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
    for (const item of parsed.items) if (!items.has(item.id)) items.set(item.id, item)
  }

  const keyOf = (item: T) => identityKeyOf(source.type, config.namespace, item.id)
  let held: ReadonlySet<string>
  try {
    held = (await ctx.heldIdentityKeys?.([...items.values()].map(keyOf))) ?? new Set()
  } catch (error) {
    fail(source.robotsUrl, {
      code: 'PERSISTENCE',
      message: `the held postings could not be read: ${error instanceof Error ? error.message : 'the store failed'}`,
      status: null,
    })
    return finish()
  }

  const due = [...items.values()].filter((i) => !held.has(keyOf(i))).slice(0, bounds.maxDetails)
  for (const item of due) {
    const fetched = await politeFetch(item.url, source.detailMaxBytes, 'text/html', true)
    if (fetched === null) break
    report(at, item.url, fetched.status, fetched.startedAt, fetched.cost, null)
    // A 404 is an answer: the posting left between the listing and its page. Nothing to record.
    if (fetched.status === 404) continue
    counts.raw += 1
    const postings = extractJobPostings(fetched.bodyText, { now: ctx.now() }).postings
    const selected = source.select(postings, fetched.bodyText, item)
    if (!('posting' in selected)) {
      counts.invalid += 1
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
  // Drift, not bad luck: most pages read had no usable posting. Fails the run so health sees it.
  if (stop === 'PAGE_CAP' && counts.invalid > counts.normalized && counts.invalid >= 3) {
    fail(source.robotsUrl, {
      code: 'PARSE_DRIFT',
      message: `${counts.invalid} of ${counts.raw} job pages had no matching JSON-LD JobPosting`,
      status: null,
    })
  }
  return finish()
}
