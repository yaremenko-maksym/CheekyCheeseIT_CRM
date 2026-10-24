import { z } from 'zod'
import { ORIGINAL_LIMITS } from '../../normalize/observation'
import {
  type ApiJsonSourceSpec,
  baseSourceConfigSchema,
  defineApiJsonProvider,
} from '../api-json.provider'
import {
  boundedString,
  optionalStringArray,
  dateRaw,
  optionalString,
  positiveSafeInt,
  slugString,
  urlString,
} from './as'

/**
 * Remotive (`https://remotive.com/api/remote-jobs?category=<slug>`), one request per category.
 *
 * PERMISSION IS `UNCLEAR` AND THE RISK IS ACCEPTED BY THE OWNER (decision of 2026-10-24, answer
 * "2a"; see `REMOTIVE_OWNER_DECISION` and `REMOTIVE_SOURCE_STATUS`). The documented API grants
 * developer access, but robots.txt (User-agent *) says `Disallow: /api/*` and
 * `Disallow: /*category=`, and this adapter requests exactly `/api/remote-jobs?category=`. The
 * owner ruled that the documented API takes priority over robots.txt. That is an ACCEPTED RISK,
 * NOT a documented permission: the provenance still says `UNCLEAR`. The vendor's limits stay
 * binding on us (attribution to Remotive, at most about 4 requests a day and never more than 2 a
 * minute). The 24 h job delay is applied by Remotive at the source and is not a request limit. Not registered or enabled by this: registration is plan Task 2.5.
 *
 * WHAT THIS ADAPTER DOES AND DOES NOT ENFORCE OF THOSE LIMITS. One run is ONE request per entry
 * (`nextCursor` is always null), the manifest floors the interval at 6 hours, and a spec derives
 * the requests a day of all Remotive entries from the manifest and holds them to 4. The 2 a minute
 * limit is NOT enforceable here: pacing between separate entries belongs to the scheduler (Task
 * 2.5), and three entries fired in the same minute would be three requests in it.
 *
 * UNVERIFIED: the capture held 9 jobs (105 KB). Whether a full category can exceed the 2 MiB JSON
 * byte cap (`PAYLOAD_TOO_LARGE`) was not measured, and no per-source cap is declared.
 *
 * - NAMESPACE is the constant `remotive`, not the category: a category is a filter, not a board,
 *   so one posting listed under two categories keeps ONE identity.
 * - GEOGRAPHY (`candidate_required_location`) is the observation's `location`; `remote` is set
 *   true separately because Remotive lists only remote jobs. The two are different facts.
 * - COVERAGE is WINDOW, never FULL_INVENTORY: the live `category=software-dev` response was
 *   observed to contain Marketing / Sales / Writing jobs, so the filter does not partition the
 *   inventory, and a clean run cannot claim it saw a category completely.
 * - DATES: `publication_date` carries no zone designator and the docs name none. The date policy
 *   reports MISSING_ZONE (raw kept, no instant) rather than guess one.
 * - Terms (provenance notes): link back and name Remotive as the source; jobs are delayed 24 h;
 *   the provider advises at most ~4 requests a day and blocks more than 2 a minute. A source URL
 *   is kept as the posting URL and no separate application URL exists.
 */

/**
 * Machine-readable twin of the permission note above, pinned against the provenance file by a spec.
 * It guards nothing at runtime: the reconciliation that makes the manifest build fail when this and
 * the provenance disagree is tracked in `.claude/tasks/BACKLOG-followups.md` under the entry titled
 * "Readiness is stated in two places, and nothing reconciles them" (number 314 when written; the
 * title is the address).
 */
export const REMOTIVE_SOURCE_STATUS = {
  blocked: false,
  permission: 'UNCLEAR',
  reason:
    'permission stays UNCLEAR (robots.txt Disallow: /api/* and /*category= contradicts the documented API); the owner ruled on 2026-10-24 that the documented API takes priority, which is an accepted risk, not a documented permission',
} as const

export const REMOTIVE_ADAPTER_VERSION = 'remotive-1'
export const REMOTIVE_NAMESPACE = 'remotive'
const ENDPOINT = 'https://remotive.com/api/remote-jobs'
export const REMOTIVE_CATEGORY_MAX_CHARS = 50

const configSchema = baseSourceConfigSchema
  .extend({
    namespace: z.literal(REMOTIVE_NAMESPACE).default(REMOTIVE_NAMESPACE),
    category: slugString(REMOTIVE_CATEGORY_MAX_CHARS),
  })
  .strict()
  .refine((c) => c.query === null, {
    message: 'Remotive search is not used; the category is the scope',
  })
  .refine((c) => c.window === null, { message: 'Remotive has no date window' })
type Config = z.infer<typeof configSchema>

const itemSchema = z.object({
  id: positiveSafeInt(),
  url: urlString(),
  title: boundedString(ORIGINAL_LIMITS.title),
  company_name: boundedString(ORIGINAL_LIMITS.companyName),
  job_type: optionalString(100),
  candidate_required_location: optionalString(ORIGINAL_LIMITS.location),
  description: optionalString(ORIGINAL_LIMITS.description),
  tags: optionalStringArray(ORIGINAL_LIMITS.tags, ORIGINAL_LIMITS.tag),
  publication_date: dateRaw(),
})
type Item = z.infer<typeof itemSchema>

/** `jobs` stays OPAQUE so one bad job is isolated instead of failing the page. */
const envelopeSchema = z.object({ jobs: z.array(z.unknown()) })
type Envelope = z.infer<typeof envelopeSchema>

export const remotiveSpec: ApiJsonSourceSpec<Config, Envelope, Item> = {
  type: 'REMOTIVE_API',
  adapterVersion: REMOTIVE_ADAPTER_VERSION,
  configSchema,
  envelopeSchema,
  itemSchema,
  pageRequest: (config) => {
    const url = new URL(ENDPOINT)
    url.searchParams.set('category', config.category)
    return {
      request: { url: url.href, headers: { accept: 'application/json' } },
      cacheKey: 'category',
    }
  },
  extractItems: (envelope) => envelope.jobs,
  nextCursor: () => null,
  nativeIdOf: (item) => String(item.id),
  mapItem: (item, config) => ({
    namespace: config.namespace,
    nativeId: String(item.id),
    url: item.url,
    title: item.title,
    companyName: item.company_name,
    location: item.candidate_required_location,
    description: item.description,
    remote: true,
    employmentType: item.job_type,
    tags: item.tags,
    // A null raw date is skipped by the date policy, so no presence check is needed here.
    dates: [{ raw: item.publication_date, contract: 'ISO_ZONED', semantics: 'PUBLISHED' }],
  }),
  scopeOf: (config) => ({
    namespace: config.namespace,
    query: `category:${config.category}`,
    configVersion: config.configVersion,
    window: null,
  }),
  // No `limits`: one request, `nextCursor` is always null, so the default page bound is never reached.
}

export const remotiveProvider = defineApiJsonProvider(remotiveSpec)
