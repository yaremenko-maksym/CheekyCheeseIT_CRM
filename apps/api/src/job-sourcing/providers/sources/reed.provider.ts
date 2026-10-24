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
import { boundedString, dateRaw, optionalString, positiveSafeInt, urlString } from './as'
import { requireApiKey, withSecrets } from './quota-provider'

/**
 * Reed (`GET https://www.reed.co.uk/api/1.0/search`), the UK job board's Jobseeker API.
 *
 * STATUS: BLOCKED. No key is provisioned and none may be. Reed's page documents the endpoint, the
 * Basic-auth rule and the query parameters, but names response fields only as labels ("Job Id",
 * "Employer Name"), so the JSON field names and the `dd/MM/yyyy` date format are from the API's
 * widely published shape, not from a response (provenance file). Reed's terms, any quota and any
 * UK-only eligibility rule were not found on any page that could be read without a key. See
 * `REED_SOURCE_STATUS`.
 *
 * - AUTH is HTTP Basic with the key as the USERNAME and an empty password: `base64("<key>:")`. That
 *   encoding is NOT `base64("<key>")`, which is the form the loop's redaction already knows, so the
 *   adapter registers the `key:` form as a secret itself.
 * - DATES are `dd/MM/yyyy` (`REED_DMY`), calendar-validated by the date policy: `31/02/2026` is
 *   INVALID with the raw text kept, never rolled over into March.
 * - UK. Every Reed posting is for work in the United Kingdom, and `locationName` is a town
 *   ("London"). The location the observation carries is `<town>, United Kingdom`, so a downstream
 *   country rule sees the country the board never states. Assumption, recorded in the PR.
 * - PAGING is `resultsToSkip` / `resultsToTake` (take is limited to 100). The walk ends on a short
 *   page or when the total is reached.
 * - UNMETERED: no quota is documented or seeded for Reed (`NULL`), so no reservation is made. A
 *   quota, once known, is the account meter's to hold.
 */

export const REED_SOURCE_STATUS = {
  blocked: true,
  permission: 'KEY_REQUIRED',
  reason:
    'no API key is provisioned and none may be before the owner runs a controlled authenticated smoke; response field names and the date format are not verified against a response, and Reed terms/eligibility were not found',
} as const

export const REED_ADAPTER_VERSION = 'reed-1'
export const REED_NAMESPACE = 'reed'
const ENDPOINT = 'https://www.reed.co.uk/api/1.0/search'
/** The documented limit of `resultsToTake`. */
export const REED_MAX_TAKE = 100
export const REED_MAX_PAGES_CEILING = 5
export const REED_TEXT_MAX_CHARS = 100
export const REED_COUNTRY = 'United Kingdom'

const configSchema = baseSourceConfigSchema
  .extend({
    namespace: z.literal(REED_NAMESPACE).default(REED_NAMESPACE),
    keywords: z.string().min(1).max(REED_TEXT_MAX_CHARS),
    locationName: z.string().min(1).max(REED_TEXT_MAX_CHARS).optional(),
    resultsToTake: z.number().int().min(1).max(REED_MAX_TAKE).default(REED_MAX_TAKE),
    maxPages: z.number().int().min(1).max(REED_MAX_PAGES_CEILING).default(1),
  })
  .strict()
  .refine((c) => c.query === null, { message: 'Reed search text lives in keywords / locationName' })
  .refine((c) => c.window === null, { message: 'Reed has no date window' })
type Config = z.infer<typeof configSchema>

const itemSchema = z.object({
  jobId: positiveSafeInt(),
  employerName: boundedString(ORIGINAL_LIMITS.companyName),
  jobTitle: boundedString(ORIGINAL_LIMITS.title),
  locationName: optionalString(ORIGINAL_LIMITS.location),
  jobDescription: optionalString(ORIGINAL_LIMITS.description),
  date: dateRaw(),
  expirationDate: dateRaw(),
  jobUrl: urlString(),
})
type Item = z.infer<typeof itemSchema>

/** `results` stays OPAQUE so one bad posting is isolated instead of failing the page. */
const envelopeSchema = z.object({
  results: z.array(z.unknown()),
  totalResults: z.number().int().min(0).nullish(),
})
type Envelope = z.infer<typeof envelopeSchema>

/** `<town>, United Kingdom`, or just the country when the board names no town. */
export function reedLocation(locationName: string | null): string {
  const town = locationName?.trim() ?? ''
  return town === '' ? REED_COUNTRY : `${town}, ${REED_COUNTRY}`
}

/** `Authorization: Basic <base64("<key>:")>` - the key is the username, the password is empty. */
export function reedBasicAuth(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`, 'utf8').toString('base64')}`
}

function makeSpec(apiKey: string, config: Config): ApiJsonSourceSpec<Config, Envelope, Item> {
  return {
    type: 'REED_API',
    adapterVersion: REED_ADAPTER_VERSION,
    configSchema,
    envelopeSchema,
    itemSchema,
    pageRequest: (c, at) => {
      const url = new URL(ENDPOINT)
      url.searchParams.set('keywords', c.keywords)
      if (c.locationName !== undefined) url.searchParams.set('locationName', c.locationName)
      url.searchParams.set('resultsToTake', String(c.resultsToTake))
      url.searchParams.set('resultsToSkip', String((at.page - 1) * c.resultsToTake))
      return {
        request: {
          url: url.href,
          headers: { accept: 'application/json', authorization: reedBasicAuth(apiKey) },
        },
      }
    },
    extractItems: (envelope) => envelope.results,
    nextCursor: (envelope, at) => {
      const seen = (at.page - 1) * config.resultsToTake + envelope.results.length
      if (envelope.results.length < config.resultsToTake) return null
      const total = envelope.totalResults
      if (total != null && seen >= total) return null
      return `page:${at.page + 1}`
    },
    nativeIdOf: (item) => String(item.jobId),
    mapItem: (item, c) => ({
      namespace: c.namespace,
      nativeId: String(item.jobId),
      url: item.jobUrl,
      title: item.jobTitle,
      companyName: item.employerName,
      location: reedLocation(item.locationName),
      description: item.jobDescription,
      applicationUrl: item.jobUrl,
      dates: [
        { raw: item.date, contract: 'REED_DMY', semantics: 'PUBLISHED' },
        { raw: item.expirationDate, contract: 'REED_DMY', semantics: 'EXPIRY' },
      ],
    }),
    scopeOf: (c) => ({
      namespace: c.namespace,
      query: JSON.stringify({ keywords: c.keywords, locationName: c.locationName }),
      configVersion: c.configVersion,
      window: null,
    }),
  }
}

export interface ReedOptions {
  credential: QuotaCredential
}

export function createReedProvider(
  options: ReedOptions,
): ReportingJobSourceProvider<Validated<Config>> {
  return definePagedProvider({ type: 'REED_API', configSchema }, (config, ctx) => {
    // Before any network call: a source without a key reports itself instead of asking.
    const apiKey = requireApiKey('REED_API', QUOTA_PROVIDER_ENV_KEY.reed, options.credential)
    return collectJsonPages(
      {
        ...makeSpec(apiKey, config),
        limits: { maxPages: config.maxPages, maxItemsPerPage: config.resultsToTake },
      },
      config,
      // The key AND the `key:` form it travels in: base64 of the two differ.
      withSecrets(ctx, [apiKey, `${apiKey}:`]),
    )
  })
}
