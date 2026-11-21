import { z } from 'zod'
import type { RawObservationFields } from '../../normalize/observation'
import { type JsonLdJobPosting, selectByIdentity } from '../../structuring/json-ld'
import { baseSourceConfigSchema, definePagedProvider } from '../api-json.provider'
import { MIN_HOST_GAP_MS, realSleep } from '../html/html-ports'
import {
  collectListingDetail,
  jsonLdDates,
  type ListingDetailBounds,
  type ListingDetailDeps,
  type ListingDetailSource,
  type ListingItem,
  type ListingResult,
  requestsOf,
} from './listing-detail.collector'

/**
 * Dice (dice.com), sources-14: the US tech job board. The `/jobs` search page is a Next.js app
 * whose server-rendered flight payload (`self.__next_f.push([1, "..."])` scripts) carries the
 * listed jobs as JSON; each job's own `/job-detail/<guid>` page carries one JSON-LD JobPosting.
 * Both are parsed deterministically; no model, no headless browser.
 *
 * PERMISSION: Dice's terms PROHIBIT automated collection. The owner accepted that risk on 2026-11-20
 * (`ACCEPT_PROHIBITED_RISK`, see owner-decisions.ts), for these URL shapes only and with no evasion
 * of any block: a 403, a 429 or a challenge page ends the run and is reported.
 *
 * ROBOTS (checked in code before every request): `/jobs` and `/job-detail` are allowed; `/job`,
 * `/jobs?q*`, `/feed/`, `/rss/` and `/apply-redirect*` are not. The adapter therefore reads only
 * the unfiltered `/jobs?page=N` pages and never follows an apply redirect, so `applicationUrl` is
 * always null and no ATS URL is known (ATS dedup is not possible for this source).
 *
 * REQUEST BUDGET: 1 robots + 3 listing pages + at most 25 detail pages = 29 a run, each after a
 * jittered gap of at least 3 s. The manifest reserves 33 (4 for redirects).
 *
 * THE TWO jobList TRAP: the page carries a second `jobList`, the "similar jobs" panel, flagged
 * `isSimilarJobsList`. The search list is the one object with both `jobList` and `totalPages`
 * and without that flag; zero or several such objects is drift.
 *
 * SALARY is free text on the listing (and absent from the JSON-LD); the observation contract has
 * no compensation field, so it is not stored.
 */

export const DICE_SOURCE_STATUS = {
  blocked: false,
  permission: 'PROHIBITED',
  reason:
    'permitted by the owner decision of 2026-11-20 (ACCEPT_PROHIBITED_RISK on terms that forbid collection; dice.com/jobs?page=N and the job-detail pages it lists only, no evasion of any block)',
} as const

export const DICE_ADAPTER_VERSION = 'dice-1'
export const DICE_HOST = 'www.dice.com'
export const DICE_NAMESPACE = 'dice'
export const DICE_ENDPOINT_VARIANT = 'jobs-listing'
export const DICE_LISTING_URLS = [1, 2, 3].map((page) =>
  page === 1 ? `https://${DICE_HOST}/jobs` : `https://${DICE_HOST}/jobs?page=${page}`,
)

export const DICE_BOUNDS: ListingDetailBounds = { maxDetails: 25, minGapMs: MIN_HOST_GAP_MS }
export const DICE_REQUESTS_PER_RUN = requestsOf(DICE_LISTING_URLS.length, DICE_BOUNDS)

/** A listing page is ~0.3 MB; 4 MiB keeps growth from being an outage. */
export const DICE_LISTING_MAX_BYTES = 4 * 1024 * 1024

const PUSH = /<script>self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g
const ROW = /^[0-9a-z]+:(\[[\s\S]*)$/
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const itemSchema = z.object({
  guid: z.string().regex(GUID),
  detailsPageUrl: z.string(),
  title: z.string().nullish(),
  companyName: z.string().nullish(),
  isRemote: z.boolean().nullish(),
  jobLocation: z.object({ displayName: z.string().nullish() }).nullish(),
})

export interface DiceItem extends ListingItem {
  readonly title: string | null
  readonly companyName: string | null
  readonly location: string | null
  readonly isRemote: boolean
}

/** The flight payload's rows, each JSON-parsed; a row that is not JSON (a module ref) is skipped. */
function flightRows(html: string): unknown[] {
  let payload = ''
  for (const match of html.matchAll(PUSH)) {
    try {
      const chunk: unknown = JSON.parse(match[1]!)
      if (Array.isArray(chunk) && chunk[0] === 1 && typeof chunk[1] === 'string')
        payload += chunk[1]
    } catch {
      // A push that is not JSON carries nothing we read.
    }
  }
  const rows: unknown[] = []
  for (const line of payload.split('\n')) {
    const json = ROW.exec(line)?.[1]
    if (json === undefined) continue
    try {
      rows.push(JSON.parse(json))
    } catch {
      // A row the flight format writes as text (`T` rows, module refs) is not ours.
    }
  }
  return rows
}

/** Every object holding the search list: `jobList` + `totalPages`, not the similar-jobs list. */
function searchLists(value: unknown, found: unknown[]): unknown[] {
  if (Array.isArray(value)) {
    for (const v of value) searchLists(v, found)
  } else if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>
    if ('jobList' in o && 'totalPages' in o && o.isSimilarJobsList !== true) found.push(o.jobList)
    for (const v of Object.values(o)) searchLists(v, found)
  }
  return found
}

/** The search list's jobs, in page order. Drift (no list, two lists, a malformed job) fails. */
export function parseDiceListing(html: string): ListingResult<DiceItem> {
  const lists = searchLists(flightRows(html), [])
  if (lists.length !== 1) return { ok: false, message: `${lists.length} search job lists` }
  const data = (lists[0] as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return { ok: false, message: 'the job list has no data array' }
  const items: DiceItem[] = []
  for (const [index, raw] of data.entries()) {
    const parsed = itemSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, message: `job ${index} is malformed` }
    const job = parsed.data
    const url = `https://${DICE_HOST}/job-detail/${job.guid}`
    if (job.detailsPageUrl !== url) return { ok: false, message: `job ${index} has a foreign URL` }
    items.push({
      id: job.guid,
      url,
      title: job.title ?? null,
      companyName: job.companyName ?? null,
      location: job.jobLocation?.displayName ?? null,
      isRemote: job.isRemote === true,
    })
  }
  return { ok: true, items }
}

export function mapDicePosting(posting: JsonLdJobPosting, item: DiceItem): RawObservationFields {
  return {
    provider: 'DICE_HTML',
    adapterVersion: DICE_ADAPTER_VERSION,
    namespace: DICE_NAMESPACE,
    nativeId: item.id,
    url: item.url,
    title: posting.title ?? item.title,
    companyName: posting.hiringOrganization ?? item.companyName,
    location: posting.jobLocations.length > 0 ? posting.jobLocations.join('; ') : item.location,
    description: posting.description,
    descriptionKind: 'html',
    remote: posting.jobLocationType === 'TELECOMMUTE' || item.isRemote ? true : null,
    employmentType: posting.employmentType[0] ?? null,
    tags: posting.skills,
    // Never the apply redirect: robots disallows it, and it is the only route to the employer.
    applicationUrl: null,
    dates: jsonLdDates(posting),
  }
}

export const DICE_SOURCE: ListingDetailSource<DiceItem> = {
  type: 'DICE_HTML',
  namespace: DICE_NAMESPACE,
  adapterVersion: DICE_ADAPTER_VERSION,
  robotsUrl: `https://${DICE_HOST}/robots.txt`,
  listingUrls: DICE_LISTING_URLS,
  listingMaxBytes: DICE_LISTING_MAX_BYTES,
  detailMaxBytes: 2 * 1024 * 1024,
  parseListing: parseDiceListing,
  select: (postings, _html, item) => selectByIdentity(postings, { url: item.url }),
  map: mapDicePosting,
}

const configSchema = baseSourceConfigSchema
  .extend({ namespace: z.literal(DICE_NAMESPACE).default(DICE_NAMESPACE) })
  .strict()
  .refine((c) => c.query === null, { message: 'Dice is read without a search query' })
  .refine((c) => c.window === null, { message: 'Dice has no date window' })

export function createDiceProvider(
  bounds: ListingDetailBounds = DICE_BOUNDS,
  deps: ListingDetailDeps = { sleep: realSleep, random: Math.random },
) {
  // Stryker disable next-line StringLiteral,ObjectLiteral: manifest.drift.spec.ts reads this literal from the source text; instrumenting it hides the type from that scan, and the registry specs pin the type
  return definePagedProvider({ type: 'DICE_HTML', configSchema }, (config, ctx) =>
    collectListingDetail(DICE_SOURCE, bounds, deps, config, ctx),
  )
}

export const diceProvider = createDiceProvider()

/** The one host this adapter's requests may reach; a transport is pinned to it. */
export const diceAllowedHosts = (): readonly string[] => [DICE_HOST]
