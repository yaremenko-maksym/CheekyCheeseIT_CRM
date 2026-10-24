import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  buildSourceObservation,
  ORIGINAL_LIMITS,
  type SourceObservation,
} from '../../normalize/observation'
import { definePagedProvider, UNBUILT_REQUEST_URL } from '../api-json.provider'
import { DEFAULT_API_JSON_LIMITS } from '../api-json.limits'
import { parseBoundedJson } from '../bounded-json'
import {
  buildCollectionBatch,
  buildInvalidSample,
  buildRequestReport,
  type CollectionContext,
  type CollectionCounts,
  type CollectionErrorCode,
  decideCheckpoint,
  type FetchRequest,
  type InvalidSample,
  type MeterReservation,
  type RequestReport,
  type ReservationResolution,
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

/**
 * SmartRecruiters Posting API: `GET https://api.smartrecruiters.com/v1/companies/{company}/postings?limit=100&offset=N`
 * for the list and `.../postings/{id}` for one posting's detail
 * (https://developers.smartrecruiters.com/docs/endpoints).
 *
 * !! THIS SOURCE IS BLOCKED, AND THE ADAPTER IS DORMANT. `api.smartrecruiters.com/robots.txt` says
 * `User-agent: LinkedInBot / Allow: /v1/companies/ / User-agent: * / Disallow: /`: the Posting API is
 * disallowed to every agent but one named crawler, this collector included, while the documentation
 * calls the same API "public". The two conflict, the brief says to stop at a disallowed path, and
 * so NO REQUEST WAS SENT to this host except for `robots.txt` itself. There is no authentic
 * capture: the spec builds its payloads from the DOCUMENTED schema (the documentation's own examples
 * are not valid JSON) and says so. The provenance file records `permission: UNCLEAR`. It must not be
 * enabled until the owner decides.
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

export const SMARTRECRUITERS_BOUNDS: SmartRecruitersBounds = {
  maxListPages: 20,
  maxRequests: 400,
  pageSize: 100,
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

interface Failure {
  code: CollectionErrorCode
  message: string
  status: number | null
}

type Fetched =
  | { ok: true; status: number; bodyText: string; startedAt: Date; cost: RequestReport['cost'] }
  | { ok: false; stop: StopReason }

/** HTTP status -> our code, from the STATUS and never the body. */
function classify(status: number): CollectionErrorCode | null {
  if (status >= 200 && status < 300) return null
  if (status === 401 || status === 403) return 'ACCESS_POLICY'
  if (status === 429) return 'RATE_LIMIT'
  return 'UPSTREAM'
}

const emptyCounts = (): CollectionCounts => ({
  raw: 0,
  normalized: 0,
  invalid: 0,
  quarantined: 0,
  discarded: 0,
})

async function collectSmartRecruiters(
  bounds: SmartRecruitersBounds,
  config: Config,
  ctx: CollectionContext,
) {
  const scope = {
    namespace: config.namespace,
    query: null,
    configVersion: config.configVersion,
    window: null,
  }
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
  let requestsMade = 0
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

  /**
   * ONE metered request. Reserve before any I/O, reconcile on every path out (the `finally`), cap
   * and cancel and deadline checked first. On any refusal or failure the report is already pushed
   * and `{ ok: false, stop }` is returned; on a response the CALLER pushes the report, because
   * only it knows whether the body was usable. `notFoundIsAnAnswer` lets a detail's 404 through.
   */
  async function metered(
    at: number,
    request: FetchRequest,
    notFoundIsAnAnswer: boolean,
  ): Promise<Fetched> {
    const startedAt = ctx.now()
    const refuse = (failure: Failure, why: StopReason, cost: RequestReport['cost'] = null) => {
      report(at, request.url, failure.status, startedAt, cost, failure)
      return { ok: false, stop: why } as const
    }
    if (requestsMade >= bounds.maxRequests) {
      return refuse(
        {
          code: 'PAGE_CAP',
          message: `the attempt reached its ${bounds.maxRequests}-request bound`,
          status: null,
        },
        'PAGE_CAP',
      )
    }
    if (ctx.signal.aborted) {
      return refuse(
        { code: 'CANCELLED', message: 'the run was cancelled before this request', status: null },
        'CANCELLED',
      )
    }
    if (ctx.now().getTime() >= ctx.deadline.getTime()) {
      return refuse(
        {
          code: 'DEADLINE',
          message: 'the attempt deadline passed before this request',
          status: null,
        },
        'ERROR',
      )
    }
    const reservation: MeterReservation | null = await ctx.meter.reserve('REQUEST', 1)
    if (reservation === null) {
      return refuse(
        { code: 'COST_STOP', message: 'the meter refused a reservation', status: null },
        'COST_STOP',
      )
    }
    const cost = { unit: reservation.unit, amount: reservation.amount }
    requestsMade += 1
    // From here the request may have left the process, so a failure cannot claim it was unused.
    let resolution: ReservationResolution = 'UNCERTAIN'
    let answer: { response: { status: number; bodyText: string } } | { failure: Failure }
    try {
      const fetched = await ctx.fetchText(request)
      resolution = 'USED'
      answer = { response: { status: fetched.status, bodyText: fetched.bodyText } }
    } catch (error) {
      answer = {
        failure: {
          code: ctx.signal.aborted ? 'CANCELLED' : 'TRANSIENT_NETWORK',
          message: error instanceof Error ? error.message : 'the request failed',
          status: null,
        },
      }
    }
    // Every path out of the try above reaches this line, so the reservation is always resolved.
    const unreconciled: Failure | null = await ctx.meter.reconcile(reservation, resolution).then(
      () => null,
      (error: unknown) => ({
        code: 'PERSISTENCE' as const,
        message: `the reservation could not be reconciled: ${error instanceof Error ? error.message : 'the meter failed'}`,
        status: null,
      }),
    )
    if ('failure' in answer) {
      return refuse(
        answer.failure,
        answer.failure.code === 'CANCELLED' ? 'CANCELLED' : 'ERROR',
        cost,
      )
    }
    if (unreconciled !== null) return refuse(unreconciled, 'ERROR', cost)
    const { response } = answer
    const code = classify(response.status)
    if (code !== null && !(notFoundIsAnAnswer && response.status === 404)) {
      return refuse(
        { code, message: `provider answered HTTP ${response.status}`, status: response.status },
        'ERROR',
        cost,
      )
    }
    return { ok: true, status: response.status, bodyText: response.bodyText, startedAt, cost }
  }

  const jsonOf = (bodyText: string) => parseBoundedJson(bodyText, DEFAULT_API_JSON_LIMITS)

  /** A cached or fetched detail body, judged: the posting's own detail, or nothing. */
  const detailOf = (bodyText: string, id: string): Detail | null => {
    const parsed = jsonOf(bodyText)
    // Stryker disable next-line ConditionalExpression: a body that is not JSON carries no `value`, so without this line `safeParse(undefined)` fails and returns null by the next line; the guard documents the order and cannot change a result.
    if (!parsed.ok) return null
    const detail = detailSchema.safeParse(parsed.value)
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

export function createSmartRecruitersProvider(
  bounds: SmartRecruitersBounds = SMARTRECRUITERS_BOUNDS,
) {
  return definePagedProvider({ type: 'SMARTRECRUITERS_ATS', configSchema }, (config, ctx) =>
    collectSmartRecruiters(bounds, config, ctx),
  )
}

export const smartrecruitersProvider = createSmartRecruitersProvider()
