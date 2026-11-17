import { z } from 'zod'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import { type ApiJsonSourceSpec, defineApiJsonProvider } from '../api-json.provider'
import { atsBoardConfigSchema, type AtsRegion, LEVER_KIND, presentStrings } from './ats-config'
import { boundedString, dateRaw, optionalString, urlString } from './as'

/**
 * Lever Postings API: `GET https://api.lever.co/v0/postings/{site}?mode=json`, and
 * the EU deployment `https://api.eu.lever.co/v0/postings/{site}` (public, unauthenticated for
 * reads; https://github.com/lever/postings-api).
 *
 * THE TWO HOSTS ARE TWO DIFFERENT DATA SETS, not two names for one. Measured 2026-10-24:
 * `siteimprove` is 200 on the EU host and 404 on the global one; `spotify` the reverse. So the
 * region is part of the board (config `region`) and of the namespace (`lever:eu:siteimprove`): the
 * same slug on the other host is a different employer's board, not a duplicate.
 *
 * - ONE REQUEST PER RUN, the whole board. The README documents `limit` as "only return at most N
 *   results" and `skip` as "skip N from the start", so with neither the API is read as answering
 *   every published posting (the README states no default; no unpaged capture is committed, so this
 *   rests on that reading). A board run is allowed exactly
 *   one request (`requestsPerRun: 1` in the manifest, SR-H-1b), so paging by `limit=50&skip=N`
 *   failed every board of 50 or more with REQUEST_CEILING (prod, `lever.board.spotify`,
 *   2026-11-16). As for Ashby and Greenhouse the response cap is raised to the 10 MiB ceiling; a
 *   board past it fails as `PAYLOAD_TOO_LARGE` for that board, which is the honest answer. One
 *   request a run is also the ban-safest shape.
 * - NATIVE IDENTITY is `id` (a UUID). `hostedUrl` (the public posting page) and `applyUrl` (the
 *   application form) are kept DISTINCT: the first is the posting, the second `applicationUrl`.
 * - EMPLOYER: the Lever payload carries NO employer name at all. It comes from the config's
 *   verified `employer`, or is absent and the posting is quarantined as `MISSING_COMPANY`. For
 *   boards verified here the evidence is the posting text introducing the employer by name, which
 *   is weaker than a name field and is written as such in the config's `evidence`.
 * - LOCATION is `categories.allLocations` joined with "; " when there is more than one, else the
 *   single `categories.location`.
 * - `workplaceType`: `remote` -> remote, `on-site` and `hybrid` -> not remote, `unspecified` ->
 *   unknown. DRIFT, observed: the live API also sends `onsite` (no hyphen), which the documentation
 *   does not list. The owner decided on 2026-10-24 (answer "4a") to map it exactly like `on-site`
 *   (not remote). That alias rests on ONE observation plus that decision, not on documentation.
 *   Any other value stays unknown rather than a guess.
 * - DATES: `createdAt` (epoch milliseconds) is the only date. It is observed, NOT in the
 *   documented field list, and it is a creation time, which can precede publication; it is read as
 *   `PUBLISHED` for want of a better-named semantic and a reviewer should know it is a proxy.
 * - Not mapped: `salaryRange` / `salaryDescription` (the observation contract has no salary field).
 */

export const LEVER_ADAPTER_VERSION = 'lever-1'
export const LEVER_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxItemsPerPage: 2_000,
  maxPages: 1,
} as const

/** The host belongs to the adapter. The region picks one of exactly these two. */
export const LEVER_HOSTS = {
  global: 'api.lever.co',
  eu: 'api.eu.lever.co',
} as const satisfies Record<AtsRegion, string>

const configSchema = atsBoardConfigSchema(LEVER_KIND)
type Config = z.infer<typeof configSchema>

const itemSchema = z.object({
  id: boundedString(200),
  text: boundedString(ORIGINAL_LIMITS.title),
  hostedUrl: urlString(),
  applyUrl: urlString().nullish(),
  createdAt: dateRaw(),
  workplaceType: optionalString(50),
  categories: z
    .object({
      location: optionalString(ORIGINAL_LIMITS.location),
      commitment: optionalString(200),
      department: optionalString(200),
      team: optionalString(200),
      allLocations: z
        .array(z.string().max(ORIGINAL_LIMITS.location))
        .max(100)
        .nullish()
        .transform((v) => v ?? []),
    })
    .nullish(),
  description: optionalString(ORIGINAL_LIMITS.description),
  lists: z
    .array(z.object({ text: optionalString(500), content: optionalString(50_000) }))
    .max(50)
    .nullish()
    .transform((v) => v ?? []),
  additional: optionalString(ORIGINAL_LIMITS.description),
})
type Item = z.infer<typeof itemSchema>

/** The whole page IS the array; its items stay OPAQUE so one bad posting is isolated. */
const envelopeSchema = z.array(z.unknown())
type Envelope = z.infer<typeof envelopeSchema>

/** Remote-ness from the documented `workplaceType` values plus the owner-aliased `onsite`; anything else is unknown. */
export function remoteFromWorkplaceType(value: string | null): boolean | null {
  switch (value) {
    case 'remote':
      return true
    case 'on-site':
    case 'onsite':
    case 'hybrid':
      return false
    default:
      return null
  }
}

/** The posting body as one HTML string: the intro, each list under its heading, the closing text. */
function bodyHtml(item: Item): string {
  const lists = item.lists.map((l) => `<h3>${l.text ?? ''}</h3><ul>${l.content ?? ''}</ul>`)
  return [item.description ?? '', ...lists, item.additional ?? ''].join('')
}

function locationOf(item: Item): string | null {
  const all = item.categories?.allLocations ?? []
  return all.length > 0 ? all.join('; ') : (item.categories?.location ?? null)
}

export const leverSpec: ApiJsonSourceSpec<Config, Envelope, Item> = {
  type: 'LEVER_ATS',
  adapterVersion: LEVER_ADAPTER_VERSION,
  configSchema,
  envelopeSchema,
  itemSchema,
  limits: LEVER_LIMITS,
  pageRequest: (config) => ({
    request: {
      url: `https://${LEVER_HOSTS[config.region]}/v0/postings/${config.board}?mode=json`,
      headers: { accept: 'application/json' },
    },
    cacheKey: 'board',
  }),
  extractItems: (envelope) => envelope,
  nextCursor: () => null,
  nativeIdOf: (item) => item.id,
  mapItem: (item, config) => ({
    namespace: config.namespace,
    nativeId: item.id,
    url: item.hostedUrl,
    applicationUrl: item.applyUrl ?? null,
    title: item.text,
    companyName: config.employer?.name ?? null,
    location: locationOf(item),
    description: bodyHtml(item),
    remote: remoteFromWorkplaceType(item.workplaceType),
    employmentType: item.categories?.commitment ?? null,
    tags: presentStrings([item.categories?.department, item.categories?.team]),
    dates: [{ raw: item.createdAt, contract: 'UNIX_MILLISECONDS', semantics: 'PUBLISHED' }],
  }),
  scopeOf: (config) => ({
    namespace: config.namespace,
    query: null,
    configVersion: config.configVersion,
    window: null,
  }),
}

export const leverProvider = defineApiJsonProvider(leverSpec)
