import { z } from 'zod'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import { type ApiJsonSourceSpec, defineApiJsonProvider } from '../api-json.provider'
import {
  atsBoardConfigSchema,
  nonBlank,
  placeOf,
  presentStrings,
  WORKABLE_KIND,
} from './ats-config'
import { boundedString, dateRaw, optionalString, urlString } from './as'

/**
 * Workable public jobs: `GET https://apply.workable.com/api/v1/widget/accounts/{subdomain}?details=true`.
 * Measurements, captures, robots and terms verdicts: `__fixtures__/workable/*.provenance.json`
 * (2026-10-24).
 *
 * WHICH ADDRESS, AND WHY THIS ADAPTER NEEDS NO REDIRECT. Workable's help center documents the public
 * form `https://www.workable.com/api/accounts/{subdomain}?details=true`. That address answers HTTP
 * 302 to the `apply.workable.com/api/v1/widget/accounts/...` one above (measured: the Location
 * header is in the provenance notes). This adapter calls the FINAL address directly, so it has no
 * use for a redirect. WHAT IS TRUE ABOUT REDIRECTS, AND WHAT IS NOT: the page loop treats any 3xx as
 * an UPSTREAM failure of that request and never reads `Location`; it is the TRANSPORT that decides
 * whether a redirect is followed, and `boundedFetchText` follows up to three, host-pinned to the
 * `allowedHosts` its caller gives it. So this file declares the host (`workableAllowedHosts`), a
 * spec asserts every request stays on it, and whoever builds `fetchText` for this adapter pins the
 * transport to it: then a redirect can only lead to the same host. (The plan says only "widget
 * redirect only via reviewed hop allow-list"; a hop beyond the declared host would be a reviewed
 * addition to the declaration, not a relaxed check.)
 *
 * `https://{subdomain}.workable.com/spi/v3/` is the authenticated partner API (a bearer token) and
 * a separate, authorised integration. No code path here builds a request for it, and nothing here
 * sends an `authorization` header: the request is the URL and `accept: application/json`.
 * `apply.workable.com/api/v1/accounts/{subdomain}` (no `widget`) is the career-page account
 * document and carries no jobs, which is why it is not used.
 *
 * - ONE REQUEST per attempt, no pagination: the response is the whole account. Measured
 *   2026-10-24: 6 jobs = 37 KB, 23 = 93 KB, 158 = 770 KB. Most accounts publish nothing here (27 of
 *   37 probed answered 200 with `"jobs":[]`), and that is a valid empty inventory, not a dead board;
 *   a nonexistent subdomain answers 404 with the text `Not Found`, which the group runner reads as
 *   `BOARD_NOT_FOUND`.
 * - NATIVE IDENTITY is `shortcode` (10 hex characters; `/j/{shortcode}` is the posting page).
 *   `id` is not in this shape, and `code` is the employer's own requisition number (often empty).
 * - NO `__company` INJECTION. The account name sits in the ENVELOPE (`name`), not on a job, and
 *   it is NOT copied onto the jobs. The employer is the config's verified `employer`. What the
 *   envelope's name does is GUARD that evidence: when it no longer matches the verified employer
 *   (an account renamed, or a subdomain handed to someone else) the page is refused as drift and
 *   nothing is stored under the old employer's name. With no verified employer every job is
 *   quarantined (`MISSING_COMPANY`), the same as Lever and Ashby.
 * - LOCATION is each entry of `locations[]` as `city, region, country` (blank parts and adjacent
 *   repeats dropped), entries joined "; ", de-duplicated; the top-level `city/state/country`
 *   stand in when the array is empty. `hidden` is NOT used to drop an entry: it marks locations
 *   Workable does not show on the career page (every remote job in the Hugging Face capture has it
 *   true on a real country), and dropping them would erase the only place information there is.
 * - `telecommuting` is mapped as the boolean it is (true -> remote, false -> not remote). Workable
 *   has no third workplace value in this shape, so a hybrid job is `false`.
 * - `experience` ("Mid-Senior level") is the seniority hint; `department` and `function` are tags.
 * - DATES: `published_on` (`YYYY-MM-DD`, read as UTC midnight) is `PUBLISHED`. `created_at` is
 *   NOT mapped: it is the creation of the requisition and precedes publication by years for a
 *   re-opened job (2022 against 2024 in the Hugging Face capture), and there is no semantic for it.
 * - DETAIL: `details=true` puts `description` (HTML) on every job. A job without it is still
 *   mapped, with no description.
 *
 * !! The 10 MiB cap below is a claim about this file's body decoder only; the transport's own cap
 * is 2 MiB (see the Greenhouse adapter's note and the backlog entry it names).
 */

export const WORKABLE_ADAPTER_VERSION = 'workable-1'
const HOST = 'apply.workable.com'

/** The one host this adapter's requests may reach; a transport is pinned to it. */
export const workableAllowedHosts = (): readonly string[] => [HOST]

export const WORKABLE_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxItemsPerPage: 2_000,
  maxPages: 1,
} as const

const configSchema = atsBoardConfigSchema(WORKABLE_KIND)
type Config = z.infer<typeof configSchema>

const locationSchema = z.object({
  country: optionalString(200),
  city: optionalString(200),
  region: optionalString(200),
})

const itemSchema = z.object({
  shortcode: boundedString(40).min(1),
  title: boundedString(ORIGINAL_LIMITS.title),
  url: urlString(),
  application_url: urlString().nullish(),
  description: optionalString(ORIGINAL_LIMITS.description),
  employment_type: optionalString(100),
  telecommuting: z.boolean().nullish(),
  department: optionalString(200),
  function: optionalString(200),
  experience: optionalString(100),
  published_on: dateRaw(),
  city: optionalString(200),
  state: optionalString(200),
  country: optionalString(200),
  locations: z.array(locationSchema).max(100).nullish(),
})
type Item = z.infer<typeof itemSchema>

/** `jobs` stays OPAQUE so one bad posting is isolated instead of failing the account. */
const envelopeSchema = z.object({
  name: z.string().max(255),
  jobs: z.array(z.unknown()),
})
type Envelope = z.infer<typeof envelopeSchema>

/** Names compared the way a person reads them: case and runs of whitespace do not matter. */
const squash = (name: string) => name.trim().replace(/\s+/g, ' ')
const sameName = (a: string, b: string) =>
  squash(a).localeCompare(squash(b), undefined, { sensitivity: 'accent' }) === 0

function locationOf(item: Item): string | null {
  const places = [
    ...new Set(presentStrings(item.locations?.map((l) => placeOf([l.city, l.region, l.country])))),
  ]
  if (places.length > 0) return places.join('; ')
  return placeOf([item.city, item.state, item.country])
}

export const workableSpec: ApiJsonSourceSpec<Config, Envelope, Item> = {
  type: 'WORKABLE_ATS',
  adapterVersion: WORKABLE_ADAPTER_VERSION,
  configSchema,
  envelopeSchema,
  itemSchema,
  limits: WORKABLE_LIMITS,
  pageRequest: (config) => ({
    request: {
      url: `https://${HOST}/api/v1/widget/accounts/${config.board}?details=true`,
      headers: { accept: 'application/json' },
    },
    cacheKey: 'account',
  }),
  extractItems: (envelope, config) => {
    if (config.employer !== null && !sameName(envelope.name, config.employer.name)) {
      throw new Error(
        `the account is now named "${envelope.name}", not the verified employer "${config.employer.name}"; the board's employer evidence is stale`,
      )
    }
    return envelope.jobs
  },
  nextCursor: () => null,
  nativeIdOf: (item) => item.shortcode,
  mapItem: (item, config) => ({
    namespace: config.namespace,
    nativeId: item.shortcode,
    url: item.url,
    applicationUrl: item.application_url ?? null,
    title: item.title,
    companyName: config.employer?.name ?? null,
    location: locationOf(item),
    description: item.description,
    remote: item.telecommuting ?? null,
    employmentType: nonBlank(item.employment_type),
    seniorityHint: nonBlank(item.experience),
    // A department and a function that say the same word ("Science" twice) are one tag.
    tags: [...new Set(presentStrings([nonBlank(item.department), nonBlank(item.function)]))],
    dates: [{ raw: item.published_on, contract: 'ISO_ZONED', semantics: 'PUBLISHED' }],
  }),
  scopeOf: (config) => ({
    namespace: config.namespace,
    query: null,
    configVersion: config.configVersion,
    window: null,
  }),
}

export const workableProvider = defineApiJsonProvider(workableSpec)
