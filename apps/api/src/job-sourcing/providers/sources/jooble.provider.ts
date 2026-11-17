import { z } from 'zod'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import { QUOTA_PROVIDER_ENV_KEY, type QuotaCredential } from '../../quota-credentials'
import {
  type ApiJsonSourceSpec,
  baseSourceConfigSchema,
  collectJsonPages,
  definePagedProvider,
} from '../api-json.provider'
import type { ReportingJobSourceProvider, Validated } from '../reporting-provider'
import { boundedString, dateRaw, optionalString, urlString } from './as'
import { type MeterOption, requireApiKey, resolveMeter, withSecrets } from './quota-provider'

/**
 * Jooble (`POST https://jooble.org/api/{key}`), the aggregator's REST search.
 *
 * STATUS: KEY-GATED, verified by the owner's controlled smoke of 2026-11-16 (provenance of
 * `__fixtures__/jooble/search-smoke.json`). What that response settled: the envelope is
 * `{totalCount, jobs}`; every field read below is present; `id` is a JSON NUMBER, often past 2^53
 * and sometimes negative; `link` is a jooble.org `/away/<id>` or `/desc/<id>` redirect whose path
 * segment is that id written out in full. See `JOOBLE_SOURCE_STATUS`.
 *
 * - THE KEY IS IN THE URL PATH. That is the documented way and the only one; it makes every
 *   `FetchRequest.url` a credential. The adapter registers the key (and so every form it is written
 *   in, including the percent-encoded one) on the ctx it hands the loop, and the loop redacts
 *   registered secrets from every report field BEFORE it truncates any of them: a key that straddles
 *   a truncation boundary is replaced whole first, never cut in half and emitted as a prefix.
 *   Nothing here logs, traces or throws the URL.
 * - BILLING IS A PARAMETER. Jooble's usage limit is "set per key" and "arranged with Jooble
 *   directly" (public description), and the old "500 lifetime" figure is not a fact this code may
 *   know: the unit and the cost of one request are `options.meter`, and the limit and window live on
 *   the account meter row, not here.
 * - IDENTITY. `id` is Jooble's own posting id; `link` is a Jooble redirect and is the only URL the
 *   response carries, so it is both the posting URL and the application URL. The id is read from a
 *   number or a string. A number past the safe-integer range has already been rounded by the JSON
 *   parse (two postings could share it), so it is NOT used as text; the digits are taken instead
 *   from the link path, and only when they round to the very number the parse produced. The link's
 *   query (`pos`, `scr`, `jobAge`, ...) changes from one search to the next, so a posting that fell
 *   back to its URL would be a new posting on every run: the path id is what keeps it one.
 * - `updated` carries no zone (`2026-11-13T00:00:00.0000000` in the smoke), so the date policy
 *   reports MISSING_ZONE and keeps the raw text; no zone is guessed.
 * - UNVERIFIED: the default page size (the smoke asked for 5), and whether `page` may be a string.
 *   `company` stays optional because the descriptions disagree about it.
 */

export const JOOBLE_SOURCE_STATUS = {
  blocked: false,
  permission: 'KEY_REQUIRED',
  reason:
    'runs only with the Jooble key (JOOBLE_API_KEY); the controlled authenticated smoke of 2026-11-16 verified the payload',
} as const

export const JOOBLE_ADAPTER_VERSION = 'jooble-2'
export const JOOBLE_NAMESPACE = 'jooble'
const ENDPOINT = 'https://jooble.org/api/'
export const JOOBLE_MAX_PAGES_CEILING = 5
/** Bound on one page. The real size is unverified, so this is a fence, not a belief. */
export const JOOBLE_MAX_ITEMS_PER_PAGE = 100
export const JOOBLE_TEXT_MAX_CHARS = 100

const configSchema = baseSourceConfigSchema
  .extend({
    namespace: z.literal(JOOBLE_NAMESPACE).default(JOOBLE_NAMESPACE),
    keywords: z.string().min(1).max(JOOBLE_TEXT_MAX_CHARS),
    location: z.string().min(1).max(JOOBLE_TEXT_MAX_CHARS).optional(),
    maxPages: z.number().int().min(1).max(JOOBLE_MAX_PAGES_CEILING).default(1),
  })
  .strict()
  .refine((c) => c.query === null, { message: 'Jooble search text lives in keywords / location' })
  .refine((c) => c.window === null, { message: 'Jooble has no date window' })
type Config = z.infer<typeof configSchema>

const itemSchema = z.object({
  title: boundedString(ORIGINAL_LIMITS.title),
  link: urlString(),
  company: optionalString(ORIGINAL_LIMITS.companyName),
  location: optionalString(ORIGINAL_LIMITS.location),
  snippet: optionalString(ORIGINAL_LIMITS.description),
  type: optionalString(100),
  updated: dateRaw(),
  id: z.union([z.number(), z.string().max(100)]).nullish(),
})
type Item = z.infer<typeof itemSchema>

/** `jobs` stays OPAQUE so one bad posting is isolated instead of failing the page. */
const envelopeSchema = z.object({
  totalCount: z.number().int().min(0).nullish(),
  jobs: z.array(z.unknown()),
})
type Envelope = z.infer<typeof envelopeSchema>

/** The provider's posting id as text, or `null` when it cannot be trusted as an identity. */
export function joobleNativeId(id: Item['id']): string | null {
  if (typeof id === 'string') return id.trim().length > 0 ? id : null
  // `isSafeInteger` is false for null, undefined, fractions and numbers past 2^53 alike.
  return Number.isSafeInteger(id) ? String(id) : null
}

const LINK_ID = /^\/(?:away|desc)\/(-?\d+)$/

/**
 * The posting id written out in a jooble.org link path, or `null`. Trusted only when it rounds to
 * the number the parse produced: a link that names another posting is never an identity.
 */
export function joobleLinkId(link: string, id: Item['id']): string | null {
  const url = new URL(link)
  if (url.hostname !== 'jooble.org') return null
  const m = LINK_ID.exec(url.pathname)
  // A number is never `===` a string id, so only an id the parse produced as a number matches.
  return m !== null && Number(m[1]) === id ? (m[1] ?? null) : null
}

const joobleIdOf = (item: Item): string | null =>
  joobleNativeId(item.id) ?? joobleLinkId(item.link, item.id)

function makeSpec(apiKey: string, meter: MeterOption): ApiJsonSourceSpec<Config, Envelope, Item> {
  return {
    type: 'JOOBLE_API',
    adapterVersion: JOOBLE_ADAPTER_VERSION,
    configSchema,
    envelopeSchema,
    itemSchema,
    meter,
    pageRequest: (config, at) => ({
      // The key is the last path segment, so the URL is never reported as built: the report states
      // its own safe form, whether or not anyone registered the key.
      reportUrl: `${ENDPOINT}[REDACTED]`,
      request: {
        // The key is a path segment: encoded so a key with a reserved character cannot change the path.
        url: `${ENDPOINT}${encodeURIComponent(apiKey)}`,
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        // An undefined location is dropped by JSON.stringify: no key is sent for it.
        body: JSON.stringify({
          keywords: config.keywords,
          location: config.location,
          page: at.page,
        }),
      },
    }),
    extractItems: (envelope) => envelope.jobs,
    // An empty page ends the walk; so does a page that, at the sizes seen so far, reaches the total.
    nextCursor: (envelope, at) => {
      if (envelope.jobs.length === 0) return null
      const total = envelope.totalCount
      if (total != null && envelope.jobs.length * at.page >= total) return null
      return `page:${at.page + 1}`
    },
    nativeIdOf: joobleIdOf,
    mapItem: (item, config) => ({
      namespace: config.namespace,
      nativeId: joobleIdOf(item),
      url: item.link,
      title: item.title,
      companyName: item.company,
      location: item.location,
      description: item.snippet,
      employmentType: item.type,
      applicationUrl: item.link,
      dates: [{ raw: item.updated, contract: 'ISO_ZONED', semantics: 'UPDATED' }],
    }),
    scopeOf: (config) => ({
      namespace: config.namespace,
      query: JSON.stringify({ keywords: config.keywords, location: config.location }),
      configVersion: config.configVersion,
      window: null,
    }),
  }
}

export interface JoobleOptions {
  credential: QuotaCredential
  /** How Jooble bills this account. Default: one request is one REQUEST. */
  meter?: MeterOption
}

export function createJoobleProvider(
  options: JoobleOptions,
): ReportingJobSourceProvider<Validated<Config>> {
  const meter = resolveMeter(options.meter)
  return definePagedProvider({ type: 'JOOBLE_API', configSchema }, (config, ctx) => {
    // Before the reservation and before any network call: a source without a key costs nothing.
    const apiKey = requireApiKey('JOOBLE_API', QUOTA_PROVIDER_ENV_KEY.jooble, options.credential)
    return collectJsonPages(
      {
        ...makeSpec(apiKey, meter),
        limits: { maxPages: config.maxPages, maxItemsPerPage: JOOBLE_MAX_ITEMS_PER_PAGE },
      },
      config,
      withSecrets(ctx, [apiKey]),
    )
  })
}
