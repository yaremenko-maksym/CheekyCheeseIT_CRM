import { z } from 'zod'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import { type ApiJsonSourceSpec, defineApiJsonProvider } from '../api-json.provider'
import { atsBoardConfigSchema, type AtsRegion, LEVER_KIND, presentStrings } from './ats-config'
import { boundedString, dateRaw, optionalString, urlString } from './as'

/**
 * Lever Postings API: `GET https://api.lever.co/v0/postings/{site}?mode=json&limit=50&skip=N`, and
 * the EU deployment `https://api.eu.lever.co/v0/postings/{site}` (public, unauthenticated for
 * reads; https://github.com/lever/postings-api).
 *
 * THE TWO HOSTS ARE TWO DIFFERENT DATA SETS, not two names for one. Measured 2026-10-24:
 * `siteimprove` is 200 on the EU host and 404 on the global one; `spotify` the reverse. So the
 * region is part of the board (config `region`) and of the namespace (`lever:eu:siteimprove`): the
 * same slug on the other host is a different employer's board, not a duplicate.
 *
 * - PAGING by `limit`/`skip`. A page of fewer than 50 postings ends the board; a page of exactly
 *   50 is followed by one more request, which a board of exactly 50 answers with `[]` (observed).
 *   The cursor is the next `skip`. 50 keeps a page well under the 2 MiB default (Palantir's first
 *   50 are 966 KB; its whole board is 6 MB, which is why it is paged rather than fetched whole).
 *   Offset paging over a board that changes between requests can skip or repeat a posting; a
 *   repeat is the collector's duplicate disposition, a skip is healed by the next full run.
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
export const LEVER_PAGE_SIZE = 50

/** The host belongs to the adapter. The region picks one of exactly these two. */
export const LEVER_HOSTS = {
  global: 'api.lever.co',
  eu: 'api.eu.lever.co',
} as const satisfies Record<AtsRegion, string>

/** `skip` is bounded so a stored cursor cannot be anything but a modest non-negative integer. */
const SKIP_PATTERN = /^\d{1,7}$/

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

function skipOf(cursor: string | null): number {
  if (cursor === null) return 0
  if (!SKIP_PATTERN.test(cursor)) throw new Error('the stored page cursor is not a skip offset')
  return Number(cursor)
}

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
  limits: { maxItemsPerPage: LEVER_PAGE_SIZE, maxPages: 20 },
  pageRequest: (config, at) => ({
    request: {
      url: `https://${LEVER_HOSTS[config.region]}/v0/postings/${config.board}?mode=json&limit=${LEVER_PAGE_SIZE}&skip=${skipOf(at.cursor)}`,
      headers: { accept: 'application/json' },
    },
    cacheKey: `skip-${skipOf(at.cursor)}`,
  }),
  extractItems: (envelope) => envelope,
  nextCursor: (envelope, at) =>
    envelope.length < LEVER_PAGE_SIZE ? null : String(skipOf(at.cursor) + envelope.length),
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
