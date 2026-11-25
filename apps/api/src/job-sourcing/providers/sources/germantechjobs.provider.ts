import { z } from 'zod'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import {
  type ApiJsonSourceSpec,
  baseSourceConfigSchema,
  defineApiJsonProvider,
} from '../api-json.provider'
import { boundedString, dateRaw, optionalString, optionalStringArray } from './as'
import { isNonItTitle } from './non-it-title'

/**
 * GermanTechJobs (`https://germantechjobs.de/api/jobsLight`), ONE request, no pagination.
 *
 * PERMITTED BY AN OWNER DECISION, NOT BY THE SITE. The owner's 2026-11-24 ACCEPT_RISK decision
 * (`GERMANTECHJOBS_OWNER_DECISION`) knowingly accepts the site's terms position as risk, NOT
 * resolved. robots.txt for `*` does not disallow `/api/`. The adapter sends ONE plain GET with the
 * project's identifying User-Agent (set by the transport, never here); a 403, a 429 or a challenge
 * ends the run instead of being worked around.
 *
 * MEASURED 2026-11-24 (`__fixtures__/germantechjobs/jobs-light.json`, provenance beside it):
 *  - ONE unparameterised JSON ARRAY of 1264 records, 1,795,863 bytes: no envelope, page or cursor.
 *    That is above 80% of the default 2 MiB cap, so this feed declares its own 4 MiB cap (see below).
 *  - NOT every record is IT: `techCategory` is a coarse site tag ("Manager", "Data", "Architect"), and
 *    the capture holds a sales role ("Exclusive Mandate: Strategic Sales Director Telco"). The title
 *    is therefore run through the funnel's NON_IT verdict (`non-it-title.ts`) and such records are skipped.
 *  - `_id` is the identity; `jobUrl` is the public slug under `https://germantechjobs.de/jobs/`.
 *  - `deactivatedOn` set means the listing is gone: such records are skipped before mapping.
 *  - `activeFrom` is an OFFSET-bearing instant ("2026-11-14T00:00:00.000+01:00").
 *  - No description field exists in the light feed, so none is mapped.
 *  - COVERAGE is the live listing feed, never an inventory, so `scopeOf` reports a query marker and
 *    a clean run is a WINDOW.
 */
export const GERMANTECHJOBS_SOURCE_STATUS = {
  blocked: false,
  permission: 'UNCLEAR',
  reason:
    'permitted by the owner decision of 2026-11-24 (ACCEPT_RISK on the terms position; germantechjobs.de/api/jobsLight only, no evasion of any block)',
} as const
export const GERMANTECHJOBS_ADAPTER_VERSION = 'germantechjobs-1'
export const GERMANTECHJOBS_ENDPOINT = 'https://germantechjobs.de/api/jobsLight'
const PUBLIC_JOB_BASE = 'https://germantechjobs.de/jobs/'
/** One global feed: the namespace is a constant, because an empty one is refused by identity. */
export const GERMANTECHJOBS_NAMESPACE = 'germantechjobs'
/** The scope marker that makes a clean run WINDOW rather than FULL_INVENTORY. */
export const GERMANTECHJOBS_SCOPE_QUERY = 'jobs-light'
/**
 * The byte cap for this one feed: 4 MiB. The measured body is 1,795,863 bytes; the default 2 MiB
 * leaves 14% headroom and the listing grows. 4 MiB is under the shared 10 MiB ceiling
 * (`MAX_RESPONSE_BYTES_CEILING`), so no allowlist entry is needed: only this provider declares it.
 */
export const GERMANTECHJOBS_MAX_BYTES = 4 * 1024 * 1024
/** Observed 1264 records on 2026-11-24; a feed past 5000 is the provider ignoring the shape we know. */
const MAX_ITEMS = 5000

const configSchema = baseSourceConfigSchema
  .extend({
    namespace: z.literal(GERMANTECHJOBS_NAMESPACE).default(GERMANTECHJOBS_NAMESPACE),
  })
  .strict()
  .refine((c) => c.query === null, { message: 'GermanTechJobs has no search parameter' })
  .refine((c) => c.window === null, { message: 'GermanTechJobs has no date window' })

type Config = z.infer<typeof configSchema>

const itemSchema = z.object({
  /** The stable identity of the listing. */
  _id: boundedString(64).min(1),
  /**
   * The public slug; only URL-safe characters, so the posting URL is built without encoding.
   * Measured live 2026-11-25: of 1,072 records the pattern refuses 0; the longest slug is 189 chars.
   */
  jobUrl: boundedString(200)
    .min(1)
    .regex(/^[A-Za-z0-9-]+$/),
  name: boundedString(ORIGINAL_LIMITS.title),
  company: optionalString(ORIGINAL_LIMITS.companyName),
  actualCity: optionalString(ORIGINAL_LIMITS.location),
  /** `office`, `hybrid` or `remote`; kept as text so an unknown value cannot void the record. */
  workplace: optionalString(20),
  /** Non-null when the listing is gone. Such a record is skipped in `extractItems`. */
  deactivatedOn: optionalString(32),
  activeFrom: dateRaw(),
  filterTags: optionalStringArray(50, 200),
})

type Item = z.infer<typeof itemSchema>

const envelopeSchema = z.array(z.unknown())

type Envelope = z.infer<typeof envelopeSchema>

/**
 * Remoteness from the site's own `workplace` field: `remote` is true, `office` is false, and a
 * hybrid listing is unknown, because it is neither a remote-only role nor an on-site one.
 */
export function remoteOf(workplace: string | null): boolean | null {
  if (workplace === 'remote') return true
  if (workplace === 'office') return false
  return null
}

export const germanTechJobsSpec: ApiJsonSourceSpec<Config, Envelope, Item> = {
  type: 'GERMANTECHJOBS_API',
  adapterVersion: GERMANTECHJOBS_ADAPTER_VERSION,
  configSchema,
  envelopeSchema,
  itemSchema,
  pageRequest: () => ({
    request: { url: GERMANTECHJOBS_ENDPOINT, headers: { accept: 'application/json' } },
    cacheKey: 'feed',
  }),
  extractItems: (envelope) => envelope,
  // Deactivated listings are gone, and a NON_IT title is not a software role: both are skipped before
  // validation (the same rule the funnel applies to a stored row). Non-record elements are skipped too.
  skipItem: (element) =>
    typeof element !== 'object' ||
    element === null ||
    ('deactivatedOn' in element && element.deactivatedOn !== null) ||
    ('name' in element && typeof element.name === 'string' && isNonItTitle(element.name)),
  nextCursor: () => null,
  nativeIdOf: (item) => item._id,
  mapItem: (item, config) => ({
    namespace: config.namespace,
    nativeId: item._id,
    url: `${PUBLIC_JOB_BASE}${item.jobUrl}`,
    title: item.name,
    companyName: item.company,
    location: item.actualCity,
    description: null,
    remote: remoteOf(item.workplace),
    tags: item.filterTags,
    applicationUrl: null,
    dates: [{ raw: item.activeFrom, contract: 'ISO_ZONED', semantics: 'PUBLISHED' }],
  }),
  scopeOf: (config) => ({
    namespace: config.namespace,
    query: GERMANTECHJOBS_SCOPE_QUERY,
    configVersion: config.configVersion,
    window: null,
  }),
  limits: {
    maxBytes: GERMANTECHJOBS_MAX_BYTES,
    maxPages: 1,
    maxItemsPerPage: MAX_ITEMS,
  },
}

export const germanTechJobsProvider = defineApiJsonProvider(germanTechJobsSpec)
