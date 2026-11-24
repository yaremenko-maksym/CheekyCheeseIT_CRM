import { z } from 'zod'
import { DEFAULT_MAX_BYTES } from '../../http/bounded-fetch'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import {
  type ApiJsonSourceSpec,
  baseSourceConfigSchema,
  collectJsonPages,
  definePagedProvider,
} from '../api-json.provider'
import { boundedString, dateRaw, optionalString, urlString } from './as'
import { isNonItTitle } from './non-it-title'

/**
 * 4 Day Week (`https://4dayweek.io/api/v2/jobs`), paged by `page` and `limit`.
 *
 * A DOCUMENTED PUBLIC API: robots.txt carries `Allow: /api/v2` (the longest match), and the site's
 * terms state the restriction does not apply to the documented public API and MCP endpoint. No
 * owner decision is needed, and none is recorded. One plain GET a page with the project's
 * identifying User-Agent (set by the transport, never here); a 403, a 429 or a challenge ends the
 * run.
 *
 * MEASURED 2026-11-24 (`__fixtures__/fourdayweek/jobs-engineering.json`, provenance beside it):
 *  - An envelope `{ data, page, limit, total, has_more }`. The next page is requested while
 *    `has_more` is true, up to `maxPages` (default four, so one hundred listings a run).
 *  - `category=engineering` is a SERVER-SIDE filter, and it is IT-LEANING, not IT: it includes
 *    non-software engineering (a Construction Manager record was on the page). It is named as the
 *    scope marker, so a clean run is a WINDOW over the newest listings, never an inventory.
 *    Titles the funnel calls NON_IT are skipped at ingestion (`non-it-title.ts`). The Construction
 *    Manager record is NOT NON_IT by that rule, so it is still kept: an open gap, not an IT filter.
 *  - `work_arrangement` is `remote`, `hybrid` or `onsite`. Remoteness comes only from that field.
 *  - `posted_at` is a `Z`-suffixed instant. `tools` and `stack` are absent on some records and are
 *    read as empty; unknown keys are ignored.
 */
export const FOURDAYWEEK_SOURCE_STATUS = {
  blocked: false,
  permission: 'PUBLIC_API_DOCUMENTED',
  reason:
    'documented public API (robots.txt Allow: /api/v2; the terms exempt the documented public API and MCP endpoint); engineering category only',
} as const

export const FOURDAYWEEK_ADAPTER_VERSION = 'fourdayweek-1'
export const FOURDAYWEEK_ENDPOINT = 'https://4dayweek.io/api/v2/jobs'
/** One global feed: the namespace is a constant, because an empty one is refused by identity. */
export const FOURDAYWEEK_NAMESPACE = 'fourdayweek'
/** The server-side category, and the scope marker that makes a clean run WINDOW. */
export const FOURDAYWEEK_CATEGORY = 'engineering'
export const FOURDAYWEEK_SCOPE_QUERY = `category:${FOURDAYWEEK_CATEGORY}`
const PAGE_SIZE = 25
export const FOURDAYWEEK_MAX_PAGES_DEFAULT = 4
const FOURDAYWEEK_MAX_PAGES_CEILING = 10

const configSchema = baseSourceConfigSchema
  .extend({
    namespace: z.literal(FOURDAYWEEK_NAMESPACE).default(FOURDAYWEEK_NAMESPACE),
    maxPages: z
      .number()
      .int()
      .min(1)
      .max(FOURDAYWEEK_MAX_PAGES_CEILING)
      .default(FOURDAYWEEK_MAX_PAGES_DEFAULT),
  })
  .strict()
  .refine((c) => c.query === null, {
    message: '4 Day Week has no search; the category is the scope',
  })
  .refine((c) => c.window === null, { message: '4 Day Week has no date window' })

type Config = z.infer<typeof configSchema>

/** A list of `{ name }` objects (skills, tools). Absent or null is empty; names are bounded. */
const namedList = z
  .array(z.object({ name: optionalString(200) }))
  .max(50)
  .nullish()
  .transform((v) => v ?? [])

const locationList = z
  .array(z.object({ city: optionalString(200), country: optionalString(200) }))
  .max(20)
  .nullish()
  .transform((v) => v ?? [])

const itemSchema = z.object({
  id: boundedString(64).min(1),
  title: boundedString(ORIGINAL_LIMITS.title),
  url: urlString(),
  description: optionalString(ORIGINAL_LIMITS.description),
  work_arrangement: optionalString(20),
  company: z
    .object({ name: optionalString(ORIGINAL_LIMITS.companyName) })
    .nullish()
    .transform((v) => v?.name ?? null),
  locations: locationList,
  skills: namedList,
  tools: namedList,
  posted_at: dateRaw(),
})

type Item = z.infer<typeof itemSchema>

/** `data` stays OPAQUE so one bad listing is isolated instead of failing the page. */
const envelopeSchema = z.object({
  data: z.array(z.unknown()),
  has_more: z
    .boolean()
    .nullish()
    .transform((v) => v ?? false),
})

type Envelope = z.infer<typeof envelopeSchema>

/**
 * Remoteness from the site's own `work_arrangement`: `remote` is true, `onsite` is false, and a
 * hybrid listing is unknown, because it is neither a remote-only role nor an on-site one.
 */
export function remoteOf(workArrangement: string | null): boolean | null {
  if (workArrangement === 'remote') return true
  if (workArrangement === 'onsite') return false
  return null
}

/** The first listed location as `City, Country`, or null when the listing names none. */
function locationOf(item: Item): string | null {
  const first = item.locations[0]
  if (!first) return null
  const parts = [first.city, first.country].filter((p): p is string => p !== null && p !== '')
  return parts.length > 0 ? parts.join(', ') : null
}

/** Skill and tool names, in the order the API sent them, bounded at the original-value limit. */
function tagsOf(item: Item): string[] {
  // Stryker disable next-line MethodExpression: namedList caps each list at 50 names, so at most 100 reach this slice, below ORIGINAL_LIMITS.tags (200); the cap cannot bite and stays as the stated bound
  return [...item.skills, ...item.tools]
    .map((n) => n.name)
    .filter((n): n is string => n !== null && n !== '')
    .slice(0, ORIGINAL_LIMITS.tags)
}

export const fourDayWeekSpec: ApiJsonSourceSpec<Config, Envelope, Item> = {
  type: 'FOURDAYWEEK_API',
  adapterVersion: FOURDAYWEEK_ADAPTER_VERSION,
  configSchema,
  envelopeSchema,
  itemSchema,
  pageRequest: (_config, at) => {
    const url = new URL(FOURDAYWEEK_ENDPOINT)
    url.searchParams.set('category', FOURDAYWEEK_CATEGORY)
    url.searchParams.set('page', String(at.page))
    url.searchParams.set('limit', String(PAGE_SIZE))
    return { request: { url: url.href, headers: { accept: 'application/json' } } }
  },
  // A NON_IT title (the funnel's verdict) is not a software role: skipped before the counts, as in GermanTechJobs.
  extractItems: (envelope) =>
    envelope.data.filter(
      (element) =>
        !(
          typeof element === 'object' &&
          element !== null &&
          'title' in element &&
          typeof element.title === 'string' &&
          isNonItTitle(element.title)
        ),
    ),
  // `has_more` is the only thing read from the envelope to decide on another page.
  nextCursor: (envelope, at) =>
    envelope.has_more && envelope.data.length > 0 ? `page:${at.page + 1}` : null,
  nativeIdOf: (item) => item.id,
  mapItem: (item, config) => ({
    namespace: config.namespace,
    nativeId: item.id,
    url: item.url,
    title: item.title,
    companyName: item.company,
    location: locationOf(item),
    description: item.description,
    remote: remoteOf(item.work_arrangement),
    tags: tagsOf(item),
    applicationUrl: null,
    dates: [{ raw: item.posted_at, contract: 'ISO_ZONED', semantics: 'PUBLISHED' }],
  }),
  scopeOf: (config) => ({
    namespace: config.namespace,
    query: FOURDAYWEEK_SCOPE_QUERY,
    configVersion: config.configVersion,
    window: null,
  }),
}

export const fourDayWeekProvider = definePagedProvider(fourDayWeekSpec, (config, ctx) =>
  collectJsonPages(
    {
      ...fourDayWeekSpec,
      limits: {
        maxBytes: DEFAULT_MAX_BYTES,
        maxPages: config.maxPages,
        maxItemsPerPage: PAGE_SIZE,
      },
    },
    config,
    ctx,
  ),
)
