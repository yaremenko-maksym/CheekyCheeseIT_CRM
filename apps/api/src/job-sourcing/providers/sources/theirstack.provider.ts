import { z } from 'zod'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import { QUOTA_PROVIDER_ENV_KEY, type QuotaCredential } from '../../quota-credentials'
import {
  type ApiJsonSourceSpec,
  baseSourceConfigSchema,
  collectJsonPages,
  definePagedProvider,
} from '../api-json.provider'
import { DEFAULT_JSON_LIMITS, parseBoundedJson } from '../bounded-json'
import type { ReportingJobSourceProvider, Validated } from '../reporting-provider'
import {
  boundedString,
  dateRaw,
  optionalString,
  optionalUrlString,
  positiveSafeInt,
  urlString,
} from './as'
import { requireApiKey, withSecrets } from './quota-provider'

/**
 * TheirStack (`POST https://api.theirstack.com/v1/jobs/search`), the hiring-signal job index.
 *
 * STATUS: BLOCKED. No key is provisioned and none may be; the payload shapes are from TheirStack's
 * published API reference (provenance file), not from a response. The first authenticated call is
 * the owner's controlled smoke. See `THEIRSTACK_SOURCE_STATUS`.
 *
 * - BILLING IS PER RETURNED RECORD. The reference says the endpoint "consumes 1 API credit for each
 *   job returned in the response" and lists no per-request charge. So the meter unit is `RECORD`,
 *   not `REQUEST`, and the two never share a counter. A page is RESERVED at its worst case, `limit`
 *   credits, before the request leaves; the response settles at the number of jobs it actually
 *   carried (`data.length`), so a short or empty page frees the rest; and a request that timed out
 *   after it left holds the whole reservation as UNCERTAIN, because the credits may have been spent.
 * - `limit` is 1..50 here (the plan's bound; the reference gives a minimum of 1 and no maximum).
 *   Every credit is real money, so the reservation is also capped by the account's meter.
 * - AT LEAST ONE POSTED-DATE FILTER IS REQUIRED by the API; `posted_at_max_age_days` is always sent,
 *   so a config can never produce a request the API refuses for that reason.
 * - `include_total_results` is never sent ("significantly slows down responses"), so the end of the
 *   inventory is a page shorter than `limit`.
 * - PAGES ARE 0-BASED on the wire (`page` minimum 0, default 0) and 1-based in the loop.
 * - IDENTITY. `id` is TheirStack's posting id. `url` is read as the posting URL and `final_url` as
 *   the application URL; the reference lists the names without describing them, so which is which is
 *   INFERRED from the names and is the first thing the smoke must confirm. `source_url` (the board
 *   the posting was found on) is not used.
 */

export const THEIRSTACK_SOURCE_STATUS = {
  blocked: true,
  permission: 'KEY_REQUIRED',
  reason:
    'no API key is provisioned and none may be before the owner runs a controlled authenticated smoke; payload shapes are from the published API reference, not from a response',
} as const

export const THEIRSTACK_ADAPTER_VERSION = 'theirstack-1'
export const THEIRSTACK_NAMESPACE = 'theirstack'
const ENDPOINT = 'https://api.theirstack.com/v1/jobs/search'
export const THEIRSTACK_MAX_LIMIT = 50
export const THEIRSTACK_MAX_AGE_DAYS = 30
export const THEIRSTACK_MAX_PAGES_CEILING = 5
/** Documented `job_seniority_or` values, verbatim. */
export const THEIRSTACK_SENIORITY = ['c_level', 'staff', 'senior', 'junior', 'mid_level'] as const
/** Documented `workplace_types_or` values, verbatim. */
export const THEIRSTACK_WORKPLACE = ['on_site', 'hybrid', 'remote'] as const

const configSchema = baseSourceConfigSchema
  .extend({
    namespace: z.literal(THEIRSTACK_NAMESPACE).default(THEIRSTACK_NAMESPACE),
    limit: z.number().int().min(1).max(THEIRSTACK_MAX_LIMIT).default(25),
    seniority: z
      .array(z.enum(THEIRSTACK_SENIORITY))
      .min(1)
      .max(THEIRSTACK_SENIORITY.length)
      .optional(),
    workplaceTypes: z
      .array(z.enum(THEIRSTACK_WORKPLACE))
      .min(1)
      .max(THEIRSTACK_WORKPLACE.length)
      .default(['remote']),
    maxAgeDays: z.number().int().min(1).max(THEIRSTACK_MAX_AGE_DAYS).default(7),
    maxPages: z.number().int().min(1).max(THEIRSTACK_MAX_PAGES_CEILING).default(1),
  })
  .strict()
  .refine((c) => c.query === null, {
    message: 'TheirStack filters live in seniority / workplaceTypes',
  })
  .refine((c) => c.window === null, { message: 'TheirStack takes maxAgeDays, not a window' })
type Config = z.infer<typeof configSchema>

const itemSchema = z.object({
  id: positiveSafeInt(),
  job_title: boundedString(ORIGINAL_LIMITS.title),
  url: urlString(),
  final_url: optionalUrlString(),
  company: boundedString(ORIGINAL_LIMITS.companyName),
  date_posted: dateRaw(),
  location: optionalString(ORIGINAL_LIMITS.location),
  remote: z.boolean().nullish(),
  seniority: optionalString(50),
  description: optionalString(ORIGINAL_LIMITS.description),
})
type Item = z.infer<typeof itemSchema>

/** `data` stays OPAQUE so one bad posting is isolated instead of failing the page. */
const envelopeSchema = z.object({ data: z.array(z.unknown()) })
type Envelope = z.infer<typeof envelopeSchema>

/**
 * The credits a response consumed: one per job it carries. `null` when the body is not the shape
 * that lets the count be read, which the loop treats as "charge the whole reservation".
 */
export function theirstackIncurredCredits(bodyText: string): number | null {
  // The bounded parse, so a hostile body cannot make the cost reading the expensive part.
  const parsed = parseBoundedJson(bodyText, DEFAULT_JSON_LIMITS)
  // Stryker disable next-line ConditionalExpression: equivalent - a refused parse carries no `value`, so reading past this line yields undefined, which the Array.isArray check below refuses exactly as `return null` does
  if (!parsed.ok) return null
  const data = (parsed.value as { data?: unknown } | null)?.data
  return Array.isArray(data) ? data.length : null
}

/** The one definition of identity, used by the spec's `nativeIdOf` AND by the mapping. */
const theirstackNativeId = (item: Item): string => String(item.id)

function makeSpec(apiKey: string, config: Config): ApiJsonSourceSpec<Config, Envelope, Item> {
  return {
    type: 'THEIRSTACK_API',
    adapterVersion: THEIRSTACK_ADAPTER_VERSION,
    configSchema,
    envelopeSchema,
    itemSchema,
    meter: {
      unit: 'RECORD',
      amountPerRequest: config.limit,
      incurredAmount: theirstackIncurredCredits,
    },
    pageRequest: (c, at) => ({
      request: {
        url: ENDPOINT,
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          page: at.page - 1,
          limit: c.limit,
          posted_at_max_age_days: c.maxAgeDays,
          workplace_types_or: c.workplaceTypes,
          // An undefined seniority is dropped by JSON.stringify: no key is sent for it.
          job_seniority_or: c.seniority,
        }),
      },
    }),
    extractItems: (envelope) => envelope.data,
    // A page shorter than the limit is the last one; a full page may have another behind it.
    nextCursor: (envelope, at) =>
      envelope.data.length >= config.limit ? `page:${at.page + 1}` : null,
    nativeIdOf: theirstackNativeId,
    mapItem: (item, c) => ({
      namespace: c.namespace,
      nativeId: theirstackNativeId(item),
      url: item.url,
      title: item.job_title,
      companyName: item.company,
      location: item.location,
      description: item.description,
      descriptionKind: 'text',
      remote: item.remote ?? null,
      seniorityHint: item.seniority,
      applicationUrl: item.final_url,
      dates: [{ raw: item.date_posted, contract: 'ISO_ZONED', semantics: 'PUBLISHED' }],
    }),
    scopeOf: (c, now) => ({
      namespace: c.namespace,
      query: JSON.stringify({ seniority: c.seniority, workplaceTypes: c.workplaceTypes }),
      configVersion: c.configVersion,
      window: { from: new Date(now.getTime() - c.maxAgeDays * 86_400_000), to: now },
    }),
  }
}

export interface TheirStackOptions {
  credential: QuotaCredential
}

export function createTheirStackProvider(
  options: TheirStackOptions,
): ReportingJobSourceProvider<Validated<Config>> {
  return definePagedProvider({ type: 'THEIRSTACK_API', configSchema }, (config, ctx) => {
    // Before the reservation and before any network call: a source without a key costs nothing.
    const apiKey = requireApiKey(
      'THEIRSTACK_API',
      QUOTA_PROVIDER_ENV_KEY.theirstack,
      options.credential,
    )
    return collectJsonPages(
      {
        ...makeSpec(apiKey, config),
        limits: { maxPages: config.maxPages, maxItemsPerPage: config.limit },
      },
      config,
      withSecrets(ctx, [apiKey]),
    )
  })
}
