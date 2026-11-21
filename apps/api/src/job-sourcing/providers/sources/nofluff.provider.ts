import { z } from 'zod'
import type { RawObservationFields } from '../../normalize/observation'
import { periodIn, salaryOf, type SalaryObservation } from '../../normalize/salary'
import type { JsonLdJobPosting } from '../../structuring/json-ld'
import { baseSourceConfigSchema, definePagedProvider } from '../api-json.provider'
import { MIN_HOST_GAP_MS, realSleep } from '../html/html-ports'
import {
  collectListingDetail,
  type ListingDetailBounds,
  type ListingDetailDeps,
  type ListingDetailSource,
  type ListingItem,
  type ListingResult,
  listingOf,
  requestsOf,
  type Selected,
} from './listing-detail.collector'
import { salaryAmount, salaryWord } from './as'
import { selectByCanonical } from './sitemap-jsonld'

/**
 * No Fluff Jobs (nofluffjobs.com), sources-14: the Polish IT job board. A category page
 * (`/pl/<category>?page=N`) is an Angular app whose server state (`<script id="serverApp-state">`)
 * carries the listed postings as JSON; each posting's `/pl/job/<slug>` page carries one JSON-LD
 * JobPosting. Both are parsed deterministically; no model, no headless browser.
 *
 * PERMISSION: the terms are UNCLEAR on automated reading; the owner accepted the risk on
 * 2026-11-20 (ACCEPT_RISK), for these URL shapes only and with no evasion of any block.
 *
 * ROBOTS (checked in code before every request): everything is allowed except `/api/`,
 * `/posting/`, `/pl/posting/`, `* /job/job/*`, `/pdf/` and a few others; the adapter reads only
 * category pages and `/pl/job/<slug>` pages.
 *
 * PAGING IS CUMULATIVE: `?page=2` of a category renders its first 40 postings (page 1 is 20), so
 * ONE request per category reads the 40 newest. Eight IT categories are read.
 *
 * REQUEST BUDGET: 1 robots + 8 category pages + at most 25 detail pages = 34 a run, each after a
 * jittered gap of at least 3 s. No redirect is followed, so the manifest reserves exactly that.
 * The 25 details are taken round-robin across the categories, so one cannot take every slot.
 *
 * THE JSON-LD HAS NO url OR identifier, so the posting is selected by the page: exactly one
 * JobPosting, on a page whose canonical link is the listed URL. The listing's 8-character
 * `reference` is the native id. Its `tiles` (the requirement chips) are the tags.
 *
 * SALARY (sources-17) is structured on the listing (`salary {from, to, currency, period}`) and is
 * preferred over the detail page's JSON-LD `baseSalary`, which carries only the top (`value`). The
 * captured periods are `Hour`, `Month` and `Day`; a day rate is no salary. The contract `type`
 * (b2b / permanent) is not stored. There is no employer ATS URL on either page.
 */

export const NOFLUFF_SOURCE_STATUS = {
  blocked: false,
  permission: 'UNCLEAR',
  reason:
    'permitted by the owner decision of 2026-11-20 (ACCEPT_RISK on UNCLEAR terms; nofluffjobs.com IT category pages and the /pl/job pages they list only, no evasion of any block)',
} as const

export const NOFLUFF_ADAPTER_VERSION = 'nofluff-2'
export const NOFLUFF_HOST = 'nofluffjobs.com'
export const NOFLUFF_NAMESPACE = 'nofluff'
export const NOFLUFF_ENDPOINT_VARIANT = 'category-listing'
export const NOFLUFF_CATEGORIES = [
  'backend',
  'frontend',
  'fullstack',
  'mobile',
  'devops',
  'data',
  'artificial-intelligence',
  'testing',
] as const
export const NOFLUFF_LISTING_URLS = NOFLUFF_CATEGORIES.map(
  (category) => `https://${NOFLUFF_HOST}/pl/${category}?page=2`,
)

export const NOFLUFF_BOUNDS: ListingDetailBounds = { maxDetails: 25, minGapMs: MIN_HOST_GAP_MS }
export const NOFLUFF_REQUESTS_PER_RUN = requestsOf(NOFLUFF_LISTING_URLS.length, NOFLUFF_BOUNDS)

/** A 40-posting category page is ~0.9 MB; 4 MiB keeps growth from being an outage. */
export const NOFLUFF_LISTING_MAX_BYTES = 4 * 1024 * 1024

const STATE_OPEN = '<script id="serverApp-state" type="application/json">'
const STATE_CLOSE = '</script>'

/** The server-state script's JSON text, by `indexOf` (linear; NU-M-1, PR #1445), or undefined. */
export function serverStateOf(html: string): string | undefined {
  const open = html.indexOf(STATE_OPEN)
  if (open === -1) return undefined
  const start = open + STATE_OPEN.length
  const end = html.indexOf(STATE_CLOSE, start)
  return end === -1 ? undefined : html.slice(start, end)
}
const SLUG = /^[a-z0-9-]{1,300}$/

const postingSchema = z.object({
  reference: z.string().regex(/^[A-Z0-9]{4,16}$/),
  url: z.string().regex(SLUG),
  posted: z.number().int().positive().nullish(),
  title: z.string().nullish(),
  name: z.string().nullish(),
  seniority: z.array(z.string()).nullish(),
  location: z
    .object({ places: z.array(z.object({ city: z.string().nullish() })).nullish() })
    .nullish(),
  tiles: z
    .object({ values: z.array(z.object({ value: z.string(), type: z.string().nullish() })) })
    .nullish(),
  salary: z
    .object({
      from: salaryAmount(),
      to: salaryAmount(),
      currency: salaryWord(),
      period: salaryWord(),
    })
    .nullish()
    .catch(null),
})

const nofluffPeriod = periodIn({ hour: 'HOUR', month: 'MONTH', year: 'YEAR' })

export interface NofluffItem extends ListingItem {
  readonly title: string | null
  readonly companyName: string | null
  readonly cities: readonly string[]
  readonly remote: boolean
  readonly seniority: string | null
  readonly tags: readonly string[]
  /** Epoch milliseconds of publication (the JSON-LD `datePosted` is a bare date). */
  readonly postedMs: number | null
  /** The listing's structured salary; `null` when absent or a day rate. */
  readonly salary: SalaryObservation | null
}

const isContainer = (v: unknown): v is { postings: unknown } =>
  typeof v === 'object' && v !== null && 'postings' in v && 'totalPages' in v

/**
 * The page's postings, in page order. No state or no or two containers is drift; a malformed posting
 * is skipped with its reason, and the page fails only as `listingOf` says (CR-L-2).
 */
export function parseNofluffListing(html: string): ListingResult<NofluffItem> {
  const json = serverStateOf(html)
  if (json === undefined) return { ok: false, message: 'no serverApp-state script' }
  let state: unknown
  try {
    state = JSON.parse(json)
  } catch {
    return { ok: false, message: 'serverApp-state is not JSON' }
  }
  if (typeof state !== 'object' || state === null)
    return { ok: false, message: 'state is not an object' }
  const containers = Object.values(state).filter(isContainer)
  if (containers.length !== 1) return { ok: false, message: `${containers.length} posting lists` }
  const postings = containers[0]!.postings
  if (!Array.isArray(postings)) return { ok: false, message: 'postings is not an array' }
  const items: NofluffItem[] = []
  const skipped: string[] = []
  for (const [index, raw] of postings.entries()) {
    const parsed = postingSchema.safeParse(raw)
    if (!parsed.success) {
      skipped.push(`posting ${index} is malformed`)
      continue
    }
    const p = parsed.data
    const cities = p.location?.places?.flatMap((place) => (place.city ? [place.city] : [])) ?? []
    items.push({
      id: p.reference,
      url: `https://${NOFLUFF_HOST}/pl/job/${p.url}`,
      title: p.title ?? null,
      companyName: p.name ?? null,
      cities: [...new Set(cities.filter((c) => c !== 'Remote'))],
      remote: cities.includes('Remote'),
      seniority: p.seniority?.[0] ?? null,
      tags: (p.tiles?.values ?? []).map((t) => t.value),
      postedMs: p.posted ?? null,
      salary: p.salary
        ? salaryOf(p.salary.from, p.salary.to, p.salary.currency, nofluffPeriod(p.salary.period))
        : null,
    })
  }
  return listingOf(items, skipped)
}

/** The page's one JobPosting, when the page is the listed one (its canonical link): main's rule. */
export const selectNofluffPosting = (
  postings: JsonLdJobPosting[],
  html: string,
  item: NofluffItem,
): Selected => selectByCanonical(postings, item, html)

export function mapNofluffPosting(
  posting: JsonLdJobPosting,
  item: NofluffItem,
): RawObservationFields {
  return {
    provider: 'NOFLUFF_HTML',
    adapterVersion: NOFLUFF_ADAPTER_VERSION,
    namespace: NOFLUFF_NAMESPACE,
    nativeId: item.id,
    url: item.url,
    title: posting.title ?? item.title,
    companyName: posting.hiringOrganization ?? item.companyName,
    location: item.cities.length > 0 ? item.cities.join('; ') : null,
    description: posting.description,
    descriptionKind: 'html',
    remote: posting.jobLocationType === 'TELECOMMUTE' || item.remote ? true : null,
    employmentType: posting.employmentType[0] ?? null,
    seniorityHint: item.seniority,
    tags: [...item.tags],
    applicationUrl: null,
    // The listing's epoch-ms `posted`, not the JSON-LD's bare-date `datePosted` (no zone).
    dates:
      item.postedMs === null
        ? []
        : [{ raw: item.postedMs, contract: 'UNIX_MILLISECONDS', semantics: 'PUBLISHED' }],
    salary: item.salary ?? posting.baseSalary,
  }
}

export const NOFLUFF_SOURCE: ListingDetailSource<NofluffItem> = {
  type: 'NOFLUFF_HTML',
  namespace: NOFLUFF_NAMESPACE,
  adapterVersion: NOFLUFF_ADAPTER_VERSION,
  robotsUrl: `https://${NOFLUFF_HOST}/robots.txt`,
  listingUrls: NOFLUFF_LISTING_URLS,
  listingMaxBytes: NOFLUFF_LISTING_MAX_BYTES,
  detailMaxBytes: 2 * 1024 * 1024,
  parseListing: parseNofluffListing,
  select: selectNofluffPosting,
  map: mapNofluffPosting,
  createdAtMs: (item) => item.postedMs,
}

const configSchema = baseSourceConfigSchema
  .extend({ namespace: z.literal(NOFLUFF_NAMESPACE).default(NOFLUFF_NAMESPACE) })
  .strict()
  .refine((c) => c.query === null, { message: 'No Fluff Jobs is read without a search query' })
  .refine((c) => c.window === null, { message: 'No Fluff Jobs has no date window' })

export function createNofluffProvider(
  bounds: ListingDetailBounds = NOFLUFF_BOUNDS,
  deps: ListingDetailDeps = { sleep: realSleep, random: Math.random },
) {
  // Stryker disable next-line StringLiteral,ObjectLiteral: manifest.drift.spec.ts reads this literal from the source text; instrumenting it hides the type from that scan, and the registry specs pin the type
  return definePagedProvider({ type: 'NOFLUFF_HTML', configSchema }, (config, ctx) =>
    collectListingDetail(NOFLUFF_SOURCE, bounds, deps, config, ctx),
  )
}

export const nofluffProvider = createNofluffProvider()

/** The one host this adapter's requests may reach; a transport is pinned to it. */
export const nofluffAllowedHosts = (): readonly string[] => [NOFLUFF_HOST]
