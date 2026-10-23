import { z } from 'zod'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import {
  type ApiJsonSourceSpec,
  baseSourceConfigSchema,
  collectJsonPages,
  definePagedProvider,
  type PageTarget,
} from '../api-json.provider'
import {
  boundedString,
  boundedStringArray,
  dateRaw,
  optionalString,
  positiveSafeInt,
  urlString,
} from './as'

/**
 * Jobicy (`https://jobicy.com/api/jobs`), the public list endpoint with CURSOR pagination.
 *
 * - SCOPE: the public feed carries only the last 7 days, with a 3-hour publication delay, so the
 *   scope is the WINDOW `[now - 7d, now - 3h]` and a run never claims FULL_INVENTORY. The window is
 *   reported, not sent: the API takes no date parameters. `overlapMs` is 0 because a restart must
 *   not claim a window older than the API can serve.
 * - CURSOR LIFETIME: a cursor is valid for 24 h from the FIRST request of a traversal; after that
 *   the provider answers HTTP 400. A capped run stores its cursor, and the next run resumes from
 *   it, so a daily schedule would wedge on a stale cursor forever. The cursor we hand the loop is
 *   therefore `v1.<traversal start>.<provider cursor>`: past 23 h (one hour of margin) or when
 *   the cursor is not ours, the provider cursor is dropped and the walk starts again from the
 *   first page. The traversal start is read from the attempt's window, not from a wall clock, so
 *   the behaviour is a function of the inputs.
 * - LINKS: `url` is the Jobicy listing and, per the terms, the destination of every Apply, so it is
 *   both the source posting URL and the application URL.
 * - METERED STATUS CALLS (`/api/jobs/status`, lifecycle) are NOT made here. The named owner is
 *   Task 4.6 ("status refreshes bounded/metered/resumable").
 */

export const JOBICY_ADAPTER_VERSION = 'jobicy-1'
export const JOBICY_NAMESPACE = 'jobicy'
const ENDPOINT = 'https://jobicy.com/api/jobs'
const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
export const JOBICY_FEED_DAYS = 7
export const JOBICY_PUBLICATION_DELAY_MS = 3 * HOUR_MS
/** Documented cursor lifetime is 24 h; one hour of margin. */
export const JOBICY_CURSOR_TRUSTED_MS = 23 * HOUR_MS
export const JOBICY_MAX_COUNT = 200
export const JOBICY_MAX_PAGES_CEILING = 10
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const configSchema = baseSourceConfigSchema
  .extend({
    namespace: z.literal(JOBICY_NAMESPACE).default(JOBICY_NAMESPACE),
    count: z.number().int().min(1).max(JOBICY_MAX_COUNT).default(100),
    maxPages: z.number().int().min(1).max(JOBICY_MAX_PAGES_CEILING).default(5),
    industry: z.string().min(1).max(50).regex(SLUG).optional(),
    geo: z.string().min(1).max(50).regex(SLUG).optional(),
    tag: z.string().min(1).max(100).optional(),
  })
  .strict()
  .refine((c) => c.query === null, { message: 'Jobicy filters live in industry / geo / tag' })
  .refine((c) => c.window === null, { message: 'Jobicy has no date parameters' })
type Config = z.infer<typeof configSchema>

const itemSchema = z.object({
  id: positiveSafeInt(),
  url: urlString(),
  jobTitle: boundedString(ORIGINAL_LIMITS.title),
  /** Documented as possibly empty: an empty one is quarantined by the observation builder. */
  companyName: boundedString(ORIGINAL_LIMITS.companyName),
  jobIndustry: boundedStringArray(ORIGINAL_LIMITS.tags, ORIGINAL_LIMITS.tag)
    .nullish()
    .transform((v) => v ?? []),
  jobType: boundedStringArray(20, 50)
    .nullish()
    .transform((v) => v ?? []),
  jobGeo: optionalString(ORIGINAL_LIMITS.location),
  jobLevel: optionalString(100),
  jobDescription: optionalString(ORIGINAL_LIMITS.description),
  pubDate: dateRaw(),
})
type Item = z.infer<typeof itemSchema>

/** `jobs` stays OPAQUE so one bad job is isolated. `success: false` on a 200 is drift. */
const envelopeSchema = z.object({
  jobs: z.array(z.unknown()),
  nextCursor: z.string().min(1).nullish(),
  success: z.literal(true).optional(),
})
type Envelope = z.infer<typeof envelopeSchema>

// ---------------------------------------------------------------------------
// The cursor we own
// ---------------------------------------------------------------------------

/** The attempt's clock, as the window's upper edge. Offsets from `now` cancel in every age. */
function clockOf(at: PageTarget): number {
  if (at.window === null) throw new Error('Jobicy requires a window on every page target')
  return at.window.to.getTime()
}

function packCursor(startedAtMs: number, providerCursor: string): string {
  return `v1.${startedAtMs}.${providerCursor}`
}

function unpackCursor(cursor: string): { startedAtMs: number; providerCursor: string } | null {
  const m = /^v1\.(\d{1,15})\.(.+)$/s.exec(cursor)
  return m === null ? null : { startedAtMs: Number(m[1]), providerCursor: String(m[2]) }
}

/** The provider cursor to send (or none) and when this traversal started. */
function traversalOf(at: PageTarget): { startedAtMs: number; providerCursor: string | null } {
  const clock = clockOf(at)
  const stored = at.cursor === null ? null : unpackCursor(at.cursor)
  if (
    stored !== null &&
    clock >= stored.startedAtMs &&
    clock - stored.startedAtMs < JOBICY_CURSOR_TRUSTED_MS
  ) {
    return stored
  }
  return { startedAtMs: clock, providerCursor: null }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** `Belgium,  Germany,  UK` -> `Belgium, Germany, UK`; nothing left -> null. */
function geoText(raw: string | null): string | null {
  if (raw === null) return null
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  return parts.length === 0 ? null : parts.join(', ')
}

/** The provider returns `Any` when no level is specified. */
function levelHint(raw: string | null): string | null {
  const level = raw?.trim() ?? ''
  return level === '' || level === 'Any' ? null : level
}

function scopeQuery(config: Config): string | null {
  const filters = {
    ...(config.geo !== undefined && { geo: config.geo }),
    ...(config.industry !== undefined && { industry: config.industry }),
    ...(config.tag !== undefined && { tag: config.tag }),
  }
  return Object.keys(filters).length === 0 ? null : JSON.stringify(filters)
}

export const jobicySpec: ApiJsonSourceSpec<Config, Envelope, Item> = {
  type: 'JOBICY_API',
  adapterVersion: JOBICY_ADAPTER_VERSION,
  configSchema,
  envelopeSchema,
  itemSchema,
  pageRequest: (config, at) => {
    const url = new URL(ENDPOINT)
    url.searchParams.set('count', String(config.count))
    if (config.geo !== undefined) url.searchParams.set('geo', config.geo)
    if (config.industry !== undefined) url.searchParams.set('industry', config.industry)
    if (config.tag !== undefined) url.searchParams.set('tag', config.tag)
    const { providerCursor } = traversalOf(at)
    if (providerCursor !== null) url.searchParams.set('cursor', providerCursor)
    return { request: { url: url.href, headers: { accept: 'application/json' } } }
  },
  extractItems: (envelope) => envelope.jobs,
  nextCursor: (envelope, at) =>
    envelope.nextCursor == null
      ? null
      : packCursor(traversalOf(at).startedAtMs, envelope.nextCursor),
  nativeIdOf: (item) => String(item.id),
  mapItem: (item, config) => {
    const employmentType = item.jobType.join(', ')
    return {
      namespace: config.namespace,
      nativeId: String(item.id),
      url: item.url,
      title: item.jobTitle,
      companyName: item.companyName,
      location: geoText(item.jobGeo),
      description: item.jobDescription,
      descriptionKind: 'html',
      remote: true,
      employmentType: employmentType === '' ? null : employmentType,
      seniorityHint: levelHint(item.jobLevel),
      tags: item.jobIndustry,
      applicationUrl: item.url,
      dates:
        item.pubDate === null
          ? []
          : [{ raw: item.pubDate, contract: 'ISO_ZONED', semantics: 'PUBLISHED' }],
    }
  },
  scopeOf: (config, now) => ({
    namespace: config.namespace,
    query: scopeQuery(config),
    configVersion: config.configVersion,
    window: {
      from: new Date(now.getTime() - JOBICY_FEED_DAYS * DAY_MS),
      to: new Date(now.getTime() - JOBICY_PUBLICATION_DELAY_MS),
    },
  }),
  overlapMs: 0,
}

export const jobicyProvider = definePagedProvider(jobicySpec, (config, ctx) =>
  collectJsonPages(
    { ...jobicySpec, limits: { maxPages: config.maxPages, maxItemsPerPage: config.count } },
    config,
    ctx,
  ),
)
