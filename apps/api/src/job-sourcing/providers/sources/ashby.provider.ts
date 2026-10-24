import { z } from 'zod'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import { type ApiJsonSourceSpec, defineApiJsonProvider } from '../api-json.provider'
import { ASHBY_KIND, atsBoardConfigSchema } from './ats-config'
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
 * port carries no per-request byte cap; see `GREENHOUSE_LIMITS` and the task report.
 *
 * - NAMESPACE `ashby:{board}`; `id` (a UUID) is the native id. Ashby treats the board name as
 *   case-insensitive (`LINEAR` answered 200), hence lowercase-only slugs in `ats-config.ts`.
 * - `jobUrl` is the posting, `applyUrl` the application form: kept distinct.
 * - UNLISTED POSTINGS (`isListed: false`, documented as "only reachable by direct link") are
 *   REFUSED at the item schema with a stated reason, so they are counted `invalid` with a sample
 *   rather than becoming vacancies. Across 10 real non-empty boards (1,612 postings) none was observed - the
 *   public listing appears to omit them - so the guard rests on the documentation, not on a
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
 *   as `PUBLISHED` because it is the only date offered.
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
    .nullish()
    .transform((v) => v ?? []),
  workplaceType: optionalString(50),
  publishedAt: dateRaw(),
  descriptionHtml: optionalString(ORIGINAL_LIMITS.description),
  isListed: z
    .boolean()
    .nullish()
    .refine((v) => v !== false, {
      message:
        'unlisted posting (isListed=false) is reachable by direct link only, not an open vacancy',
    }),
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

function locationOf(item: Item): string | null {
  const all = [item.location, ...item.secondaryLocations.map((s) => s.location)].flatMap((l) =>
    l === null ? [] : [l],
  )
  const distinct = [...new Set(all)]
  return distinct.length > 0 ? distinct.join('; ') : null
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
    descriptionKind: 'html',
    remote: remoteFromAshbyWorkplace(item.workplaceType),
    employmentType: item.employmentType,
    tags: [item.department, item.team].flatMap((t) => (t === null ? [] : [t])),
    dates: [{ raw: item.publishedAt, contract: 'ISO_ZONED', semantics: 'PUBLISHED' }],
  }),
  scopeOf: (config) => ({
    namespace: config.namespace,
    query: null,
    configVersion: config.configVersion,
    window: null,
  }),
}

export const ashbyProvider = defineApiJsonProvider(ashbySpec)
