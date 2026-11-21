import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  buildSourceObservation,
  ORIGINAL_LIMITS,
  type SourceObservation,
} from '../../normalize/observation'
import { definePagedProvider, UNBUILT_REQUEST_URL } from '../api-json.provider'
import { type OwnerDecision, SMARTRECRUITERS_OWNER_DECISION } from '../owner-decisions'
import { DEFAULT_API_JSON_LIMITS } from '../api-json.limits'
import { parseBoundedJson } from '../bounded-json'
import {
  buildCollectionBatch,
  buildInvalidSample,
  buildRequestReport,
  type CollectionBatch,
  type CollectionContext,
  type CollectionCounts,
  decideCheckpoint,
  type InvalidSample,
  type RequestReport,
  type StopReason,
  type ValidatedCheckpoint,
} from '../reporting-provider'
import {
  atsBoardConfigSchema,
  nonBlank,
  placeOf,
  presentStrings,
  SMARTRECRUITERS_KIND,
} from './ats-config'
import { boundedString, dateRaw, optionalString, urlString } from './as'
import { createMeteredFetch, type Failure } from './metered-fetch'

/**
 * SmartRecruiters Posting API: `GET https://api.smartrecruiters.com/v1/companies/{company}/postings?limit=100&offset=N`
 * for the list and `.../postings/{id}` for one posting's detail
 * (https://developers.smartrecruiters.com/docs/endpoints).
 *
 * !! THIS ADAPTER IS A DECISION GATE: it sends a request only when it is armed with an owner
 * decision. The loop runs only when `createSmartRecruitersProvider(bounds, { ownerDecision })` is
 * given THE recorded decision object itself (`SMARTRECRUITERS_OWNER_DECISION` in
 * `owner-decisions.ts`), compared by reference, so a structurally equal forged object does not arm
 * it; without it every attempt is refused without a request (`refuseWithoutDecision`). The exported
 * `smartrecruitersProvider` is armed with that decision. DELIBERATE DEVIATION from "reads its
 * manifest entry": this adapter cannot import the manifest (the manifest imports the adapters, a
 * circular import), so both import the one constant, and a spec ties them: the decision the
 * manifest attaches to the SmartRecruiters type IS the object this adapter is armed with. `api.smartrecruiters.com/robots.txt` says
 * `User-agent: LinkedInBot / Allow: /v1/companies/ / User-agent: * / Disallow: /`: the Posting API is
 * disallowed to every agent but one named crawler, this collector included, while the documentation
 * calls the same API "public". The owner accepted that conflict as a RISK on 2026-10-24 ("until
 * banned"); it is not a permission, and the provenance file still records `permission: UNCLEAR`.
 * NO REQUEST WAS SENT to this host except for `robots.txt` itself, so there is no authentic
 * capture: the spec builds its payloads from the DOCUMENTED schema (the documentation's own examples
 * are not valid JSON) and says so. Nothing is registered or enabled by this (plan Task 2.5).
 *
 * STOP ON BAN, NEVER EVADE. A 401, 403, 451 (`ACCESS_POLICY`) or 429 (`RATE_LIMIT`) on ANY request ends
 * the run at once: no retry, no further request in that run (the page in flight is discarded, not
 * stored half-enriched). The real transport THROWS on these (`SourceBlockedError` for 403,
 * `SourceRateLimitedError` for 429, a plain error for 401/451), so `failureOfThrown` maps them to
 * the same codes; a ban is never reported as a retryable network blip. Nothing here changes the
 * User-Agent, rotates a proxy or retries around a refusal. The adapter's own request sets only an
 * `accept` header; the shared transport adds its fixed identifying User-Agent (it is not ours to
 * change here), and there is no proxy. A ban is a stop, not an obstacle. Cross-run stop (a ban on
 * one board stopping the next run of every board) is the scheduler's, Task 2.5.
 *
 * WHY THIS ADAPTER DOES NOT USE THE PAGE LOOP'S SPEC. The loop asks one request per page, and a
 * posting's description and canonical URL live only in the DETAIL (`jobAd.sections`, `postingUrl`),
 * which is one more request per posting. A spec cannot express "the page's items need further
 * requests, and those cost budget", so this file runs its own loop. It keeps every contract the
 * shared loop has and the batch builder enforces them: reserve before I/O and reconcile on every
 * path, a checkpoint saved together with its observations, a cost stop that is not an error,
 * balanced counts, the derived outcome and coverage (`buildCollectionBatch` is the only producer of
 * a batch).
 *
 * - DETAILS ONLY FOR NEW OR CHANGED POSTINGS, with the response cache as the memory. The ports give
 *   an adapter no list of stored vacancies, so "new or changed" cannot be asked of the store. Each
 *   detail body is cached under `(namespace, id)` with a FINGERPRINT of the list item (its id, name,
 *   release date, location, department, function, type, level, custom fields) in the validator slot;
 *   an id whose list fingerprint equals the cached one is NOT fetched, its cached detail is
 *   re-used. The documentation says content is updated by re-posting, which moves `releasedDate`.
 *   A cache that forgets costs requests, never correctness.
 * - DETAIL PAGES ARE IN THE BUDGET: every request, list or detail, reserves one `REQUEST` before it
 *   is sent, counts against `maxRequests`, and a refusal is a COST_STOP. When the budget runs out
 *   in the middle of a page's details the page is NOT stored half-enriched: it is discarded (its
 *   items are counted `discarded`), the checkpoint stays at the previous page, and the details
 *   that WERE fetched are in the cache, so the next attempt resumes the same page with fewer to
 *   fetch and always makes progress.
 * - THE DETAIL ADDRESS IS BUILT HERE from the validated company and posting id; the `ref` URL in
 *   the data is never followed (it is provider-supplied text, and a request target chosen by the
 *   provider is how a request is steered elsewhere).
 * - A detail that is 404 (closed between list and detail) or unusable (not JSON, wrong id) leaves
 *   that posting list-only: still observed, with no description, with the URL built from the
 *   company and id. ANY OTHER non-2xx on a detail ends the attempt with that code.
 * - CANONICAL URL: the detail's `postingUrl` when there is one (data). Without it the address
 *   `https://jobs.smartrecruiters.com/{company}/{id}` is built from the CONFIGURED company; that
 *   form is the documented career-site shape but was NOT verified against a live response.
 * - EMPLOYER: the payload's `company.name`, else the config's verified employer, else none.
 * - `location.remote` true -> remote; `hybrid` true -> not remote; `remote` false -> not remote.
 *   `visibility` other than `PUBLIC`, or `active: false`, is not an open vacancy.
 */

export const SMARTRECRUITERS_ADAPTER_VERSION = 'smartrecruiters-1'
const HOST = 'api.smartrecruiters.com'

export interface SmartRecruitersBounds {
  /** List pages per attempt. */
  readonly maxListPages: number
  /** Requests per attempt, list AND detail. */
  readonly maxRequests: number
  /** Postings asked per list page (and the most one page may carry). */
  readonly pageSize: number
}

/**
 * Derived from the per-host request budget, not chosen (task sources-04). The owner raised this
 * host's budget from 2 to 10 requests a minute on 2026-11-21 (task sources-15), overriding decision
 * 11's two-week wait for SmartRecruiters only. `assertPolicy` refuses a `requestsPerRun` above that
 * per-minute figure, and the collection context refuses the run's eleventh request
 * (`REQUEST_CEILING`). A posting costs ONE detail request on top of the ONE list request of the
 * run, so a run carries at most nine postings:
 *  - `pageSize: 9` — a page of ten would run out of detail budget mid-page, and a bound that
 *    throws a page away reports ERROR, never a clean PAGE_CAP (see `aborted` below);
 *  - `maxRequests: 10` — the same figure the manifest declares as `requestsPerRun`;
 *  - `maxListPages: 1` — the clean stop: the loop head breaks on PAGE_CAP before asking for a
 *    request the run cannot spend.
 * The cursor checkpoint carries the item offset, so consecutive runs walk a board nine postings at
 * a time. Raising the host budget (and these figures with it) is the owner's call.
 */
export const SMARTRECRUITERS_BOUNDS: SmartRecruitersBounds = {
  maxListPages: 1,
  maxRequests: 10,
  pageSize: 9,
}

const configSchema = atsBoardConfigSchema(SMARTRECRUITERS_KIND)
type Config = z.infer<typeof configSchema>

/** The id goes into a URL path: this is the whole alphabet it may have. */
const POSTING_ID = /^[A-Za-z0-9_-]{1,64}$/
const OFFSET = /^\d{1,9}$/

const labelled = z
  .object({ label: optionalString(200) })
  .nullish()
  .transform((v) => v?.label ?? null)

const listItemSchema = z.object({
  id: z.string().regex(POSTING_ID),
  name: boundedString(ORIGINAL_LIMITS.title),
  refNumber: optionalString(200),
  releasedDate: dateRaw(),
  visibility: optionalString(50),
  company: z
    .object({ identifier: optionalString(200), name: optionalString(ORIGINAL_LIMITS.companyName) })
    .nullish(),
  location: z
    .object({
      city: optionalString(200),
      region: optionalString(200),
      country: optionalString(200),
      remote: z.boolean().nullish(),
      hybrid: z.boolean().nullish(),
    })
    .nullish(),
  industry: labelled,
  department: labelled,
  function: labelled,
  typeOfEmployment: labelled,
  experienceLevel: labelled,
  customField: z.array(z.unknown()).max(100).nullish(),
})
type ListItem = z.infer<typeof listItemSchema>

const section = z
  .object({ title: optionalString(500), text: optionalString(ORIGINAL_LIMITS.description) })
  .nullish()

const detailSchema = z.object({
  id: z.string().regex(POSTING_ID),
  postingUrl: urlString().nullish(),
  applyUrl: urlString().nullish(),
  active: z.boolean().nullish(),
  visibility: optionalString(50),
  jobAd: z
    .object({
      sections: z
        .object({
          companyDescription: section,
          jobDescription: section,
          qualifications: section,
          additionalInformation: section,
        })
        .nullish(),
    })
    .nullish(),
})
type Detail = z.infer<typeof detailSchema>

const listEnvelopeSchema = z.object({
  totalFound: z.number().int().min(0).nullish(),
  content: z.array(z.unknown()),
})

const SECTION_ORDER = [
  'companyDescription',
  'jobDescription',
  'qualifications',
  'additionalInformation',
] as const

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The sections that have text, each under its title; none at all is the empty string, which the normalizer reads as no description. */
function bodyHtml(detail: Detail | null): string {
  return SECTION_ORDER.flatMap((name) => {
    const section = detail?.jobAd?.sections?.[name]
    if (section === undefined || section === null) return []
    if (section.text === null || section.text.trim() === '') return []
    const title = nonBlank(section.title)
    return [`${title === null ? '' : `<h3>${escapeHtml(title)}</h3>`}${section.text}`]
  }).join('')
}

/**
 * What identifies a posting's CONTENT in the list: if any of it differs from the cached detail's
 * fingerprint, the detail is fetched again. A digest, so the cache slot stays small.
 */
function fingerprintOf(item: ListItem): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        item.id,
        item.name,
        item.refNumber,
        item.releasedDate,
        item.visibility,
        item.location,
        item.industry,
        item.department,
        item.function,
        item.typeOfEmployment,
        item.experienceLevel,
        item.customField ?? null,
      ]),
    )
    .digest('hex')
}

const detailCacheKey = (namespace: string, id: string) =>
  JSON.stringify(['smartrecruiters-detail', namespace, id])

function remoteOf(item: ListItem): boolean | null {
  const remote = item.location?.remote
  if (remote === true) return true
  if (item.location?.hybrid === true || remote === false) return false
  return null
}

/** A visibility the posting states and that is not PUBLIC; none stated says nothing. */
const isNotPublic = (visibility: string | null | undefined) =>
  visibility !== null && visibility !== undefined && visibility !== 'PUBLIC'

export function mapPosting(item: ListItem, detail: Detail | null, config: Config) {
  const closed =
    detail?.active === false || isNotPublic(item.visibility) || isNotPublic(detail?.visibility)
  return {
    namespace: config.namespace,
    nativeId: item.id,
    url: detail?.postingUrl ?? `https://jobs.smartrecruiters.com/${config.board}/${item.id}`,
    applicationUrl: detail?.applyUrl ?? null,
    title: item.name,
    companyName: nonBlank(item.company?.name) ?? config.employer?.name ?? null,
    location: placeOf([item.location?.city, item.location?.region, item.location?.country]),
    description: bodyHtml(detail),
    remote: remoteOf(item),
    employmentType: nonBlank(item.typeOfEmployment),
    seniorityHint: nonBlank(item.experienceLevel),
    tags: [
      ...new Set(
        presentStrings([
          nonBlank(item.department),
          nonBlank(item.function),
          nonBlank(item.industry),
        ]),
      ),
    ],
    dates: [
      { raw: item.releasedDate, contract: 'ISO_ZONED' as const, semantics: 'PUBLISHED' as const },
    ],
    ...(closed ? { notOpenVacancy: true as const } : {}),
  }
}

// ---------------------------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------------------------

const emptyCounts = (): CollectionCounts => ({
  raw: 0,
  normalized: 0,
  invalid: 0,
  quarantined: 0,
  discarded: 0,
})

const scopeOf = (config: Config) => ({
  namespace: config.namespace,
  query: null,
  configVersion: config.configVersion,
  window: null,
})

async function collectSmartRecruiters(
  bounds: SmartRecruitersBounds,
  config: Config,
  ctx: CollectionContext,
) {
  const scope = scopeOf(config)
  const decision = decideCheckpoint(await ctx.checkpoints.load(), {
    configVersion: config.configVersion,
    policyVersion: ctx.policyVersion,
    adapterVersion: SMARTRECRUITERS_ADAPTER_VERSION,
  })
  const resumed = decision.kind === 'RESUME'
  let page = decision.kind === 'RESUME' ? decision.from.position.page + 1 : 1
  let offsetText: string = decision.kind === 'RESUME' ? decision.from.position.cursor : '0'
  const startPage = page

  const observations: SourceObservation[] = []
  const requests: RequestReport[] = []
  const samples: InvalidSample[] = []
  const counts = emptyCounts()
  let checkpoint: ValidatedCheckpoint | null = null
  let pagesCompleted = 0
  // Every path out of the loop assigns it; `finish` reads it after.
  let stop!: StopReason

  // Unbounded here on purpose: a page is at most `pageSize` postings and the attempt at most
  // `maxListPages` pages, and `buildCollectionBatch` keeps the first `MAX_SAMPLES` of them.
  const addSample = (at: number, reason: string, raw: unknown) => {
    samples.push(buildInvalidSample(at, reason, raw, ctx.secrets))
  }
  const report = (
    at: number,
    url: string,
    status: number | null,
    startedAt: Date,
    cost: RequestReport['cost'],
    error: Failure | null,
  ) =>
    requests.push(
      buildRequestReport(
        {
          attempt: 1,
          page: at,
          url,
          status,
          startedAt,
          endedAt: ctx.now(),
          cost,
          error: error === null ? null : { code: error.code, message: error.message },
        },
        ctx.secrets,
      ),
    )

  const metered = createMeteredFetch(ctx, bounds.maxRequests, report)

  const jsonOf = (bodyText: string) => parseBoundedJson(bodyText, DEFAULT_API_JSON_LIMITS)

  /** A cached or fetched detail body, judged: the posting's own detail, or nothing. */
  const detailOf = (bodyText: string, id: string): Detail | null => {
    const parsed = jsonOf(bodyText)
    // `false` for a body that is not JSON: `safeParse(false)` rejects it, so no branch is needed.
    const detail = detailSchema.safeParse(parsed.ok && parsed.value)
    return detail.success && detail.data.id === id ? detail.data : null
  }

  if (!OFFSET.test(offsetText)) {
    report(page, UNBUILT_REQUEST_URL, null, ctx.now(), null, {
      code: 'PARSE_DRIFT',
      message: 'the stored page cursor is not an offset',
      status: null,
    })
    stop = 'ERROR'
    return finish()
  }

  while (true) {
    if (page - startPage >= bounds.maxListPages) {
      report(page, UNBUILT_REQUEST_URL, null, ctx.now(), null, {
        code: 'PAGE_CAP',
        message: `the attempt reached its ${bounds.maxListPages}-page bound`,
        status: null,
      })
      stop = 'PAGE_CAP'
      break
    }
    const offset = Number(offsetText)
    const listUrl = `https://${HOST}/v1/companies/${config.board}/postings?limit=${bounds.pageSize}&offset=${offset}`
    const listed = await metered(
      page,
      { url: listUrl, headers: { accept: 'application/json' } },
      false,
    )
    if (!listed.ok) {
      stop = listed.stop
      break
    }
    const envelope = ((): { items: unknown[]; total: number | null } | Failure => {
      const parsed = jsonOf(listed.bodyText)
      if (!parsed.ok) {
        return {
          code: parsed.reason === 'NOT_JSON' ? 'PARSE_DRIFT' : 'PAYLOAD_TOO_LARGE',
          message: `${parsed.reason}: ${parsed.detail}`,
          status: listed.status,
        }
      }
      const shaped = listEnvelopeSchema.safeParse(parsed.value)
      if (!shaped.success) {
        return { code: 'PARSE_DRIFT', message: 'envelope: did not match', status: listed.status }
      }
      if (shaped.data.content.length > bounds.pageSize) {
        return {
          code: 'PAYLOAD_TOO_LARGE',
          message: `page carried ${shaped.data.content.length} items, over the ${bounds.pageSize} cap`,
          status: listed.status,
        }
      }
      return { items: shaped.data.content, total: shaped.data.totalFound ?? null }
    })()
    if ('code' in envelope) {
      report(page, listUrl, envelope.status, listed.startedAt, listed.cost, envelope)
      stop = 'ERROR'
      break
    }
    report(page, listUrl, listed.status, listed.startedAt, listed.cost, null)

    // ---- the page's postings, validated
    const pageCounts = emptyCounts()
    const valid: ListItem[] = []
    for (const raw of envelope.items) {
      pageCounts.raw += 1
      const parsed = listItemSchema.safeParse(raw)
      if (!parsed.success) {
        pageCounts.invalid += 1
        addSample(page, 'ITEM_SCHEMA', raw)
      } else {
        valid.push(parsed.data)
      }
    }

    // ---- details, only for new or changed postings, each one metered
    const details = new Map<string, Detail>()
    let aborted: StopReason | null = null
    for (const item of valid) {
      const fingerprint = fingerprintOf(item)
      const key = detailCacheKey(config.namespace, item.id)
      const cached = await ctx.cache.get(key).catch(() => null)
      if (cached !== null && cached.etag === fingerprint) {
        const reused = detailOf(cached.bodyText, item.id)
        if (reused !== null) {
          details.set(item.id, reused)
          continue
        }
      }
      const detailUrl = `https://${HOST}/v1/companies/${config.board}/postings/${item.id}`
      const fetched = await metered(
        page,
        { url: detailUrl, headers: { accept: 'application/json' } },
        true,
      )
      if (!fetched.ok) {
        aborted = fetched.stop
        break
      }
      if (fetched.status === 404) {
        report(page, detailUrl, 404, fetched.startedAt, fetched.cost, null)
        continue
      }
      report(page, detailUrl, fetched.status, fetched.startedAt, fetched.cost, null)
      const detail = detailOf(fetched.bodyText, item.id)
      if (detail === null) {
        addSample(page, 'DETAIL_UNUSABLE: not the posting detail asked for', item.id)
        continue
      }
      details.set(item.id, detail)
      await ctx.cache.put(key, { etag: fingerprint, bodyText: fetched.bodyText }).catch(() => {})
    }

    // ---- observe the page (with whatever details it got), then keep it or throw it away whole
    const pageObservations: SourceObservation[] = []
    for (const item of valid) {
      const result = buildSourceObservation(
        {
          ...mapPosting(item, details.get(item.id) ?? null, config),
          provider: 'SMARTRECRUITERS_ATS',
          adapterVersion: SMARTRECRUITERS_ADAPTER_VERSION,
        },
        { now: ctx.now() },
      )
      if (!result.ok) {
        pageCounts.quarantined += 1
        addSample(page, `QUARANTINED: ${result.reason}`, item.id)
      } else {
        pageCounts.normalized += 1
        pageObservations.push(result.observation)
      }
    }
    const keep = (): void => {
      counts.raw += pageCounts.raw
      counts.invalid += pageCounts.invalid
      counts.quarantined += pageCounts.quarantined
      counts.normalized += pageCounts.normalized
    }
    const discard = (): void => {
      counts.raw += pageCounts.raw
      counts.invalid += pageCounts.invalid
      counts.quarantined += pageCounts.quarantined
      counts.discarded += pageCounts.normalized
    }
    if (aborted !== null) {
      discard()
      // A bound that threw a page away is not a clean bound: `PAGE_CAP` derives SUCCEEDED, and a
      // SUCCEEDED attempt cannot have discarded anything. The request report still says PAGE_CAP.
      stop = aborted === 'PAGE_CAP' ? 'ERROR' : aborted
      break
    }

    const nextOffset = offset + envelope.items.length
    // `totalFound` says whether there is more; without it a FULL page is the only sign.
    const more =
      envelope.items.length > 0 &&
      (envelope.total === null
        ? envelope.items.length === bounds.pageSize
        : envelope.total > nextOffset)
    const next: ValidatedCheckpoint = {
      configVersion: config.configVersion,
      policyVersion: ctx.policyVersion,
      adapterVersion: SMARTRECRUITERS_ADAPTER_VERSION,
      position: more
        ? { kind: 'CURSOR', page, cursor: String(nextOffset) }
        : { kind: 'RESTART', page },
      completedAt: ctx.now(),
    }
    try {
      await ctx.checkpoints.savePage({ observations: pageObservations, checkpoint: next })
    } catch (error) {
      discard()
      report(page, listUrl, listed.status, ctx.now(), null, {
        code: 'PERSISTENCE',
        message: error instanceof Error ? error.message : 'the page could not be persisted',
        status: listed.status,
      })
      stop = 'ERROR'
      break
    }
    keep()
    observations.push(...pageObservations)
    checkpoint = next
    pagesCompleted += 1
    if (!more) {
      stop = 'EXHAUSTED'
      break
    }
    page += 1
    offsetText = String(nextOffset)
  }
  return finish()

  function finish() {
    return buildCollectionBatch({
      observations,
      facts: { stop, pagesCompleted, counts, scope, resumed },
      requests,
      checkpoint,
      invalidSamples: samples,
    })
  }
}

/**
 * The attempt that is not made without an owner decision: the Posting API's robots.txt disallows
 * this collector, so no request is sent and the batch says why. Same shape as Recruitee's
 * `refuseWithoutToken`: ONE report, `ACCESS_POLICY`, at the unbuilt-request address, `ERROR` with no
 * page, so the batch is FAILED and claims no coverage. (The message avoids the word that the report
 * redactor rewrites.)
 */
function refuseWithoutDecision(config: Config, ctx: CollectionContext): CollectionBatch {
  const at = ctx.now()
  return buildCollectionBatch({
    observations: [],
    facts: {
      stop: 'ERROR',
      pagesCompleted: 0,
      counts: emptyCounts(),
      scope: scopeOf(config),
      // Stryker disable next-line BooleanLiteral: this batch is FAILED, and a non-SUCCEEDED attempt has PARTIAL coverage whatever `resumed` says (`deriveCoverage`), so the flag cannot be seen in the result.
      resumed: false,
    },
    requests: [
      buildRequestReport(
        {
          attempt: 1,
          page: 1,
          url: UNBUILT_REQUEST_URL,
          status: null,
          startedAt: at,
          endedAt: at,
          cost: null,
          error: {
            code: 'ACCESS_POLICY',
            message: `robots.txt of ${HOST} disallows this collector and no owner decision covers it, so no request was made`,
          },
        },
        ctx.secrets,
      ),
    ],
    checkpoint: null,
    invalidSamples: [],
  })
}

/** The manifest `endpointVariant` this adapter sends requests to; a decision must be about it. */
export const SMARTRECRUITERS_ENDPOINT_VARIANT = 'posting-api'

export interface SmartRecruitersOptions {
  /**
   * Arms the real loop. It must be THE recorded `SMARTRECRUITERS_OWNER_DECISION` object (compared by
   * reference); anything else, however structurally alike, leaves the adapter refusing every
   * attempt. The decision is the owner's, recorded once in `owner-decisions.ts`.
   */
  readonly ownerDecision?: OwnerDecision
}

const isArmedBy = (decision: OwnerDecision | undefined): boolean =>
  decision === SMARTRECRUITERS_OWNER_DECISION

export function createSmartRecruitersProvider(
  bounds: SmartRecruitersBounds = SMARTRECRUITERS_BOUNDS,
  options: SmartRecruitersOptions = {},
) {
  return definePagedProvider({ type: 'SMARTRECRUITERS_ATS', configSchema }, (config, ctx) =>
    isArmedBy(options.ownerDecision)
      ? collectSmartRecruiters(bounds, config, ctx)
      : Promise.resolve(refuseWithoutDecision(config, ctx)),
  )
}

/** Armed with the owner's recorded decision. Without it the factory refuses; see `refuseWithoutDecision`. */
export const smartrecruitersProvider = createSmartRecruitersProvider(SMARTRECRUITERS_BOUNDS, {
  ownerDecision: SMARTRECRUITERS_OWNER_DECISION,
})

/** The one host this adapter's requests may reach; a transport is pinned to it. */
export const smartrecruitersAllowedHosts = (): readonly string[] => [HOST]
