import { z } from 'zod'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import { QUOTA_PROVIDER_ENV_KEY, type QuotaCredential } from '../../quota-credentials'
import {
  type ApiJsonSourceSpec,
  baseSourceConfigSchema,
  collectJsonPages,
  definePagedProvider,
} from '../api-json.provider'
import { MAX_RESPONSE_BYTES_CEILING } from '../../http/bounded-fetch'
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
 *   credits, before the request leaves; WITH NO billing observation (the state today) a page
 *   whose request LEFT settles at the whole reservation, so a short or empty one frees nothing; a
 *   page whose request never left (a FAILING cache read or `markSent`; a 304 did leave and settles whole) is RELEASED, charged
 *   nothing, and frees all of it. ONLY once a
 *   `billingObservation` supports per-record billing does the response settle at the number of
 *   jobs it carried (`data.length`) and free the rest (see `billingObservationSchema` for what
 *   that does and does not guarantee). A request that timed out after it left holds the whole
 *   reservation as UNCERTAIN either way, because the credits may have been spent.
 * - `limit` is 1..50 here (the plan's bound; the reference gives a minimum of 1 and no maximum).
 *   Every credit is real money, so the reservation is also capped by the account's meter.
 * - AT LEAST ONE POSTED-DATE FILTER IS REQUIRED by the API; `posted_at_max_age_days` is always sent,
 *   so a config cannot produce a request that lacks one (the requirement is as the published
 *   reference states it; no response has been seen).
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
  // The bounded parse, so a hostile body cannot make the cost reading the expensive part. Its byte
  // bound is the transport's CEILING, not the default: the body was already admitted by the
  // transport under whatever cap this source declared, and a smaller bound here would silently
  // switch the precision off (every body refused, every page charged whole) the day a cap is raised.
  const parsed = parseBoundedJson(bodyText, {
    ...DEFAULT_JSON_LIMITS,
    maxBytes: MAX_RESPONSE_BYTES_CEILING,
  })
  // A refused parse has no `value`, so it reads as undefined below and is refused by the
  // Array.isArray check, exactly as an explicit early return would: no branch to get wrong.
  const data = (parsed as { value?: { data?: unknown } | null }).value?.data
  return Array.isArray(data) ? data.length : null
}

/** The one definition of identity, used by the spec's `nativeIdOf` AND by the mapping. */
const theirstackNativeId = (item: Item): string => String(item.id)

function makeSpec(
  apiKey: string,
  config: Config,
  billingVerified: boolean,
): ApiJsonSourceSpec<Config, Envelope, Item> {
  return {
    type: 'THEIRSTACK_API',
    adapterVersion: THEIRSTACK_ADAPTER_VERSION,
    configSchema,
    envelopeSchema,
    itemSchema,
    meter: {
      unit: 'RECORD',
      amountPerRequest: config.limit,
      // Settling below the reservation FREES budget that may have been really spent (SR-M-1:
      // measured, a limit of 100 reserved at 10 a page and settled at 1 permitted 91 pages, 910
      // worst-case credits), so the reading is attached only once the billing basis has been
      // observed. Until then every page whose request left is charged its worst case. Once attached, the meter is only as
      // accurate as the observation (see `billingObservationSchema`).
      ...(billingVerified && { incurredAmount: theirstackIncurredCredits }),
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

/**
 * THE EVIDENCE BEHIND "TheirStack bills one credit per job returned", as a record a reader can
 * check, instead of a boolean someone sets. The owner's authenticated smoke makes ONE search that
 * returns FEWER jobs than it asked for and writes down what it saw:
 *
 * - `observedAt`: when (ISO, UTC, milliseconds);
 * - `requestedLimit`: the `limit` sent;
 * - `jobsReturned`: `data.length` of the response;
 * - `creditBalanceBefore` / `creditBalanceAfter`: TheirStack's own credit balance either side of
 *   that one request, read from its account (HOW it is read - dashboard or API - is not known to
 *   this code, which is why the fields are plain numbers).
 *
 * "Verified" means only that the record SUPPORTS per-record billing: `2 <= jobsReturned <
 * requestedLimit` and the balance fell by exactly `jobsReturned`. That separates per-record billing
 * from two alternatives, and from no others:
 * - It rules out billing per `limit` (the drop would be `requestedLimit`, not `jobsReturned`), which
 *   is why a run that returned the whole `limit` verifies nothing.
 * - It rules out a flat charge of ONE credit per request only from 2 returned jobs up: at exactly
 *   one job and a drop of one, per-record and flat-1 look the same, so that does not verify.
 * - It does NOT rule out every alternative. A flat charge that happens to equal `jobsReturned`, or
 *   other spend on the account between the two balance reads, would also pass. One observation is
 *   evidence, not proof; the smoke should ask for a `limit` of at least 3 and be run with nothing
 *   else spending the account's credits.
 * - A run that returned nothing cannot tell anything, so it does not verify.
 *
 * THE MONEY DIRECTION, BRANCH BY BRANCH (it is not one direction), and EVERY branch below also
 * depends on what TheirStack really charges, which nobody has observed:
 * - UNVERIFIED (no observation, or one that does not support per-record billing), page whose request
 *   LEFT: charged its worst case, `limit` credits, and frees nothing. That over-counts ONLY IF the
 *   published statement is true (one credit per returned job, so a page costs at most `limit`). If
 *   the real charge were a flat `F` larger than `limit`, even this branch under-counts. So "the
 *   worst case" is the safe reading of the published statement, not a measured ceiling.
 * - UNVERIFIED, page whose request NEVER LEFT (a failing cache read or `markSent`): RELEASED, charged
 *   nothing, the whole reservation freed. Correct, because nothing was spent.
 * - Any page whose request left and whose outcome is unknown (timeout): held UNCERTAIN whole.
 * - VERIFIED, and the evidence is right: pages settle at `data.length`, which is the real charge.
 * - VERIFIED IN ERROR (the residuals above): the adapter attaches an actual cost and the difference
 *   is freed for re-reservation, so the meter UNDER-counts. Route: the true charge is a flat `F`
 *   per request and `F` happened to equal `jobsReturned` on the one observed page; a later page that
 *   returns fewer than `F` records is then settled at its record count while `F` was really spent.
 *   The bounds in the loop's `readIncurred` (a whole number in `0..reserved`, 0 recorded as 1) do
 *   NOT close this: `data.length` is always inside them. They stop an out-of-range reading from
 *   being believed, and raising the threshold can only move a source toward the worst case;
 *   neither makes a wrongly verified source safe.
 *   HOW BAD (measured by security review, for a configured `limit` >= F): full pages settle at
 *   `limit` (an over-count) and the run ends on the first short page, so the under-count is at most
 *   `F - 1` credits per collection attempt. Real, repeated every attempt, and not a multiple of the
 *   budget. For a configured `limit` BELOW F that bound does not apply (`requestedLimit` in the
 *   observation is independent of the configured `limit`): every full page then settles at `limit`
 *   and under-counts by `F - limit`, for up to `maxPages` (at most 5) pages per attempt - derived by
 *   reading, not measured.
 * "Worst case per page" is therefore a statement about the unverified branch, conditional on the
 * published billing statement. Verifying a source is a decision to trust the observation with money,
 * not a formality. (This meter's unit is `RECORD`, credits.)
 *
 * It lives beside the adapter that bills; the registration task persists it (in the source's
 * provenance) and passes it here. NO OBSERVATION IS COMMITTED TODAY, so the source is unverified.
 */
export const billingObservationSchema = z
  .object({
    observedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    requestedLimit: z.number().int().min(1).max(THEIRSTACK_MAX_LIMIT),
    jobsReturned: z.number().int().min(0).max(THEIRSTACK_MAX_LIMIT),
    creditBalanceBefore: z.number().int().min(0),
    creditBalanceAfter: z.number().int().min(0),
  })
  .strict()
export type BillingObservation = z.infer<typeof billingObservationSchema>

/**
 * Whether an observation SUPPORTS per-record billing - evidence, not proof (see above; this was
 * named `billingProvenBy` until round 4). Throws on a malformed record.
 */
export function billingSupportedBy(raw: unknown): boolean {
  const o = billingObservationSchema.parse(raw)
  return (
    o.jobsReturned >= 2 &&
    o.jobsReturned < o.requestedLimit &&
    o.creditBalanceBefore - o.creditBalanceAfter === o.jobsReturned
  )
}

export interface TheirStackOptions {
  credential: QuotaCredential
  /**
   * The smoke's evidence. ABSENT (today): every page is charged its worst case. PRESENT: it is
   * parsed (a malformed record throws when the provider is built) and the per-record reading is
   * attached only if it supports per-record billing (evidence, not proof: an observation that is
   * wrong in the ways `billingObservationSchema` lists makes the meter under-count). There is no
   * flag to set: the reading follows the evidence, because a freed difference is re-reservable
   * within the window and an unverified reading turns a budget that the worst-case reading respects into a
   * multiple of it (measured 9.1x).
   */
  billingObservation?: unknown
}

export function createTheirStackProvider(
  options: TheirStackOptions,
): ReportingJobSourceProvider<Validated<Config>> {
  // Decided once, when the provider is built, from evidence - never from a flag.
  const billingVerified =
    options.billingObservation !== undefined && billingSupportedBy(options.billingObservation)
  return definePagedProvider({ type: 'THEIRSTACK_API', configSchema }, (config, ctx) => {
    // Before the reservation and before any network call: a source without a key costs nothing.
    const apiKey = requireApiKey(
      'THEIRSTACK_API',
      QUOTA_PROVIDER_ENV_KEY.theirstack,
      options.credential,
    )
    return collectJsonPages(
      {
        ...makeSpec(apiKey, config, billingVerified),
        limits: { maxPages: config.maxPages, maxItemsPerPage: config.limit },
      },
      config,
      withSecrets(ctx, [apiKey]),
    )
  })
}
