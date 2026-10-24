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
 * JSearch on RapidAPI (`GET https://jsearch.p.rapidapi.com/search`), Google-for-Jobs aggregation.
 *
 * WHICH PRODUCT, recorded: the RapidAPI listing, because the env key is `RAPIDAPI_KEY` (an account
 * key sold by RapidAPI) and the seeded rows were written against it. The same data is also sold
 * directly by OpenWeb Ninja at `api.openwebninja.com/jsearch/search-v2` with an `x-api-key` header
 * and CURSOR paging - a different host, auth and paging contract. That is a separate adapter if the
 * owner moves accounts; this one does not speak it.
 *
 * STATUS: BLOCKED. No key is provisioned and none may be. The parameter names (`query`, `page`,
 * `num_pages`, `date_posted`, `work_from_home`) and the job field names are from the public
 * listings, not from a response (provenance file). See `JSEARCH_SOURCE_STATUS`.
 *
 * - ONE ACCOUNT METER, THREE QUERIES. Each seeded query is its own source row and its own run, and
 *   all of them draw on the one RapidAPI subscription: the account key is the binding's
 *   (`jsearch:rapidapi-main`), not this adapter's, so the meter row is shared by construction and
 *   a run that finds the account spent stops with COST_STOP. The adapter holds no counter.
 * - BILLING OF `num_pages` COULD NOT BE VERIFIED. No documentation reachable without an account
 *   states whether `num_pages > 1` bills as several requests. So this adapter ALWAYS sends
 *   `num_pages=1` and reserves exactly one REQUEST per call: whatever the rule is, one call of one
 *   page costs one. The meter is a parameter for when the subscription's real rule is known.
 * - `date_posted=week` and `work_from_home=true` are the documented filters; the seed's
 *   `remote_jobs_only` is not a name any listing shows.
 * - IDENTITY. `job_id` is the provider's opaque id; `job_apply_link` is where an applicant goes and
 *   is a third-party board, so it is both the posting URL and the application URL (no JSearch-hosted
 *   page is part of the response used here).
 */

export const JSEARCH_SOURCE_STATUS = {
  blocked: true,
  permission: 'KEY_REQUIRED',
  reason:
    'no RapidAPI key is provisioned and none may be before the owner runs a controlled authenticated smoke; payload shapes and the num_pages billing rule are not verified against a response',
} as const

export const JSEARCH_ADAPTER_VERSION = 'jsearch-1'
export const JSEARCH_NAMESPACE = 'jsearch'
const ENDPOINT = 'https://jsearch.p.rapidapi.com/search'
export const JSEARCH_HOST = 'jsearch.p.rapidapi.com'
export const JSEARCH_QUERY_MAX_CHARS = 120
export const JSEARCH_MAX_PAGES_CEILING = 5
/** The documented page size is 10; this is a fence, not a belief. */
export const JSEARCH_MAX_ITEMS_PER_PAGE = 20
export const JSEARCH_DATE_POSTED = ['all', 'today', '3days', 'week', 'month'] as const

const configSchema = baseSourceConfigSchema
  .extend({
    namespace: z.literal(JSEARCH_NAMESPACE).default(JSEARCH_NAMESPACE),
    query: z.string().min(1).max(JSEARCH_QUERY_MAX_CHARS),
    datePosted: z.enum(JSEARCH_DATE_POSTED).default('week'),
    remoteOnly: z.boolean().default(true),
    maxPages: z.number().int().min(1).max(JSEARCH_MAX_PAGES_CEILING).default(1),
  })
  .strict()
  .refine((c) => c.window === null, { message: 'JSearch takes datePosted, not a window' })
type Config = z.infer<typeof configSchema>

const itemSchema = z.object({
  job_id: boundedString(200).min(1),
  job_title: boundedString(ORIGINAL_LIMITS.title),
  employer_name: boundedString(ORIGINAL_LIMITS.companyName),
  job_apply_link: urlString(),
  job_description: optionalString(ORIGINAL_LIMITS.description),
  job_posted_at_datetime_utc: dateRaw(),
  job_city: optionalString(200),
  job_state: optionalString(200),
  job_country: optionalString(100),
  job_employment_type: optionalString(100),
  job_is_remote: z.boolean().nullish(),
})
type Item = z.infer<typeof itemSchema>

/** `data` stays OPAQUE so one bad posting is isolated instead of failing the page. */
const envelopeSchema = z.object({ data: z.array(z.unknown()) })
type Envelope = z.infer<typeof envelopeSchema>

function locationText(item: Item): string {
  return [item.job_city, item.job_state, item.job_country]
    .filter((p) => p !== null && p !== '')
    .join(', ')
}

function makeSpec(apiKey: string, meter: MeterOption): ApiJsonSourceSpec<Config, Envelope, Item> {
  return {
    type: 'JSEARCH_API',
    adapterVersion: JSEARCH_ADAPTER_VERSION,
    configSchema,
    envelopeSchema,
    itemSchema,
    meter,
    pageRequest: (config, at) => {
      const url = new URL(ENDPOINT)
      url.searchParams.set('query', config.query)
      url.searchParams.set('page', String(at.page))
      // Always one page per call: see the billing note above.
      url.searchParams.set('num_pages', '1')
      url.searchParams.set('date_posted', config.datePosted)
      if (config.remoteOnly) url.searchParams.set('work_from_home', 'true')
      return {
        request: {
          url: url.href,
          headers: {
            accept: 'application/json',
            'x-rapidapi-key': apiKey,
            'x-rapidapi-host': JSEARCH_HOST,
          },
        },
      }
    },
    extractItems: (envelope) => envelope.data,
    // An empty page is the only end marker the listing gives.
    nextCursor: (envelope, at) => (envelope.data.length === 0 ? null : `page:${at.page + 1}`),
    nativeIdOf: (item) => item.job_id,
    mapItem: (item, config) => ({
      namespace: config.namespace,
      nativeId: item.job_id,
      url: item.job_apply_link,
      title: item.job_title,
      companyName: item.employer_name,
      location: locationText(item),
      description: item.job_description,
      descriptionKind: 'text',
      remote: item.job_is_remote ?? null,
      employmentType: item.job_employment_type,
      applicationUrl: item.job_apply_link,
      dates: [
        { raw: item.job_posted_at_datetime_utc, contract: 'ISO_ZONED', semantics: 'PUBLISHED' },
      ],
    }),
    scopeOf: (config) => ({
      namespace: config.namespace,
      query: JSON.stringify({
        query: config.query,
        datePosted: config.datePosted,
        remoteOnly: config.remoteOnly,
      }),
      configVersion: config.configVersion,
      window: null,
    }),
  }
}

export interface JSearchOptions {
  credential: QuotaCredential
  /** How the subscription bills a call. Default: one call is one REQUEST. */
  meter?: MeterOption
}

export function createJSearchProvider(
  options: JSearchOptions,
): ReportingJobSourceProvider<Validated<Config>> {
  const meter = resolveMeter(options.meter)
  return definePagedProvider({ type: 'JSEARCH_API', configSchema }, (config, ctx) => {
    // Before the reservation and before any network call: a source without a key costs nothing.
    const apiKey = requireApiKey('JSEARCH_API', QUOTA_PROVIDER_ENV_KEY.jsearch, options.credential)
    return collectJsonPages(
      {
        ...makeSpec(apiKey, meter),
        limits: { maxPages: config.maxPages, maxItemsPerPage: JSEARCH_MAX_ITEMS_PER_PAGE },
      },
      config,
      withSecrets(ctx, [apiKey]),
    )
  })
}
