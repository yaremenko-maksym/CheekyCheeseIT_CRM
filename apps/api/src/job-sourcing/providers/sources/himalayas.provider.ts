import { z } from 'zod'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import {
  type ApiJsonSourceSpec,
  baseSourceConfigSchema,
  collectJsonPages,
  definePagedProvider,
} from '../api-json.provider'
import {
  boundedString,
  optionalStringArray,
  slugString,
  dateRaw,
  optionalString,
  optionalUrlString,
  urlString,
} from './as'

/**
 * Himalayas (`https://himalayas.app/jobs/api`), two endpoints behind one provider:
 *
 *  - BROWSE (`/jobs/api`): the whole feed, CURSOR pagination. The walk ends when `nextCursor` is
 *    omitted. The cursor is opaque and untrusted: it is only ever a `cursor=` PARAMETER.
 *  - SEARCH (`/jobs/api/search`): filtered, PAGE-number pagination (`page=`, 1-based). There is no
 *    end marker except a page with no jobs - pages may hold fewer than 20 before the end - so a
 *    short page does NOT stop the walk. Search has no `limit` parameter.
 *
 * `maxPages` (1..10) is a CEILING chosen per source in config, so the loop's limits are built per
 * config here rather than fixed in the spec: hitting it is a reported PAGE_CAP, never an
 * "exhausted" claim.
 *
 * COVERAGE is never FULL_INVENTORY. A browse walk can miss a job updated while walking (it moves
 * ahead of the cursor - the provider says so), and downstream lifecycle treats absence under a
 * FULL_INVENTORY run as a closure signal, so claiming completeness would be wrong. Both endpoints
 * therefore report a non-null scope `query` (the loop's marker for "a slice").
 *
 * LINKS: `guid` is the Himalayas job page (the source URL and the identity); `applicationLink` is
 * the tracked Apply URL the terms require for every Apply action, kept apart as `applicationUrl`.
 *
 * DATES: `pubDate` is when the job was last UPDATED (not published), `expiryDate` the latest the
 * job stays listed. Neither is PUBLISHED, so `publishedAt` stays null by design.
 *
 * DRIFT absorbed on purpose (observed in the live capture, differing from the OpenAPI text):
 * `locationRestrictions` are plain strings, documented as `{alpha2,name,slug}` objects - both are
 * accepted. `timezoneRestrictions` are numbers, documented as strings - they are not mapped, so
 * they are not validated.
 */

export const HIMALAYAS_ADAPTER_VERSION = 'himalayas-1'
export const HIMALAYAS_NAMESPACE = 'himalayas'
const BROWSE_URL = 'https://himalayas.app/jobs/api'
const SEARCH_URL = 'https://himalayas.app/jobs/api/search'
/** Documented maximum for `limit`; search pages are bounded by the same number. */
export const HIMALAYAS_MAX_PAGE_SIZE = 20
export const HIMALAYAS_MAX_PAGES_CEILING = 10
export const HIMALAYAS_BROWSE_SCOPE_QUERY = 'browse-feed'
/** `baseSourceConfigSchema.query` is capped at 500; the canonical filter string is the scope query. */
const SCOPE_QUERY_MAX_CHARS = 500

/** Verbatim from the OpenAPI enums (`/docs/openapi.json`). */
export const HIMALAYAS_SENIORITY = [
  'Entry-level',
  'Mid-level',
  'Senior',
  'Manager',
  'Director',
  'Executive',
] as const
export const HIMALAYAS_EMPLOYMENT_TYPES = [
  'Full Time',
  'Part Time',
  'Contractor',
  'Temporary',
  'Intern',
  'Volunteer',
  'Other',
] as const
const SORTS = [
  'relevant',
  'recent',
  'salaryAsc',
  'salaryDesc',
  'nameAToZ',
  'nameZToA',
  'jobs',
] as const
/** `UTC-5`, `UTC+05:30`, `-5`, `+5:30`, `3`. */
const TIMEZONE = /^(?:UTC)?[+-]?\d{1,2}(?::?\d{2})?$/

const searchFiltersSchema = z
  .object({
    q: z.string().min(1).max(200).optional(),
    country: z.string().min(1).max(100).optional(),
    worldwide: z.boolean().optional(),
    excludeWorldwide: z.boolean().optional(),
    seniority: z
      .array(z.enum(HIMALAYAS_SENIORITY))
      .min(1)
      .max(HIMALAYAS_SENIORITY.length)
      .optional(),
    employmentType: z
      .array(z.enum(HIMALAYAS_EMPLOYMENT_TYPES))
      .min(1)
      .max(HIMALAYAS_EMPLOYMENT_TYPES.length)
      .optional(),
    company: z.array(slugString(100)).min(1).max(10).optional(),
    timezone: z.string().max(20).regex(TIMEZONE).optional(),
    sort: z.enum(SORTS).optional(),
  })
  .strict()
type SearchFilters = z.infer<typeof searchFiltersSchema>

/**
 * The filter set as one stable string: fixed key order, only filters that are actually on. Two
 * searches that differ in any filter get different scopes, and a `false` boolean (which sends
 * nothing) equals an absent one.
 */
export function canonicalSearchQuery(search: SearchFilters | undefined): string {
  const f = search ?? {}
  return JSON.stringify({
    ...(f.q !== undefined && { q: f.q }),
    ...(f.country !== undefined && { country: f.country }),
    ...(f.worldwide === true && { worldwide: true }),
    ...(f.excludeWorldwide === true && { excludeWorldwide: true }),
    ...(f.seniority !== undefined && { seniority: f.seniority }),
    ...(f.employmentType !== undefined && { employmentType: f.employmentType }),
    ...(f.company !== undefined && { company: f.company }),
    ...(f.timezone !== undefined && { timezone: f.timezone }),
    ...(f.sort !== undefined && { sort: f.sort }),
  })
}

const configSchema = baseSourceConfigSchema
  .extend({
    namespace: z.literal(HIMALAYAS_NAMESPACE).default(HIMALAYAS_NAMESPACE),
    endpoint: z.enum(['browse', 'search']).default('browse'),
    maxPages: z.number().int().min(1).max(HIMALAYAS_MAX_PAGES_CEILING).default(5),
    /** Browse only: search has no `limit` parameter. */
    pageSize: z.number().int().min(1).max(HIMALAYAS_MAX_PAGE_SIZE).optional(),
    search: searchFiltersSchema.optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
    if (c.query !== null) issue('search text lives in search.q, not in query')
    if (c.window !== null) issue('Himalayas has no date window')
    if (c.endpoint === 'browse' && c.search !== undefined)
      issue('search filters need endpoint "search"')
    if (c.endpoint === 'search' && c.pageSize !== undefined) {
      issue('the search endpoint has no page size')
    }
    if (c.endpoint === 'search' && canonicalSearchQuery(c.search).length > SCOPE_QUERY_MAX_CHARS) {
      issue(`the filter set is longer than ${SCOPE_QUERY_MAX_CHARS} characters as a scope`)
    }
  })
type Config = z.infer<typeof configSchema>

const locationEntrySchema = z.union([boundedString(200), z.object({ name: boundedString(200) })])

const itemSchema = z.object({
  guid: urlString().min(1),
  applicationLink: optionalUrlString(),
  title: boundedString(ORIGINAL_LIMITS.title),
  companyName: boundedString(ORIGINAL_LIMITS.companyName),
  employmentType: optionalString(100),
  seniority: optionalStringArray(20, 50),
  /** `undefined`/`null` = unknown geography; `[]` = open worldwide (documented). */
  locationRestrictions: z.array(locationEntrySchema).max(300).nullish(),
  categories: optionalStringArray(ORIGINAL_LIMITS.tags, ORIGINAL_LIMITS.tag),
  parentCategories: optionalStringArray(ORIGINAL_LIMITS.tags, ORIGINAL_LIMITS.tag),
  description: optionalString(ORIGINAL_LIMITS.description),
  pubDate: dateRaw(),
  expiryDate: dateRaw(),
})
type Item = z.infer<typeof itemSchema>

/** `jobs` stays OPAQUE so one bad job is isolated instead of failing the page. */
const envelopeSchema = z.object({
  jobs: z.array(z.unknown()),
  nextCursor: z.string().min(1).nullish(),
})
type Envelope = z.infer<typeof envelopeSchema>

const documentedSeniority = new Set<string>(HIMALAYAS_SENIORITY)

function locationText(entries: Item['locationRestrictions']): string | null {
  if (entries === undefined || entries === null) return null
  if (entries.length === 0) return 'Worldwide'
  return entries.map((e) => (typeof e === 'string' ? e : e.name)).join(', ')
}

function mapItem(item: Item, config: Config) {
  const seniority = item.seniority.filter((s) => documentedSeniority.has(s))
  return {
    namespace: config.namespace,
    nativeId: item.guid,
    url: item.guid,
    title: item.title,
    companyName: item.companyName,
    location: locationText(item.locationRestrictions),
    description: item.description,
    remote: true,
    employmentType: item.employmentType,
    seniorityHint: seniority.length === 0 ? null : seniority.join(', '),
    tags: [...item.parentCategories, ...item.categories],
    applicationUrl: item.applicationLink,
    dates: [
      ...(item.pubDate === null
        ? []
        : [
            { raw: item.pubDate, contract: 'UNIX_SECONDS' as const, semantics: 'UPDATED' as const },
          ]),
      ...(item.expiryDate === null
        ? []
        : [
            {
              raw: item.expiryDate,
              contract: 'UNIX_SECONDS' as const,
              semantics: 'EXPIRY' as const,
            },
          ]),
    ],
  }
}

const common = {
  type: 'HIMALAYAS_API' as const,
  adapterVersion: HIMALAYAS_ADAPTER_VERSION,
  configSchema,
  envelopeSchema,
  itemSchema,
  extractItems: (envelope: Envelope) => envelope.jobs,
  nativeIdOf: (item: Item) => item.guid,
  mapItem,
}

export const himalayasBrowseSpec: ApiJsonSourceSpec<Config, Envelope, Item> = {
  ...common,
  pageRequest: (config, at) => {
    const url = new URL(BROWSE_URL)
    url.searchParams.set('limit', String(config.pageSize ?? HIMALAYAS_MAX_PAGE_SIZE))
    if (at.cursor !== null) url.searchParams.set('cursor', at.cursor)
    return { request: { url: url.href, headers: { accept: 'application/json' } } }
  },
  nextCursor: (envelope) => envelope.nextCursor ?? null,
  scopeOf: (config) => ({
    namespace: config.namespace,
    query: HIMALAYAS_BROWSE_SCOPE_QUERY,
    configVersion: config.configVersion,
    window: null,
  }),
}

export const himalayasSearchSpec: ApiJsonSourceSpec<Config, Envelope, Item> = {
  ...common,
  pageRequest: (config, at) => {
    const f = config.search ?? {}
    const url = new URL(SEARCH_URL)
    const set = (key: string, value: string | undefined) => {
      if (value !== undefined) url.searchParams.set(key, value)
    }
    set('q', f.q)
    set('country', f.country)
    set('worldwide', f.worldwide === true ? 'true' : undefined)
    set('exclude_worldwide', f.excludeWorldwide === true ? 'true' : undefined)
    set('seniority', f.seniority?.join(','))
    set('employment_type', f.employmentType?.join(','))
    set('company', f.company?.join(','))
    set('timezone', f.timezone)
    set('sort', f.sort)
    set('page', String(at.page))
    return { request: { url: url.href, headers: { accept: 'application/json' } } }
  },
  // The only end marker search gives is an EMPTY page; a short page is not the end.
  nextCursor: (envelope, at) => (envelope.jobs.length === 0 ? null : `page:${at.page + 1}`),
  scopeOf: (config) => ({
    namespace: config.namespace,
    query: canonicalSearchQuery(config.search),
    configVersion: config.configVersion,
    window: null,
  }),
}

export const himalayasProvider = definePagedProvider(himalayasBrowseSpec, (config, ctx) =>
  collectJsonPages(
    {
      ...(config.endpoint === 'search' ? himalayasSearchSpec : himalayasBrowseSpec),
      limits: {
        maxPages: config.maxPages,
        // Search forbids `pageSize` in config, so this is 20 there and the chosen size on browse.
        maxItemsPerPage: config.pageSize ?? HIMALAYAS_MAX_PAGE_SIZE,
      },
    },
    config,
    ctx,
  ),
)
