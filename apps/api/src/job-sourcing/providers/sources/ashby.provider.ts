import { z } from 'zod'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import { type ApiJsonSourceSpec, defineApiJsonProvider } from '../api-json.provider'
import { ASHBY_KIND, atsBoardConfigSchema, presentStrings } from './ats-config'
import { boundedString, dateRaw, optionalString, urlString } from './as'

/**
 * Ashby public job posting API:
 * `GET https://api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true`
 * (documented, no credentials: https://developers.ashbyhq.com/docs/public-job-posting-api).
 * One board per config, one request per attempt, no pagination.
 *
 * SIZE, MEASURED 2026-10-24 with `includeCompensation=true`: linear 0.46 MB / 34 jobs, notion 2.6
 * MB / 140, ramp 3.0 MB / 167, openai 13.9 MB / 796 (44,922 JSON nodes, parsed in 59 ms, +43 MB
 * RSS). The 2 MiB default would refuse three of those four, so the cap is raised to 10 MiB, the
 * plan's ceiling for a per-source cap, and the openai board - the only one past it - fails as
 * `PAYLOAD_TOO_LARGE` FOR THAT BOARD, which is the honest answer (a bigger cap is a measurement, not
 * an edit). As for Greenhouse, the same caveat holds: this is the body decoder's cap, and the fetch
 * port carries no per-request byte cap yet; the owner is PR #1119 (Task 3.5b), see
 * `GREENHOUSE_LIMITS`.
 *
 * - NAMESPACE `ashby:{board}`; `id` (a UUID) is the native id. Ashby treats the board name as
 *   case-insensitive (`LINEAR` answered 200), hence lowercase-only slugs in `ats-config.ts`.
 * - `jobUrl` is the posting, `applyUrl` the application form: kept distinct.
 * - UNLISTED POSTINGS (`isListed: false`, documented as "only reachable by direct link") are
 *   QUARANTINED, as the plan says: the mapper flags them `notOpenVacancy` and the observation
 *   builder refuses them with the reason `NOT_AN_OPEN_VACANCY`, counted `quarantined`, never
 *   `invalid` (which would read as schema drift). CONSEQUENCE, pinned by a test: the batch is still
 *   `SUCCEEDED`, but any quarantined item makes its coverage `PARTIAL`, so a board that ever lists
 *   one unlisted posting can no longer claim `FULL_INVENTORY` (the base derives coverage from the
 *   counts; an adapter-level exclusion that keeps the full-inventory claim would be a base change
 *   and needs an owning task). Across 10 real non-empty boards (1,612 postings) none was observed -
 *   the public listing appears to omit them - so the guard rests on the documentation, not on a
 *   capture, and its test says so. An ABSENT `isListed` is accepted (it is not in every payload
 *   shape).
 * - COMPENSATION IS NEVER INVENTED. The observation contract has no compensation field, and this
 *   adapter does not smuggle one into the description or the tags: a posting with a populated
 *   `compensation` and one with `compensationTiers: []` map to the same fields. Nothing in the
 *   mapper reads `compensation` at all.
 * - EMPLOYER: the Ashby payload has no employer name, so it comes from the config's verified
 *   `employer` or the posting is quarantined as `MISSING_COMPANY`.
 * - `workplaceType` uses the DOCUMENTED values: `Remote` -> remote, `OnSite` and `Hybrid` -> not
 *   remote, anything else (including the `null` several real boards send) -> unknown. `isRemote` is
 *   not read: the documentation says it is true for Hybrid as well.
 * - DATES: `publishedAt` is documented as "the last publish", so a re-publish moves it; it is read
 *   as `PUBLISHED` because it is the only date offered. DECISION AND COST (owner-visible): the
 *   content hash covers `PUBLISHED` and deliberately not `UPDATED` (boards bump `UPDATED` without
 *   the posting changing), so an Ashby re-publish with identical content produces a NEW
 *   `contentHash`, which the exclusion of `UPDATED` exists to prevent. The alternative, `UPDATED`,
 *   keeps the hash stable but leaves every Ashby vacancy without a publication date. Chosen: keep
 *   the date, accept the churn on re-publish. Reversing it is the `semantics` value below plus the
 *   expectations in `ashby.provider.spec.ts` that name `PUBLISHED`.
 * - LOCATION is `location` plus each `secondaryLocations[].location`, de-duplicated, joined "; ".
 */

export const ASHBY_ADAPTER_VERSION = 'ashby-1'
const HOST = 'api.ashbyhq.com'

export const ASHBY_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxItemsPerPage: 2_000,
  maxPages: 1,
} as const

const configSchema = atsBoardConfigSchema(ASHBY_KIND)
type Config = z.infer<typeof configSchema>

const itemSchema = z.object({
  id: boundedString(200),
  title: boundedString(ORIGINAL_LIMITS.title),
  jobUrl: urlString(),
  applyUrl: urlString().nullish(),
  department: optionalString(200),
  team: optionalString(200),
  employmentType: optionalString(100),
  location: optionalString(ORIGINAL_LIMITS.location),
  secondaryLocations: z
    .array(z.object({ location: optionalString(ORIGINAL_LIMITS.location) }))
    .max(100)
    .nullish(),
  workplaceType: optionalString(50),
  publishedAt: dateRaw(),
  descriptionHtml: optionalString(ORIGINAL_LIMITS.description),
  isListed: z.boolean().nullish(),
})
type Item = z.infer<typeof itemSchema>

/** `jobs` stays OPAQUE so one bad posting is isolated instead of failing the board. */
const envelopeSchema = z.object({ jobs: z.array(z.unknown()) })
type Envelope = z.infer<typeof envelopeSchema>

/** Remote-ness from the documented `workplaceType` values; anything else is unknown. */
export function remoteFromAshbyWorkplace(value: string | null): boolean | null {
  switch (value) {
    case 'Remote':
      return true
    case 'OnSite':
    case 'Hybrid':
      return false
    default:
      return null
  }
}

/** Primary then secondary locations, de-duplicated and joined; none at all is the empty string, which the normalizer reads as no location. */
function locationOf(item: Item): string {
  const secondary = presentStrings(item.secondaryLocations?.map((s) => s.location))
  return [...new Set(presentStrings([item.location, ...secondary]))].join('; ')
}

export const ashbySpec: ApiJsonSourceSpec<Config, Envelope, Item> = {
  type: 'ASHBY_ATS',
  adapterVersion: ASHBY_ADAPTER_VERSION,
  configSchema,
  envelopeSchema,
  itemSchema,
  limits: ASHBY_LIMITS,
  pageRequest: (config) => ({
    request: {
      url: `https://${HOST}/posting-api/job-board/${config.board}?includeCompensation=true`,
      headers: { accept: 'application/json' },
    },
    cacheKey: 'board',
  }),
  extractItems: (envelope) => envelope.jobs,
  nextCursor: () => null,
  nativeIdOf: (item) => item.id,
  mapItem: (item, config) => ({
    namespace: config.namespace,
    nativeId: item.id,
    url: item.jobUrl,
    applicationUrl: item.applyUrl ?? null,
    title: item.title,
    companyName: config.employer?.name ?? null,
    location: locationOf(item),
    description: item.descriptionHtml,
    remote: remoteFromAshbyWorkplace(item.workplaceType),
    employmentType: item.employmentType,
    tags: presentStrings([item.department, item.team]),
    dates: [{ raw: item.publishedAt, contract: 'ISO_ZONED', semantics: 'PUBLISHED' }],
    ...(item.isListed === false ? { notOpenVacancy: true as const } : {}),
  }),
  scopeOf: (config) => ({
    namespace: config.namespace,
    query: null,
    configVersion: config.configVersion,
    window: null,
  }),
}

export const ashbyProvider = defineApiJsonProvider(ashbySpec)
