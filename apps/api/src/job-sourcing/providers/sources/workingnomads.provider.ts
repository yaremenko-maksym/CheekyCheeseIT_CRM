import { z } from 'zod'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import {
  type ApiJsonSourceSpec,
  baseSourceConfigSchema,
  defineApiJsonProvider,
} from '../api-json.provider'
import { boundedString, dateRaw, optionalString, urlString } from './as'

/**
 * Working Nomads (`https://www.workingnomads.com/api/exposed_jobs/`), ONE request, no pagination.
 *
 * PERMITTED BY AN OWNER DECISION, NOT BY THE SITE. The Terms of Service (committed byte for byte as
 * `__fixtures__/workingnomads/terms.html.txt`) say nothing either way on automated access, and
 * robots.txt allows everything, which is silence rather than a grant. The owner's 2026-11-16
 * ACCEPT_RISK decision (`WORKINGNOMADS_OWNER_DECISION`) knowingly accepts terms 2.2, 3.1(b) and
 * 3.1(d) as risk, NOT resolved, with no evasion of any block: this adapter sends ONE plain GET with
 * the project's own identifying User-Agent (set by the transport, never here), and a 403, a 429 or a
 * challenge ends the run instead of being worked around.
 *
 * MEASURED 2026-11-19 against the real endpoint (`__fixtures__/workingnomads/exposed-jobs.json`,
 * provenance beside it):
 *  - ONE unparameterised JSON ARRAY, not an envelope: no page, count or cursor field of any kind,
 *    and the `allow` response header is "GET, HEAD, OPTIONS". There is nothing to paginate and no
 *    server-side filter to send, so `categories` is matched CLIENT-SIDE.
 *  - `category_name` is Title Case ("Development") and the seeded config says "development", so the
 *    match is CASE-INSENSITIVE or it matches nothing.
 *  - `tags` is ONE comma-separated string, never an array.
 *  - `pub_date` is an OFFSET-bearing local instant ("2026-11-09T07:35:52-05:00"), never a bare date.
 *  - `url` is the redirect shape `https://www.workingnomads.com/job/go/<id>/`, and that trailing
 *    numeric segment is the ONLY identity the payload carries: there is no id field.
 *  - COVERAGE is the latest feed (39 records when measured), never an inventory, so `scopeOf`
 *    reports a query marker and a clean run is a WINDOW.
 */

export const WORKINGNOMADS_SOURCE_STATUS = {
  blocked: false,
  permission: 'UNCLEAR',
  reason:
    'permitted by the owner decision of 2026-11-16 (ACCEPT_RISK on terms 2.2, 3.1(b), 3.1(d); www.workingnomads.com/api/exposed_jobs/ only, no evasion of any block)',
} as const

export const WORKINGNOMADS_ADAPTER_VERSION = 'workingnomads-1'
export const WORKINGNOMADS_ENDPOINT = 'https://www.workingnomads.com/api/exposed_jobs/'
/** One global feed: the namespace is a constant, because an empty one is refused by identity. */
export const WORKINGNOMADS_NAMESPACE = 'workingnomads'
/** The scope marker that makes a clean run WINDOW rather than FULL_INVENTORY. */
export const WORKINGNOMADS_SCOPE_QUERY = 'latest-feed'
/** Observed 39 records on 2026-11-19; a feed past 500 is the provider ignoring the shape we know. */
const MAX_ITEMS = 500
/** The identity: the trailing numeric segment of `/job/go/<id>/`. The payload carries no id field. */
const JOB_URL_ID = /\/job\/go\/(\d+)\/?$/

const configSchema = baseSourceConfigSchema
  .extend({
    namespace: z.literal(WORKINGNOMADS_NAMESPACE).default(WORKINGNOMADS_NAMESPACE),
    /**
     * Matched client-side against `category_name`, case-insensitively (the endpoint takes no
     * parameter). The seeded production row carries exactly `{"categories":["development"]}`.
     */
    categories: z.array(boundedString(60).min(1)).min(1).max(20),
  })
  .strict()
  .refine((c) => c.query === null, { message: 'Working Nomads has no search parameter' })
  .refine((c) => c.window === null, { message: 'Working Nomads has no date window' })
type Config = z.infer<typeof configSchema>

const itemSchema = z.object({
  url: urlString(),
  title: boundedString(ORIGINAL_LIMITS.title),
  company_name: optionalString(ORIGINAL_LIMITS.companyName),
  category_name: boundedString(100),
  location: optionalString(ORIGINAL_LIMITS.location),
  description: optionalString(ORIGINAL_LIMITS.description),
  /** ONE comma-separated string on the wire; split in `mapItem`. */
  tags: optionalString(1000),
  pub_date: dateRaw(),
})
type Item = z.infer<typeof itemSchema>

const envelopeSchema = z.array(z.unknown())
type Envelope = z.infer<typeof envelopeSchema>

/** Whether a record's `category_name` is one the config asked for. Case-insensitive, see above. */
export function matchesCategory(categoryName: unknown, categories: readonly string[]): boolean {
  if (typeof categoryName !== 'string') return false
  const want = categoryName.trim().toLowerCase()
  return categories.some((c) => c.trim().toLowerCase() === want)
}

/**
 * Splits the ONE comma-separated `tags` string and bounds it at the ORIGINAL-value limits, which is
 * what the raw record is held to. Exported for the same reason `matchesCategory` is: the stricter
 * display caps in `buildNormalizedPosting` (50 tags of 60 characters) shadow these bounds further
 * down the pipeline, so a run of the provider cannot observe them and only this function can.
 */
export const tagsOf = (raw: string | null): string[] =>
  raw === null
    ? []
    : raw
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && t.length <= ORIGINAL_LIMITS.tag)
        .slice(0, ORIGINAL_LIMITS.tags)

export const workingNomadsSpec: ApiJsonSourceSpec<Config, Envelope, Item> = {
  type: 'WORKINGNOMADS_API',
  adapterVersion: WORKINGNOMADS_ADAPTER_VERSION,
  configSchema,
  envelopeSchema,
  itemSchema,
  pageRequest: () => ({
    request: { url: WORKINGNOMADS_ENDPOINT, headers: { accept: 'application/json' } },
    cacheKey: 'feed',
  }),
  // The client-side filter is the whole reason the config carries `categories`.
  extractItems: (envelope, config) =>
    envelope.filter(
      (element) =>
        typeof element === 'object' &&
        element !== null &&
        'category_name' in element &&
        matchesCategory(element.category_name, config.categories),
    ),
  nextCursor: () => null,
  nativeIdOf: (item) => JOB_URL_ID.exec(item.url)?.[1] ?? null,
  mapItem: (item, config) => ({
    namespace: config.namespace,
    // `null`, never the whole URL: the identity seam then keys the posting by its URL, and
    // `nativeIdOf` has already said the same thing about this record.
    nativeId: JOB_URL_ID.exec(item.url)?.[1] ?? null,
    url: item.url,
    title: item.title,
    companyName: item.company_name,
    location: item.location,
    description: item.description,
    // A remote-only board by the site's own definition. `location` is a free-text display string
    // ("Anywhere in the world", "CET (+/- 3 hours)") and is never read as a remoteness verdict.
    remote: true,
    tags: tagsOf(item.tags),
    applicationUrl: null,
    dates: [{ raw: item.pub_date, contract: 'ISO_ZONED', semantics: 'PUBLISHED' }],
  }),
  scopeOf: (config) => ({
    namespace: config.namespace,
    query: WORKINGNOMADS_SCOPE_QUERY,
    configVersion: config.configVersion,
    window: null,
  }),
  limits: { maxPages: 1, maxItemsPerPage: MAX_ITEMS },
}

export const workingNomadsProvider = defineApiJsonProvider(workingNomadsSpec)
