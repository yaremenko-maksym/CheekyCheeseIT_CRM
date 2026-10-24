import { z } from 'zod'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import {
  type ApiJsonSourceSpec,
  baseSourceConfigSchema,
  collectJsonPages,
  definePagedProvider,
} from '../api-json.provider'
import { boundedString, dateRaw, optionalString, optionalStringArray, urlString } from './as'

/**
 * Jobgether job search (`https://jobgether.com/astroapi/ai/jobs.json`, published OpenAPI 3.1 at
 * `https://jobgether.com/openapi.json`), page-number pagination.
 *
 * BLOCKED - NOT TO BE REGISTERED OR ENABLED (permission `UNCLEAR`; see `JOBGETHER_SOURCE_STATUS`).
 * The two published statements contradict each other: the API is documented as public,
 * unauthenticated and "intended for AI agents/assistants" (llms.txt, the OpenAPI), while the
 * Terms of Use clause 4.5 forbid "accessing the Platform or extracting its content by automated
 * means (bots, scrapers, crawlers)" and "using Platform content to train, fine-tune or operate
 * machine-learning models", and section 9 prohibits "extraction, data mining, scraping". Whether
 * the API is "the Platform" is an OWNER decision. The adapter and its authentic fixtures stay
 * until it is made. The ML clause matters on its own: relevance decisions in this feature run
 * through a model.
 *
 * - ENDPOINT is `/astroapi/ai/jobs.json`, the path robots.txt explicitly Allows (with a query) and
 *   the OpenAPI calls current ("peers, not a migration"). `/astroapi/ai/jobs` is the deprecated
 *   one: its body carries a `deprecation` object. robots.txt also sets `Crawl-delay: 2`, which the
 *   shared loop has no hook for - the rate limit header says 60 per minute.
 * - PAGING: `limit` is at most 25 (default 10) and `page` is capped at 10, so one query can never
 *   yield more than 250 jobs; `maxPages` is therefore 1..10. The walk ends at `hasMore: false`.
 *   Coverage is WINDOW, never FULL_INVENTORY: the page cap, not the inventory, ends a walk
 *   (page 10 of the capture still said `hasMore: true`).
 * - DEPRECATION is SURFACED by failing: a body carrying `deprecation.deprecated: true` is refused
 *   as `PARSE_DRIFT` whose message names the sunset date and the successor. The batch has no
 *   warning channel, and this endpoint is announced as not deprecated, so a deprecation notice
 *   here means the path is retiring and an operator must see it. (Headers `Deprecation`, `Sunset`
 *   and `Link: rel="successor-version"` are not visible to a spec, only the body.)
 * - DETAIL POLICY for omitted descriptions: NONE, by design. The listing carries no description
 *   and no detail endpoint is documented; the only detail would be the listing page's HTML, which
 *   robots.txt disallows (`/offer/...`) and the terms forbid scraping. So descriptions stay
 *   absent, exactly one request is made per page, and nothing is metered.
 * - `remote` is `Full Remote` on all 25 captured jobs; only `Full Remote` and `Remote-first` map
 *   to true. `Hybrid` and anything unrecognised stay unknown (null), never false.
 * - `salaryRange` (e.g. "115000-135000 USD") has no field in the observation and is not mapped.
 */

export const JOBGETHER_SOURCE_STATUS = {
  blocked: true,
  permission: 'UNCLEAR',
  reason:
    'Terms of Use 4.5 forbid automated extraction while the API is documented for AI agents; owner decision required before registration',
} as const

export const JOBGETHER_ADAPTER_VERSION = 'jobgether-1'
export const JOBGETHER_NAMESPACE = 'jobgether'
const ENDPOINT = 'https://jobgether.com/astroapi/ai/jobs.json'
/** Documented maximum for `limit`. */
export const JOBGETHER_MAX_PAGE_SIZE = 25
/** Documented ceiling for `page` ("Capped at 10"). */
export const JOBGETHER_MAX_PAGES_CEILING = 10
export const JOBGETHER_KEYWORD_MAX_CHARS = 200

const configSchema = baseSourceConfigSchema
  .extend({
    namespace: z.literal(JOBGETHER_NAMESPACE).default(JOBGETHER_NAMESPACE),
    keyword: z.string().min(1).max(JOBGETHER_KEYWORD_MAX_CHARS).optional(),
    pageSize: z.number().int().min(1).max(JOBGETHER_MAX_PAGE_SIZE).default(JOBGETHER_MAX_PAGE_SIZE),
    maxPages: z.number().int().min(1).max(JOBGETHER_MAX_PAGES_CEILING).default(5),
  })
  .strict()
  .refine((c) => c.query === null, { message: 'search text lives in keyword, not in query' })
  .refine((c) => c.window === null, { message: 'Jobgether has no date window' })
type Config = z.infer<typeof configSchema>

const itemSchema = z.object({
  id: boundedString(100).min(1),
  title: boundedString(ORIGINAL_LIMITS.title),
  company: boundedString(ORIGINAL_LIMITS.companyName),
  url: urlString(),
  location: optionalString(ORIGINAL_LIMITS.location),
  remote: optionalString(100),
  contractType: optionalString(100),
  experience: optionalString(100),
  jobFunctions: optionalStringArray(ORIGINAL_LIMITS.tags, ORIGINAL_LIMITS.tag),
  postedAt: dateRaw(),
})
type Item = z.infer<typeof itemSchema>

/** `jobs` stays OPAQUE so one bad job is isolated instead of failing the page. */
const deprecationSchema = z.object({
  deprecated: z.boolean().optional(),
  sunset: z.string().max(64).optional(),
  successor: z.string().max(200).optional(),
})

const envelopeSchema = z
  .object({
    jobs: z.array(z.unknown()),
    pagination: z.object({ hasMore: z.boolean() }),
    deprecation: deprecationSchema.optional(),
  })
  .refine((envelope) => envelope.deprecation?.deprecated !== true, {
    error: ({ input }) => {
      const d = deprecationSchema.parse((input as { deprecation: unknown }).deprecation)
      return `Jobgether reports this path deprecated (sunset ${d.sunset ?? 'unannounced'}, successor ${d.successor ?? 'unnamed'})`
    },
  })
type Envelope = z.infer<typeof envelopeSchema>

const REMOTE_YES = /^(?:full[- ]remote|remote[- ]first)$/i

function mapItem(item: Item, config: Config) {
  return {
    namespace: config.namespace,
    nativeId: item.id,
    url: item.url,
    title: item.title,
    companyName: item.company,
    location: item.location,
    remote: item.remote !== null && REMOTE_YES.test(item.remote.trim()) ? true : null,
    employmentType: item.contractType,
    seniorityHint: item.experience,
    tags: item.jobFunctions,
    dates: [
      { raw: item.postedAt, contract: 'ISO_ZONED' as const, semantics: 'PUBLISHED' as const },
    ],
  }
}

export const jobgetherSpec: ApiJsonSourceSpec<Config, Envelope, Item> = {
  type: 'JOBGETHER_API',
  adapterVersion: JOBGETHER_ADAPTER_VERSION,
  configSchema,
  envelopeSchema,
  itemSchema,
  pageRequest: (config, at) => {
    const url = new URL(ENDPOINT)
    if (config.keyword !== undefined) url.searchParams.set('keyword', config.keyword)
    url.searchParams.set('sort', 'date')
    url.searchParams.set('limit', String(config.pageSize))
    url.searchParams.set('page', String(at.page))
    return { request: { url: url.href, headers: { accept: 'application/json' } } }
  },
  extractItems: (envelope) => envelope.jobs,
  nextCursor: (envelope, at) => (envelope.pagination.hasMore ? `page:${at.page + 1}` : null),
  nativeIdOf: (item) => item.id,
  mapItem,
  scopeOf: (config) => ({
    namespace: config.namespace,
    query: JSON.stringify({ keyword: config.keyword, sort: 'date' }),
    configVersion: config.configVersion,
    window: null,
  }),
}

export const jobgetherProvider = definePagedProvider(jobgetherSpec, (config, ctx) =>
  collectJsonPages(
    {
      ...jobgetherSpec,
      limits: { maxPages: config.maxPages, maxItemsPerPage: config.pageSize },
    },
    config,
    ctx,
  ),
)
