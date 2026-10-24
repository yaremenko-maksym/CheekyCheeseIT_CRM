import { z } from 'zod'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import {
  type ApiJsonSourceSpec,
  baseSourceConfigSchema,
  collectJsonPages,
  definePagedProvider,
} from '../api-json.provider'
import { boundedString, dateRaw, optionalString, positiveSafeInt, urlString } from './as'

/**
 * The Muse (`https://www.themuse.com/api/public/jobs`), the public list endpoint, PAGE-NUMBERED.
 *
 * STATUS: BLOCKED, and the reason is permission rather than contract. The contract was verified
 * against two live GETs (fixtures in `__fixtures__/muse/`), but the terms (section 2.2) require an
 * app to be REGISTERED through the developer portal before it accesses the API, grant only the right
 * to "format and display" Muse Content (section 3.1) and forbid cloning it (3.3(g)). Nothing
 * addresses storing postings in a recruiting database, and no app is registered for this CRM. The
 * owner decides; until then the adapter is not registered (Task 3.7). See `MUSE_SOURCE_STATUS`.
 *
 * - PAGES ARE 0-BASED. `page=0` answers `"page": 0`. The loop's page is 1-based, so the request
 *   carries `at.page - 1`. Measured, not read: the developer page does not say which.
 * - THE END. `page_count` is the number of pages, so the last index is `page_count - 1`. A page
 *   PAST it answers HTTP 400 {"code": 400, "error": "Value `page` is too high"} - the developer
 *   page says "0 results", the live API says 400. The adapter therefore stops on `page_count` and
 *   never asks for a page it was not told exists.
 * - COVERAGE is the WINDOW of the first `maxPages` pages, never a full inventory (414k postings
 *   unfiltered), and the category filter is not a partition (a civil-engineering role and a
 *   recruiter both carry "Software Engineering" in the capture).
 * - `refs.landing_page` is the posting on themuse.com. The response carries no separate application
 *   URL, so there is no apply URL to distinguish from the posting URL.
 * - `locations[].name` are display strings ("New York, NY"); there is no country code, and
 *   `Flexible / Remote` is a location NAME. `remote` is set only when that name is present: its
 *   absence is not evidence of an on-site job, so it stays unknown.
 * - RATE: 500 requests/hour without a key (`X-RateLimit-*` headers), 3600 with one. This adapter
 *   sends no key and makes at most 5 requests per attempt.
 */

export const MUSE_SOURCE_STATUS = {
  blocked: true,
  permission: 'UNCLEAR',
  reason:
    'terms section 2.2 requires a registered app and section 3.1 licenses display only; no app is registered and storing postings is not addressed; owner decision required',
} as const

export const MUSE_ADAPTER_VERSION = 'muse-1'
export const MUSE_NAMESPACE = 'themuse'
const ENDPOINT = 'https://www.themuse.com/api/public/jobs'
/** The seed documents `maxPages 1..5`: the unauthenticated rate is 500 requests an hour. */
export const MUSE_MAX_PAGES_CEILING = 5
/** `items_per_page` in every capture. */
export const MUSE_PAGE_SIZE = 20
/** The documented `level` values, verbatim from the developer page. */
export const MUSE_LEVELS = [
  'Entry Level',
  'Mid Level',
  'Senior Level',
  'management',
  'Internship',
] as const
export const MUSE_REMOTE_LOCATION = 'Flexible / Remote'
const FILTER_MAX_CHARS = 80
/** Letters, digits, spaces and the punctuation real category / location names use. */
const FILTER_PATTERN = /^[\p{L}\p{N} &,'./()-]+$/u

const filterString = () => z.string().min(1).max(FILTER_MAX_CHARS).regex(FILTER_PATTERN)

const configSchema = baseSourceConfigSchema
  .extend({
    namespace: z.literal(MUSE_NAMESPACE).default(MUSE_NAMESPACE),
    category: filterString().optional(),
    level: z.enum(MUSE_LEVELS).optional(),
    location: filterString().optional(),
    maxPages: z.number().int().min(1).max(MUSE_MAX_PAGES_CEILING).default(MUSE_MAX_PAGES_CEILING),
  })
  .strict()
  .refine((c) => c.query === null, {
    message: 'The Muse filters live in category / level / location',
  })
  .refine((c) => c.window === null, { message: 'The Muse has no date parameters' })
type Config = z.infer<typeof configSchema>

const namedSchema = z.object({ name: boundedString(ORIGINAL_LIMITS.tag) })
const namedList = (max: number) =>
  z
    .array(namedSchema)
    .max(max)
    .nullish()
    .transform((v) => v ?? [])

const itemSchema = z.object({
  id: positiveSafeInt(),
  name: boundedString(ORIGINAL_LIMITS.title),
  contents: optionalString(ORIGINAL_LIMITS.description),
  publication_date: dateRaw(),
  levels: namedList(20),
  locations: namedList(300),
  categories: namedList(ORIGINAL_LIMITS.tags),
  refs: z.object({ landing_page: urlString() }),
  company: z.object({ name: boundedString(ORIGINAL_LIMITS.companyName) }),
})
type Item = z.infer<typeof itemSchema>

/**
 * `results` stays OPAQUE so one bad posting is isolated. `timed_out: true` means the server gave up
 * part-way and the list is incomplete, which is drift for the page rather than a short page.
 */
const envelopeSchema = z.object({
  page: z.number().int().min(0),
  page_count: z.number().int().min(0),
  timed_out: z.literal(false).optional(),
  results: z.array(z.unknown()),
})
type Envelope = z.infer<typeof envelopeSchema>

/** The filter set as one stable string, so two searches that differ in any filter get two scopes. */
export function museScopeQuery(config: Pick<Config, 'category' | 'level' | 'location'>): string {
  return JSON.stringify({
    category: config.category,
    level: config.level,
    location: config.location,
  })
}

export const museSpec: ApiJsonSourceSpec<Config, Envelope, Item> = {
  type: 'MUSE_API',
  adapterVersion: MUSE_ADAPTER_VERSION,
  configSchema,
  envelopeSchema,
  itemSchema,
  pageRequest: (config, at) => {
    const url = new URL(ENDPOINT)
    // 0-based on the wire, 1-based in the loop.
    url.searchParams.set('page', String(at.page - 1))
    if (config.category !== undefined) url.searchParams.set('category', config.category)
    if (config.level !== undefined) url.searchParams.set('level', config.level)
    if (config.location !== undefined) url.searchParams.set('location', config.location)
    return { request: { url: url.href, headers: { accept: 'application/json' } } }
  },
  extractItems: (envelope) => envelope.results,
  // `at.page` is the page just fetched (1-based), so `page_count` pages exist while it is below it.
  nextCursor: (envelope, at) => (at.page < envelope.page_count ? `page:${at.page + 1}` : null),
  nativeIdOf: (item) => String(item.id),
  mapItem: (item, config) => ({
    namespace: config.namespace,
    nativeId: String(item.id),
    url: item.refs.landing_page,
    title: item.name,
    companyName: item.company.name,
    location: item.locations.map((l) => l.name).join('; '),
    description: item.contents,
    remote: item.locations.some((l) => l.name === MUSE_REMOTE_LOCATION) ? true : null,
    seniorityHint: item.levels.map((l) => l.name).join(', '),
    tags: item.categories.map((c) => c.name),
    dates: [{ raw: item.publication_date, contract: 'ISO_ZONED', semantics: 'PUBLISHED' }],
  }),
  scopeOf: (config) => ({
    namespace: config.namespace,
    query: museScopeQuery(config),
    configVersion: config.configVersion,
    window: null,
  }),
}

export const museProvider = definePagedProvider(museSpec, (config, ctx) =>
  collectJsonPages(
    { ...museSpec, limits: { maxPages: config.maxPages, maxItemsPerPage: MUSE_PAGE_SIZE } },
    config,
    ctx,
  ),
)
