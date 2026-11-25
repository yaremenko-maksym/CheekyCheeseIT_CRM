import { createHash } from 'node:crypto'
import { z } from 'zod'
import { MAX_NATIVE_ID_CHARS } from '../../normalize/identity-key'
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
 * JSearch on RapidAPI (`GET https://jsearch.p.rapidapi.com/search-v2`), Google-for-Jobs aggregation.
 *
 * WHICH PRODUCT, recorded: the RapidAPI listing, because the env key is `RAPIDAPI_KEY` (an account
 * key sold by RapidAPI) and the seeded rows were written against it. The same data is also sold
 * directly by OpenWeb Ninja at `api.openwebninja.com/jsearch/search-v2` with an `x-api-key` header
 * and CURSOR paging - a different host, auth and paging contract. That is a separate adapter if the
 * owner moves accounts; this one does not speak it.
 *
 * STATUS: KEY-GATED, verified by the owner's controlled smoke of 2026-11-16 (provenance of
 * `__fixtures__/jsearch/search-v2-smoke.json`). What that response settled:
 * - the v1 path `/search` answers 404; `/search-v2` answers `{status, request_id, parameters,
 *   data: {jobs, cursor}}` for EXACTLY the parameters sent here (query, num_pages=1, country=us,
 *   date_posted, work_from_home). Nothing else is sent: no other parameter set was tried.
 * - ONE PAGE PER RUN. The next page is reached through `data.cursor`, and the request parameter
 *   that takes it is not in any documentation readable without an account, so the adapter never
 *   follows it; the daily cadence is what brings new postings in.
 * - a remote posting has null job_city / job_state / job_country and only `job_location`
 *   ("Anywhere"); `job_id` is an opaque string of 414 characters.
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
 * - IDENTITY. `job_id` is the provider's opaque id. The v2 ids (414 characters) are past the
 *   identity seam's 256, so a longer id is replaced by `sha256:<hex>` of the WHOLE id: the apply
 *   URL is no identity (Indeed `viewjob?jk=` links lose their query on canonicalisation and
 *   collide). No JSearch row ever ran (seeded disabled), so no stored identity changes. `job_apply_link` is where an applicant goes and
 *   is a third-party board, so it is both the posting URL and the application URL (no JSearch-hosted
 *   page is part of the response used here).
 */

export const JSEARCH_SOURCE_STATUS = {
  blocked: false,
  permission: 'KEY_REQUIRED',
  reason:
    'runs only with the RapidAPI key (RAPIDAPI_KEY); the controlled authenticated smoke of 2026-11-16 verified the search-v2 payload',
} as const

export const JSEARCH_ADAPTER_VERSION = 'jsearch-2'
export const JSEARCH_NAMESPACE = 'jsearch'
const ENDPOINT = 'https://jsearch.p.rapidapi.com/search-v2'
export const JSEARCH_HOST = 'jsearch.p.rapidapi.com'
export const JSEARCH_QUERY_MAX_CHARS = 120
/** One page per run (see STATUS): the cursor parameter is unverified. */
export const JSEARCH_MAX_PAGES_CEILING = 1
/** The smoke's ids are 414 characters; this is a fence, not a belief. */
export const JSEARCH_JOB_ID_MAX_CHARS = 600
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
  job_id: z.string().trim().max(JSEARCH_JOB_ID_MAX_CHARS).min(1),
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
  job_location: optionalString(200),
})
type Item = z.infer<typeof itemSchema>

/** `jobs` stays OPAQUE so one bad posting is isolated instead of failing the page. */
const envelopeSchema = z.object({ data: z.object({ jobs: z.array(z.unknown()) }) })
type Envelope = z.infer<typeof envelopeSchema>

function locationText(item: Item): string {
  const parts = [item.job_city, item.job_state, item.job_country]
    .filter((p) => p !== null && p !== '')
    .join(', ')
  return parts === '' ? (item.job_location ?? '') : parts
}

/** The one definition of identity, used by the spec's `nativeIdOf` AND by the mapping. */
const jsearchNativeId = (item: Item): string =>
  item.job_id.length > MAX_NATIVE_ID_CHARS
    ? `sha256:${createHash('sha256').update(item.job_id).digest('hex')}`
    : item.job_id

function makeSpec(apiKey: string, meter: MeterOption): ApiJsonSourceSpec<Config, Envelope, Item> {
  return {
    type: 'JSEARCH_API',
    adapterVersion: JSEARCH_ADAPTER_VERSION,
    configSchema,
    envelopeSchema,
    itemSchema,
    meter,
    pageRequest: (config) => {
      const url = new URL(ENDPOINT)
      url.searchParams.set('query', config.query)
      // Always one page per call: see the billing note above.
      url.searchParams.set('num_pages', '1')
      // The smoke's value; the seeded queries are worded for remote work, not for a country.
      url.searchParams.set('country', 'us')
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
    extractItems: (envelope) => envelope.data.jobs,
    // One page per run: `data.cursor` is never followed (see STATUS).
    nextCursor: () => null,
    nativeIdOf: jsearchNativeId,
    mapItem: (item, config) => ({
      namespace: config.namespace,
      nativeId: jsearchNativeId(item),
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
  return definePagedProvider({ type: 'JSEARCH_API', configSchema }, async (config, ctx) => {
    // Before the reservation and before any network call: a source without a key costs nothing.
    const apiKey = requireApiKey('JSEARCH_API', QUOTA_PROVIDER_ENV_KEY.jsearch, options.credential)
    const batch = await collectJsonPages(
      {
        ...makeSpec(apiKey, meter),
        limits: { maxPages: config.maxPages, maxItemsPerPage: JSEARCH_MAX_ITEMS_PER_PAGE },
      },
      config,
      withSecrets(ctx, [apiKey]),
    )
    // CR-M-4 (backlog 470): one page of ranked search results, its cursor never followed, is a
    // capped search, not a window of the feed: a posting off that page was not looked at, so its
    // absence must feed no WINDOW expiry. The cap is the adapter's, so the claim is withdrawn here.
    return batch.coverage === 'WINDOW' ? { ...batch, coverage: 'PARTIAL' } : batch
  })
}
