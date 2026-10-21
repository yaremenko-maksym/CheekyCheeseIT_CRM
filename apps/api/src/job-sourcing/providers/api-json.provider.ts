import type { JobMeterUnit, JobSourceType } from '@crm/shared'
import { z, type ZodType } from 'zod'
import {
  buildSourceObservation,
  type RawObservationFields,
  type SourceObservation,
} from '../normalize/observation'
import { type ApiJsonLimits, DEFAULT_API_JSON_LIMITS } from './api-json.limits'
import { parseBoundedJson } from './bounded-json'
import {
  assertValidatedConfig,
  buildCollectionBatch,
  buildInvalidSample,
  buildRequestReport,
  type CollectionBatch,
  type CollectionContext,
  type CollectionCounts,
  type CollectionErrorCode,
  type CollectionWindow,
  decideCheckpoint,
  type FetchRequest,
  type InvalidSample,
  markValidated,
  MAX_SAMPLES,
  type MeterReservation,
  PG_INT_MAX,
  type ReportingJobSourceProvider,
  type RequestReport,
  type ReservationResolution,
  type ResumePosition,
  cursorPositionSchema,
  type SourceConfigFields,
  type Validated,
  type SourceCoverageScope,
  type StopReason,
  type ValidatedCheckpoint,
} from './reporting-provider'

/**
 * The `ApiJsonProvider` base (Task 2.3): ONE bounded page loop that all of phase 3's JSON adapters
 * share, and an adapter spec that is DATA.
 *
 * "DESIGN IT TWICE" — the rejected alternative was the obvious one: an
 * `abstract class ApiJsonProvider` with a final `collectReport` calling abstract `buildRequest` /
 * `parseEnvelope` / `mapItem`. Same depth, and rejected for two reasons.
 *
 *  - The AC1 invariant would be OVERRIDABLE. A subclass can override `collectReport`, and the one
 *    thing that must not be per-adapter is exactly the thing inheritance leaves open. Here outcome
 *    and coverage are derived inside `collectJsonPages` from facts the spec cannot reach, and a
 *    spec has no slot in which to claim either.
 *  - The loop could only be tested through a fake subclass — testing from behind the interface. As
 *    a function over ports it is tested through the same seam the adapters use.
 *
 * So: `collectJsonPages` is the deep module, `ApiJsonSourceSpec` is the seam, and the ~25 adapters
 * are adapters in the role sense — each occupies the slot, none of them owns the lifecycle.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** `jobSourceIdentitySchema.namespace` in the phase-1 store. Its number, not ours. */
export const NAMESPACE_MAX_CHARS = 200

/**
 * Re-exported, not re-declared: the checkpoint schema in `reporting-provider.ts` bounds a stored
 * page by the same PostgreSQL `integer` ceiling, and two copies of a number that must agree are
 * one copy too many.
 */
export { PG_INT_MAX } from './reporting-provider'

/**
 * A request URL that was never built, because the adapter threw while building it. A valid URL (so
 * the report's structural redaction parses it) that is obviously not an endpoint.
 */
export const UNBUILT_REQUEST_URL = 'about:request-not-built'

/** How far back a restart-with-overlap widens a windowed scope (AC4). */
export const DEFAULT_OVERLAP_MS = 24 * 60 * 60 * 1000

/**
 * Every adapter's config extends this. The two bounds are taken from the phase-1 store rather than
 * chosen here: a namespace of 201 characters and a config version of 2^31 both parse happily as
 * "a string" and "a number" and are then refused by the column, at persist time, after the work.
 * `reporting-provider.store-conformance.spec.ts` asserts both sides of both.
 */
export const baseSourceConfigSchema = z.object({
  namespace: z.string().max(NAMESPACE_MAX_CHARS).default(''),
  configVersion: z.number().int().positive().max(PG_INT_MAX),
  /** Non-null makes this a SEARCH scope, which changes what coverage it may claim. */
  query: z.string().max(500).nullable().default(null),
  window: z.object({ from: z.coerce.date(), to: z.coerce.date() }).nullable().default(null),
})

// ---------------------------------------------------------------------------
// The spec — the seam
// ---------------------------------------------------------------------------

/**
 * Where the loop is, and what window it is covering. `page` is 1-based and about to be fetched.
 *
 * `window` is the field this type exists for. It WAS `{ page, cursor }`, and `widenScope`'s result
 * went into a local that reached `batch.scope.window` and never `spec.pageRequest` — so a restart
 * REPORTED a widened window and then asked the provider for the unwidened one. Measured: a
 * checkpoint under a stale config widened the reported window to `2026-09-30` while the request on
 * the wire still carried `from=2026-10-01` (SPEC-H-1). The three tests that covered the overlap
 * asserted `batch.scope.window`, which is the half that was already right, so all three passed.
 *
 * AN ADAPTER MUST BUILD ITS REQUEST FROM `at.window`, NEVER FROM `config.window`:
 * `config.window` is what was CONFIGURED, `at.window` is what this attempt is actually covering.
 */
export interface PageTarget {
  page: number
  cursor: string | null
  window: CollectionWindow | null
}

export interface PageRequest {
  request: FetchRequest
  /** Key for the conditional-request cache. Omit to skip caching for this page. */
  cacheKey?: string
}

/**
 * ONE adapter, as data.
 *
 * The three override seams the plan asks for are the three function fields: FETCH is
 * `pageRequest` (the adapter says what to ask for; the loop, never the adapter, does the asking,
 * so bounds and metering cannot be skipped), MAP is `mapItem`, SCHEMA is `envelopeSchema` +
 * `itemSchema`.
 */
export interface ApiJsonSourceSpec<TConfig extends SourceConfigFields, TEnvelope, TItem> {
  readonly type: JobSourceType
  /** Bumped when the mapping changes. The loop stamps it on every observation and checkpoint, so
   * an adapter cannot disagree with itself about which version produced a row. */
  readonly adapterVersion: string
  readonly configSchema: ZodType<TConfig>
  /**
   * The page envelope. MUST treat the item array as OPAQUE (`z.array(z.unknown())`): the envelope
   * is the subrequest's contract and a failure here is drift that fails the subrequest, while a
   * bad ITEM must be isolated (AC3). An envelope schema that validated items inline would turn one
   * malformed posting into a failed page — precisely the behaviour the AC forbids.
   */
  readonly envelopeSchema: ZodType<TEnvelope>
  readonly itemSchema: ZodType<TItem>
  pageRequest(config: TConfig, at: PageTarget): PageRequest
  extractItems(envelope: TEnvelope, config: TConfig): readonly unknown[]
  /**
   * The cursor for the NEXT page, or `null` when the provider's inventory is exhausted.
   *
   * WHATEVER YOU RETURN HERE IS UNTRUSTED INPUT, and it comes back to you as `at.cursor`. It is
   * the only value in the loop chosen entirely by the upstream provider: the loop bounds its
   * LENGTH (`MAX_CURSOR_CHARS`, parsed before it is stored) and nothing else, because nothing
   * else about it is knowable from here.
   *
   * SO AN ADAPTER MUST NOT USE A CURSOR AS THE REQUEST TARGET. A "next URL" style cursor fed
   * straight into `pageRequest`'s `request.url` hands the provider control of where we send the
   * next request, credentials and all — a redirect to an attacker-chosen host, with our headers.
   * Use the cursor as a PARAMETER of a URL the adapter builds (`?after=<cursor>`), or, if the
   * provider really only gives absolute next-links, parse it and check its origin against the one
   * the config configured before using it.
   */
  nextCursor(envelope: TEnvelope, at: PageTarget): string | null
  /**
   * Map one VALIDATED item to untrusted observation fields. May throw: the item is isolated with a
   * bounded sample and the batch goes on (AC3).
   *
   * `provider` and `adapterVersion` are deliberately NOT returnable — the loop supplies both from
   * the spec, so 25 adapters cannot each get them subtly wrong.
   */
  mapItem(item: TItem, config: TConfig): Omit<RawObservationFields, 'provider' | 'adapterVersion'>
  /**
   * The id the PROVIDER issued for this item, whatever the adapter chose to key identity on.
   *
   * It exists so the AC5 invariant is REACHABLE. `normalizeNativeId` in the identity seam is
   * NFC + trim, so two distinct ids fed into a NATIVE_ID key can never collide — the collapse that
   * actually happens is an adapter that keys on the canonical URL (URL_FALLBACK) while the
   * provider was issuing distinct ids all along, and `raw.nativeId` is `null` in exactly that
   * case. Without this field the check would be unreachable code: its passing would be
   * indistinguishable from its absence.
   *
   * Defaults to the id the adapter passed into the identity.
   */
  nativeIdOf?(item: TItem, config: TConfig): string | null
  scopeOf(config: TConfig): SourceCoverageScope
  readonly limits?: Partial<ApiJsonLimits>
  /** What one page costs. Reserved BEFORE any I/O, per the store's reservation ordering. */
  readonly meter?: { unit: JobMeterUnit; amountPerRequest: number }
  readonly overlapMs?: number
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Two items with DIFFERENT provider-issued ids that produced the SAME identity key. That is not a
 * data problem to quarantine and not a ratio to threshold — it means the adapter's identity
 * mapping is wrong, and every record it ever wrote under that key is suspect (AC5).
 *
 * Deliberately NOT a 50 %-duplicate heuristic: a provider legitimately returning the same posting
 * on two pages is normal, and a threshold would both miss a two-record collapse and fire on a
 * healthy overlap.
 */
export class AdapterIdentityCollisionError extends Error {
  constructor(
    readonly identityKey: string,
    readonly firstNativeId: string,
    readonly secondNativeId: string,
  ) {
    super(
      `adapter invariant: native ids ${firstNativeId} and ${secondNativeId} collapsed to one identity key`,
    )
    this.name = 'AdapterIdentityCollisionError'
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/**
 * One page's dispositions, before the attempt knows whether the page survived.
 *
 * `discarded` is deliberately ABSENT rather than present-and-zero: a page cannot discard itself,
 * only the attempt can discard a page, so the field has no meaning at this scale. A
 * `discarded: 0` that `observePage` never writes would be arithmetic no test could observe.
 */
type PageCounts = Omit<CollectionCounts, 'discarded'>

const emptyAttemptCounts = (): CollectionCounts => ({
  raw: 0,
  normalized: 0,
  invalid: 0,
  quarantined: 0,
  discarded: 0,
})

const emptyPageCounts = (): PageCounts => ({
  raw: 0,
  normalized: 0,
  invalid: 0,
  quarantined: 0,
})

/**
 * Add ONE page's dispositions to the attempt's, and decide where its `normalized` goes. THE ONLY
 * PLACE THAT CHOICE IS MADE.
 *
 * `observePage` used to increment the attempt's counts in place, which meant the decision was
 * taken before its outcome was known: items observed on a page that then failed stayed counted as
 * `normalized` while their observations were thrown away, so `counts.normalized` and
 * `observations.length` disagreed on exactly the pages that failed (CR-M-5 = SPEC-M-3). A page's
 * counts are therefore PROVISIONAL until the page lands, and "lands" means its `savePage`
 * resolved — not merely that its items parsed.
 *
 * `raw`, `invalid` and `quarantined` are unaffected by the disposition: we did receive those items
 * and the reason each was refused does not change because the page later failed.
 */
function addPageCounts(
  total: CollectionCounts,
  page: PageCounts,
  disposition: 'KEPT' | 'DISCARDED',
): void {
  total.raw += page.raw
  total.invalid += page.invalid
  total.quarantined += page.quarantined
  if (disposition === 'KEPT') {
    total.normalized += page.normalized
  } else {
    total.discarded += page.normalized
  }
}

function widenScope(scope: SourceCoverageScope, overlapMs: number): SourceCoverageScope {
  if (scope.window === null) return scope
  return {
    ...scope,
    window: {
      from: new Date(scope.window.from.getTime() - overlapMs),
      to: scope.window.to,
    },
  }
}

type BuiltPageRequest = { ok: true; value: PageRequest } | { ok: false; message: string }

/**
 * What happens after a page has been observed — decided BEFORE the page is persisted, because the
 * decision includes whether the provider's next cursor is usable at all, and that must be known
 * before it is written to the database (SR-H-3).
 *
 * A union rather than three nullable locals. The nullable form is what produced two branches no
 * input could enter and three separate `at.page + 1` sites; here each arm carries exactly the
 * fields its own case needs, so the compiler supplies `request` and `cursor` on the arm that has
 * them and no caller has to re-check a condition already settled.
 */
type PageAdvance =
  /**
   * The trail continues, and the next request is already built and known good.
   *
   * `position` is the PARSED checkpoint position, not one assembled again later: the cursor was
   * validated against `resumePositionSchema` before the adapter was handed it, and carrying the
   * parsed value is what keeps the thing we store and the thing we checked from being two
   * different objects (SR-M-2).
   */
  | {
      kind: 'CONTINUE'
      cursor: string
      target: PageTarget
      request: PageRequest
      position: Extract<ResumePosition, { kind: 'CURSOR' }>
    }
  /** The provider returned a cursor the adapter cannot build a request from. */
  | { kind: 'UNUSABLE_CURSOR'; page: number; message: string }
  /** The provider's inventory ran out. */
  | { kind: 'EXHAUSTED' }

/**
 * Ask the adapter for a page request, and treat a throw as data.
 *
 * Called in TWO places, which is the point. Once for the page about to be fetched, and once for
 * the page a cursor would lead to — BEFORE that cursor is persisted. A cursor the adapter cannot
 * build a request from is unusable, and persisting it makes every later attempt reject before any
 * fetch, with nothing in the batch to say why.
 */
function buildPageRequest<TConfig extends SourceConfigFields, TEnvelope, TItem>(
  spec: ApiJsonSourceSpec<TConfig, TEnvelope, TItem>,
  config: TConfig,
  at: PageTarget,
): BuiltPageRequest {
  try {
    return { ok: true, value: spec.pageRequest(config, at) }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'the page request could not be built',
    }
  }
}

/** HTTP status -> our typed code. Classified from the STATUS, never from the body text. */
function classifyStatus(status: number): CollectionErrorCode | null {
  if (status >= 200 && status < 300) return null
  if (status === 304) return null
  if (status === 401 || status === 403) return 'ACCESS_POLICY'
  if (status === 429) return 'RATE_LIMIT'
  // No separate 5xx branch: it returned exactly what the fall-through returns, so it was four
  // mutants no test could ever distinguish. A 5xx and a 4xx differ in RETRY policy, which is Task
  // 2.2's and reads the status from the report — not in how this seam classifies them.
  return 'UPSTREAM'
}

interface PageAttemptFailure {
  code: CollectionErrorCode
  message: string
  status: number | null
}

/**
 * Collect every page the bounds allow, and report what happened.
 *
 * The ORDER of the three things that happen per page is the contract, not an implementation
 * detail: reserve -> fetch -> validate -> observe -> PERSIST, and the loop does not advance until
 * the persist resolves (AC4). `api-json.provider.spec.ts` asserts the recorded call order rather
 * than each call's presence, because a loop that made both calls in the wrong order would satisfy
 * every per-call assertion.
 */
export async function collectJsonPages<TConfig extends SourceConfigFields, TEnvelope, TItem>(
  spec: ApiJsonSourceSpec<TConfig, TEnvelope, TItem>,
  config: TConfig,
  ctx: CollectionContext,
): Promise<CollectionBatch> {
  const limits: ApiJsonLimits = { ...DEFAULT_API_JSON_LIMITS, ...spec.limits }
  const overlapMs = spec.overlapMs ?? DEFAULT_OVERLAP_MS

  const stored = await ctx.checkpoints.load()
  const decision = decideCheckpoint(stored, {
    configVersion: config.configVersion,
    policyVersion: ctx.policyVersion,
    adapterVersion: spec.adapterVersion,
  })

  let scope = spec.scopeOf(config)
  let at: PageTarget = { page: 1, cursor: null, window: scope.window }
  let checkpoint: ValidatedCheckpoint | null = null
  const resumed = decision.kind === 'RESUME'

  if (decision.kind === 'RESTART_WITH_OVERLAP') {
    // The cursor belonged to a config / policy / adapter that no longer exists (or did not parse
    // at all), so discovery starts over — and over a WIDER window, because whatever moved across
    // the old boundary while the config changed would otherwise never be read again.
    scope = widenScope(scope, overlapMs)
    // The widened window goes into the TARGET too, so the adapter asks the provider for the window
    // we are claiming to have covered. Assigning it only to `scope` is SPEC-H-1.
    at = { page: 1, cursor: null, window: scope.window }
  } else if (decision.kind === 'RESUME') {
    // Only a `CURSOR` position reaches here: `decideCheckpoint` turns a `RESTART` into `FRESH`.
    const position = decision.from.position
    at = { page: position.page + 1, cursor: position.cursor, window: scope.window }
    checkpoint = decision.from
  }

  /**
   * THE PAGE BOUND IS PER ATTEMPT, measured from where this attempt started.
   *
   * It used to compare the ABSOLUTE page against `maxPages`, which this file's own doc calls "pages
   * per attempt". Measured: run 1 completed 10 pages and stored page 10; run 2 resumed at page 11,
   * found `11 > 10`, made ZERO fetches and reported SUCCEEDED — and would do so for every run
   * after it, forever. The source froze at page 10, page 1 was never read again, and the outcome
   * claimed success (SR-H-1). An attempt must always be able to make progress.
   */
  const startPage = at.page

  const observations: SourceObservation[] = []
  const requests: RequestReport[] = []
  const samples: InvalidSample[] = []
  const counts: CollectionCounts = emptyAttemptCounts()
  // Seeding the RESUMED cursor is what makes a provider handing it straight back a cycle, and a
  // test asserts exactly that. (The suppression that used to sit here claimed the `null` half was
  // unobservable; the mutant it hid is killed by that same test, so it is gone — CR-M-2.)
  // Keyed on the DECISION, not on `at.cursor !== null`. The latter reads the same but its mutants
  // are unobservable: on a fresh run `at.cursor` is null, and adding a null to the set changes
  // nothing, because `has()` is only ever asked about a cursor the provider returned. Keyed this
  // way both halves bite — `RESUME` narrows the position to a `CURSOR`, so the cursor is a string
  // the compiler can see, and skipping the seed makes the cycle test fail.
  const seenCursors = new Set<string>(
    // Stryker disable next-line ArrayDeclaration: seeding this set with any non-cursor string is unobservable, because membership is only ever tested against a cursor the provider actually returned, and those are non-empty strings that cannot equal a placeholder.
    decision.kind === 'RESUME' ? [decision.from.position.cursor] : [],
  )
  const nativeIdByIdentityKey = new Map<string, string>()

  let pagesCompleted = 0
  // NO INITIALIZER, deliberately: the compiler now proves every path out of the loop assigns it.
  // It used to read `= 'EXHAUSTED'` under a suppression whose stated reason was that an
  // unrecognised value would throw in `deriveOutcome` — but `'EXHAUSTED'` is RECOGNISED, and it is
  // the one value that carries SUCCEEDED, so a path that forgot to assign would have reported a
  // silent success. Removing the initializer still typechecks, which means the proof was available
  // all along (CR-M-1).
  let stop: StopReason

  const addSample = (page: number, reason: string, raw: unknown): void => {
    // Stryker disable next-line ConditionalExpression,EqualityOperator: the OBSERVABLE cap is
    // `buildCollectionBatch`'s slice, asserted on both sides in reporting-provider.spec.ts. This
    // early return bounds MEMORY while a 10 000-item page is being refused; it cannot change the
    // reported samples, so there is nothing for a test to catch here.
    if (samples.length >= MAX_SAMPLES) return
    samples.push(buildInvalidSample(page, reason, raw, ctx.secrets))
  }

  while (true) {
    if (at.page - startPage >= limits.maxPages) {
      stop = 'PAGE_CAP'
      // A bound we chose is still a reason the inventory is short, and `PAGE_CAP` is in
      // `COLLECTION_ERROR_CODES` precisely so it can be reported. It used to stop silently, so an
      // operator reading the reports saw a clean run that had simply stopped early.
      requests.push(
        buildRequestReport(
          {
            attempt: 1,
            page: at.page,
            url: UNBUILT_REQUEST_URL,
            status: null,
            startedAt: ctx.now(),
            endedAt: ctx.now(),
            cost: null,
            error: {
              code: 'PAGE_CAP',
              message: `the attempt reached its ${limits.maxPages}-page bound`,
            },
          },
          ctx.secrets,
        ),
      )
      break
    }

    const startedAt = ctx.now()
    // IN a try: `spec.pageRequest` is adapter code and it throws. It used to sit outside every
    // catch, so a cursor the adapter could not parse escaped `collectJsonPages` as a raw
    // `TypeError` — measured: no `CollectionBatch` at all, no outcome, no error code, nothing, and
    // permanently, because the cursor was already persisted (SR-H-3).
    const built = buildPageRequest(spec, config, at)
    if (!built.ok) {
      stop = 'ERROR'
      requests.push(
        buildRequestReport(
          {
            attempt: 1,
            page: at.page,
            url: UNBUILT_REQUEST_URL,
            status: null,
            startedAt,
            endedAt: ctx.now(),
            cost: null,
            error: { code: 'PARSE_DRIFT', message: built.message },
          },
          ctx.secrets,
        ),
      )
      break
    }
    const pageRequest = built.value

    if (ctx.signal.aborted) {
      stop = 'CANCELLED'
      requests.push(
        buildRequestReport(
          {
            attempt: 1,
            page: at.page,
            url: pageRequest.request.url,
            status: null,
            startedAt,
            endedAt: ctx.now(),
            cost: null,
            error: { code: 'CANCELLED', message: 'the run was cancelled before this page' },
          },
          ctx.secrets,
        ),
      )
      break
    }

    if (ctx.now().getTime() >= ctx.deadline.getTime()) {
      stop = 'ERROR'
      requests.push(
        buildRequestReport(
          {
            attempt: 1,
            page: at.page,
            url: pageRequest.request.url,
            status: null,
            startedAt,
            endedAt: ctx.now(),
            cost: null,
            error: { code: 'DEADLINE', message: 'the attempt deadline passed before this page' },
          },
          ctx.secrets,
        ),
      )
      break
    }

    // RESERVED before any I/O. A refusal is a cost stop, not an error: nothing went wrong, we are
    // simply out of budget, and everything already persisted stands.
    let reservation: MeterReservation | null = null
    if (spec.meter !== undefined) {
      reservation = await ctx.meter.reserve(spec.meter.unit, spec.meter.amountPerRequest)
      if (reservation === null) {
        stop = 'COST_STOP'
        requests.push(
          buildRequestReport(
            {
              attempt: 1,
              page: at.page,
              url: pageRequest.request.url,
              status: null,
              startedAt,
              endedAt: ctx.now(),
              cost: null,
              error: { code: 'COST_STOP', message: 'the meter refused a reservation' },
            },
            ctx.secrets,
          ),
        )
        break
      }
    }

    const cost =
      reservation === null ? null : { unit: reservation.unit, amount: reservation.amount }

    // The failure paths below deliberately do NOT assign this: `failure !== null` short-circuits
    // before anything parses the body, so no test can observe what it holds on those paths.
    // Stryker disable next-line StringLiteral: unobservable for the reason above.
    let bodyText = ''
    let status: number
    let failure: PageAttemptFailure | null = null
    // A `let` because a cached validator rewrites it, and it is read by the reports below — which
    // are outside the span, so it cannot live inside the try.
    let request: FetchRequest = pageRequest.request

    /**
     * THE WHOLE RESERVE -> RECONCILE SPAN IS ONE TRY, WITH `reconcile` IN A `finally`.
     *
     * The hole was not the fetch — that was already caught — but the CACHE READ beside it.
     * `ctx.cache.get` sat outside every catch and after the reservation, so a cache that threw
     * left the meter log at `['reserve']` and rejected `collectJsonPages` outright: a reservation
     * held with no resolution. That is money, not telemetry (SR-M-1).
     *
     * Patching that one call would leave the same hole open for the next `await` anyone adds
     * between the reserve and the reconcile. A reservation is a RESOURCE — acquired on one line,
     * released on every path out — and in JavaScript that is spelled `finally`.
     *
     * `resolution` says WHICH release, and it advances WITH the request rather than being decided
     * inside the catch, where the catch cannot tell how far we got:
     *
     *   RELEASED  — nothing has left the process yet, so nothing can have been billed
     *   UNCERTAIN — the request is in flight; a timeout may already have been billed, and
     *               claiming RELEASED would understate what we owe
     *   USED      — a response provably arrived, whatever its status
     *
     * All three are reachable and asserted, so the `finally` is not a guard without a failing test.
     */
    let resolution: ReservationResolution = 'RELEASED'

    try {
      const cached =
        pageRequest.cacheKey === undefined ? null : await ctx.cache.get(pageRequest.cacheKey)
      if (cached !== null) {
        request = {
          ...pageRequest.request,
          headers: { ...pageRequest.request.headers, 'if-none-match': cached.etag },
        }
      }

      resolution = 'UNCERTAIN'
      const response = await ctx.fetchText(request)
      resolution = 'USED'
      status = response.status
      const statusCode = classifyStatus(status)
      if (statusCode !== null) {
        failure = { code: statusCode, message: `provider answered HTTP ${status}`, status }
      } else if (status === 304 && cached !== null) {
        // A valid 304 reuses the stored body rather than refetching it.
        bodyText = cached.bodyText
      } else if (status === 304) {
        failure = {
          code: 'PARSE_DRIFT',
          message: 'provider answered 304 for a request that carried no validator',
          status,
        }
      } else {
        bodyText = response.bodyText
        if (response.etag !== null && pageRequest.cacheKey !== undefined) {
          /**
           * THE CACHE'S TWO FAILURES ARE NOT THE SAME FAILURE, AND DIRECTION IS WHAT DECIDES.
           *
           * A READ fails before anything was sent: we have no page, so the attempt reports it and
           * stops with its completed pages intact (the branch above).
           *
           * A WRITE fails AFTER a 200 whose body is already in hand. The page is complete and
           * valid; the only thing lost is the validator that would have saved a refetch next
           * time. Letting it reach the span's catch is CR-M-4: measured, a `put` rejecting after
           * a good 200 dropped the page entirely and reported `TRANSIENT_NETWORK` — a cache
           * outage blamed on the provider's network, with the page gone.
           *
           * So the write degrades and the page stands. The reservation is still resolved by the
           * `finally`, which is why this does not reopen SR-M-1.
           */
          try {
            await ctx.cache.put(pageRequest.cacheKey, { etag: response.etag, bodyText })
          } catch {
            // Deliberately nothing: see above. There is no report slot for "the page is fine but
            // the cache is not", and inventing one would mean a request report describing a
            // subrequest that succeeded.
          }
        }
      }
    } catch (error) {
      status = 0
      failure =
        // `RELEASED` is still set only while nothing has left the process — which is precisely
        // the condition under which the throw CANNOT be the provider's. It is our own storage,
        // so it is `PERSISTENCE`, the code this module already reserves for our fault (AC3).
        resolution === 'RELEASED'
          ? {
              code: 'PERSISTENCE',
              message: `the response cache could not be read: ${error instanceof Error ? error.message : 'the cache failed'}`,
              status: null,
            }
          : {
              code: ctx.signal.aborted ? 'CANCELLED' : 'TRANSIENT_NETWORK',
              message: error instanceof Error ? error.message : 'the request failed',
              status: null,
            }
    } finally {
      if (reservation !== null) {
        await ctx.meter.reconcile(reservation, resolution)
        reservation = null
      }
    }

    if (failure === null) {
      const parsed = parseBoundedJson(bodyText, limits)
      if (!parsed.ok) {
        failure = {
          code: parsed.reason === 'NOT_JSON' ? 'PARSE_DRIFT' : 'PAYLOAD_TOO_LARGE',
          message: `${parsed.reason}: ${parsed.detail}`,
          status,
        }
      } else {
        const envelope = spec.envelopeSchema.safeParse(parsed.value)
        if (!envelope.success) {
          failure = {
            code: 'PARSE_DRIFT',
            // Stryker disable next-line OptionalChaining: a Zod result with `success: false`
            // always carries at least one issue, so `issues[0]` is never undefined and the
            // optional chain cannot be made to fire. The FALLBACK is asserted to be unused (the
            // test requires the schema's own words), which is the half that can be observed.
            message: `envelope: ${envelope.error.issues[0]?.message ?? 'did not match'}`,
            status,
          }
        } else {
          const pageResult = await observePage(
            spec,
            config,
            ctx,
            envelope.data,
            at,
            nativeIdByIdentityKey,
            addSample,
            limits,
          )
          if (!pageResult.ok) {
            // The page's items were received and then thrown away with the page.
            addPageCounts(counts, pageResult.counts, 'DISCARDED')
            failure = { ...pageResult.failure, status }
          } else {
            /**
             * THE CURSOR IS VERIFIED BEFORE IT IS PERSISTED.
             *
             * `savePage` used to store whatever `nextCursor` returned, and the loop then handed it
             * to `spec.pageRequest` on the NEXT iteration. A cursor the adapter cannot build a
             * request from therefore became permanent poison: measured with an adapter doing
             * `new URL(cursor)`, every later run threw before any fetch and produced no batch at
             * all (SR-H-3). So the next page's request is built HERE, on this side of the persist,
             * and an unusable cursor is stored as a `RESTART` instead — observations land, the
             * attempt ends with the drift reported, and the next attempt starts over rather than
             * replaying a rejection.
             */
            /**
             * ONE value answering "what happens after this page", as a union rather than three
             * nullable locals. The nullable form forced two branches nothing could enter — a
             * `nextTarget ?? {…}` fallback and a `nextRequest === null ? … : …` ternary, both
             * unreachable because the guards above already settled them — and it spread
             * `at.page + 1` over three sites, which is the arithmetic an off-by-one in would
             * reproduce SR-H-1 (a resumed attempt reporting SUCCEEDED after zero fetches). Now it
             * appears once, and every arm below is reachable and asserted.
             */
            const nextPage = at.page + 1
            const advance: PageAdvance =
              pageResult.nextCursor === null
                ? { kind: 'EXHAUSTED' }
                : ((): PageAdvance => {
                    const cursor = pageResult.nextCursor
                    /**
                     * THE CURSOR IS PARSED BEFORE THE ADAPTER IS HANDED IT, against the very
                     * schema the checkpoint will have to satisfy on the way back in.
                     *
                     * A cursor is the ONE value in this loop chosen entirely by the provider, and
                     * it was stored unparsed: `ValidatedCheckpoint` was built as an object
                     * literal, whose name is a claim and whose construction checks nothing.
                     * Measured, a 1 MiB cursor was persisted verbatim (SR-M-2).
                     *
                     * Parsed FIRST, before `buildPageRequest`, for two reasons: handing a
                     * megabyte of provider-chosen text to 25 adapters' URL builders is work
                     * nobody asked for, and a cursor we cannot store is unusable whether or not
                     * an adapter can build a request from it.
                     *
                     * The whole position is parsed rather than the cursor's length compared to
                     * `MAX_CURSOR_CHARS` here: one guard, one bound, declared in one place. The
                     * `RESTART` position below is deliberately NOT parsed — its only field is a
                     * page the loop itself bounded, so the parse would be a branch no input can
                     * enter.
                     */
                    const stored = cursorPositionSchema.safeParse({
                      kind: 'CURSOR',
                      page: at.page,
                      cursor,
                    })
                    if (!stored.success) {
                      return {
                        kind: 'UNUSABLE_CURSOR',
                        page: nextPage,
                        // Stryker disable next-line OptionalChaining: a Zod result with
                        // `success: false` always carries an issue, as elsewhere in this file;
                        // the fallback's absence is what the test asserts.
                        message: `it cannot be stored (${stored.error.issues[0]?.message ?? 'refused'})`,
                      }
                    }
                    const position = stored.data
                    const target: PageTarget = { page: nextPage, cursor, window: at.window }
                    const probe = buildPageRequest(spec, config, target)
                    return probe.ok
                      ? { kind: 'CONTINUE', cursor, target, request: probe.value, position }
                      : { kind: 'UNUSABLE_CURSOR', page: nextPage, message: probe.message }
                  })()

            const position: ResumePosition =
              // The PARSED position on the continuing arm — the one the schema accepted, rather
              // than a second literal built from the same parts and checked by nothing.
              advance.kind === 'CONTINUE' ? advance.position : { kind: 'RESTART', page: at.page }

            const next: ValidatedCheckpoint = {
              configVersion: config.configVersion,
              policyVersion: ctx.policyVersion,
              adapterVersion: spec.adapterVersion,
              position,
              completedAt: ctx.now(),
            }
            try {
              // Observations AND checkpoint, together, before the loop may continue.
              await ctx.checkpoints.savePage({
                observations: pageResult.observations,
                checkpoint: next,
              })
              observations.push(...pageResult.observations)
              // AFTER the persist resolved, which is the only moment at which "kept" is true. A
              // page whose `savePage` rejects is the SECOND instance of CR-M-5 — the reviewer
              // named the observe-failure path, and this one has the same shape — and it is why
              // the merge lives here rather than beside `observePage`.
              addPageCounts(counts, pageResult.counts, 'KEPT')
              checkpoint = next
              pagesCompleted += 1
            } catch (error) {
              // OUR failure, not the provider's: it is PERSISTENCE and it never touches
              // `counts.invalid` (AC3) — those items go to `discarded`, the bucket for "received,
              // observed, then lost with the page". The page is not counted as completed, so the
              // checkpoint still names the last page that really landed.
              addPageCounts(counts, pageResult.counts, 'DISCARDED')
              failure = {
                code: 'PERSISTENCE',
                message: error instanceof Error ? error.message : 'the page could not be persisted',
                status,
              }
            }

            // Inside the branch where `pageResult` is known to have succeeded: the cursor it
            // carries only exists on that branch, and reading it from outside was what forced a
            // redundant re-check of a condition no test could falsify.
            if (failure === null) {
              requests.push(
                buildRequestReport(
                  {
                    attempt: 1,
                    page: at.page,
                    url: request.url,
                    status,
                    startedAt,
                    endedAt: ctx.now(),
                    cost,
                    error: null,
                  },
                  ctx.secrets,
                ),
              )
              if (advance.kind === 'EXHAUSTED') {
                stop = 'EXHAUSTED'
                break
              }
              if (advance.kind === 'UNUSABLE_CURSOR') {
                // The page is persisted and its position is a `RESTART`, so nothing is poisoned.
                // The attempt ends reporting WHY, which is the part that used to be missing.
                stop = 'ERROR'
                requests.push(
                  buildRequestReport(
                    {
                      attempt: 1,
                      page: advance.page,
                      url: UNBUILT_REQUEST_URL,
                      status: null,
                      startedAt: ctx.now(),
                      endedAt: ctx.now(),
                      cost: null,
                      error: {
                        code: 'PARSE_DRIFT',
                        message: `the provider's next cursor is unusable: ${advance.message}`,
                      },
                    },
                    ctx.secrets,
                  ),
                )
                break
              }
              if (seenCursors.has(advance.cursor)) {
                stop = 'CURSOR_CYCLE'
                // `CURSOR_CYCLE` is in `COLLECTION_ERROR_CODES`, and the stop used to push no
                // report carrying it — so a cycle was indistinguishable from a clean finish in
                // everything except the coverage axis (SR-L-4).
                requests.push(
                  buildRequestReport(
                    {
                      attempt: 1,
                      page: advance.target.page,
                      // The request the cycle WOULD have sent — available by TYPE on this arm,
                      // which is what removed a `nextRequest === null ? …` ternary whose null
                      // branch no input could reach.
                      url: advance.request.request.url,
                      status: null,
                      startedAt: ctx.now(),
                      endedAt: ctx.now(),
                      cost: null,
                      error: {
                        code: 'CURSOR_CYCLE',
                        message: 'the provider handed back a cursor this attempt had already seen',
                      },
                    },
                    ctx.secrets,
                  ),
                )
                break
              }
              seenCursors.add(advance.cursor)
              // The very target whose request was validated before the persist.
              at = advance.target
              continue
            }
          }
        }
      }
    }

    // Any failure that reached here ends the attempt, having kept every page already persisted.
    requests.push(
      buildRequestReport(
        {
          attempt: 1,
          page: at.page,
          url: request.url,
          status: failure.status,
          startedAt,
          endedAt: ctx.now(),
          cost,
          error: { code: failure.code, message: failure.message },
        },
        ctx.secrets,
      ),
    )
    stop = failure.code === 'CANCELLED' ? 'CANCELLED' : 'ERROR'
    break
  }

  return buildCollectionBatch({
    observations,
    facts: { stop, pagesCompleted, counts, scope, resumed },
    requests,
    checkpoint,
    invalidSamples: samples,
  })
}

/**
 * A discriminated union rather than one record with a nullable `failure`. With the flat shape, the
 * failure returns had to carry `observations: []` and `nextCursor: null` — fields the caller never
 * reads on that branch, so no test could tell what they held. A shape that cannot express the
 * contradiction needs no defending.
 */
type PageResult =
  | {
      ok: true
      observations: SourceObservation[]
      nextCursor: string | null
      counts: PageCounts
    }
  // `counts` is on BOTH arms because the caller reads it on both: a failed page's items were
  // still received, and the attempt still has to account for them. That is the opposite of the
  // `observations: []` / `nextCursor: null` padding this union replaced, which no caller read.
  | { ok: false; failure: { code: CollectionErrorCode; message: string }; counts: PageCounts }

/**
 * Validate and observe one page's items.
 *
 * It RETURNS this page's counts rather than adding them to the attempt's, which is the whole of
 * the CR-M-5 fix: whether a page's observations count as kept depends on what happens AFTER this
 * function returns (the page still has to persist), so this function is not the one that can
 * decide. It mutates only the cross-page identity map, which is genuinely attempt-scoped.
 */
async function observePage<TConfig extends SourceConfigFields, TEnvelope, TItem>(
  spec: ApiJsonSourceSpec<TConfig, TEnvelope, TItem>,
  config: TConfig,
  ctx: CollectionContext,
  envelope: TEnvelope,
  at: PageTarget,
  nativeIdByIdentityKey: Map<string, string>,
  addSample: (page: number, reason: string, raw: unknown) => void,
  limits: ApiJsonLimits,
): Promise<PageResult> {
  const counts: PageCounts = emptyPageCounts()
  let items: readonly unknown[]
  try {
    items = spec.extractItems(envelope, config)
  } catch (error) {
    return {
      ok: false,
      counts,
      failure: {
        code: 'PARSE_DRIFT',
        message: error instanceof Error ? error.message : 'the items could not be extracted',
      },
    }
  }

  if (items.length > limits.maxItemsPerPage) {
    // The provider ignored the page size we asked for. Treating it as drift rather than silently
    // truncating keeps us from reporting a coverage we did not have.
    return {
      ok: false,
      counts,
      failure: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `page carried ${items.length} items, over the ${limits.maxItemsPerPage} cap`,
      },
    }
  }

  const observations: SourceObservation[] = []

  for (const item of items) {
    counts.raw += 1

    const validated = spec.itemSchema.safeParse(item)
    if (!validated.success) {
      counts.invalid += 1
      // Stryker disable next-line OptionalChaining: as above — a failed Zod result always has an
      // issue, so the optional chain is unreachable; the fallback's absence IS asserted.
      addSample(at.page, `ITEM_SCHEMA: ${validated.error.issues[0]?.message ?? 'invalid'}`, item)
      continue
    }

    let raw: RawObservationFields
    try {
      raw = {
        ...spec.mapItem(validated.data, config),
        provider: spec.type,
        adapterVersion: spec.adapterVersion,
      }
    } catch (error) {
      // An extractor exception is ONE bad item, not a bad page.
      counts.invalid += 1
      addSample(
        at.page,
        `MAPPER_THREW: ${error instanceof Error ? error.message : 'mapItem threw'}`,
        item,
      )
      continue
    }

    const result = buildSourceObservation(raw, { now: ctx.now() })
    if (!result.ok) {
      counts.quarantined += 1
      addSample(at.page, `QUARANTINED: ${result.reason}`, item)
      continue
    }

    const { identityKey } = result.observation.identity
    const nativeId = spec.nativeIdOf?.(validated.data, config) ?? raw.nativeId ?? null
    // The suppression that used to sit here claimed this guard was unobservable. It is not, and
    // the difference is a false ADAPTER_INVARIANT: with the guard removed, an item whose provider
    // id is unknown records `null` against its identity key, and the NEXT item on that same key —
    // with a perfectly good id — compares `null !== 'that id'` and is reported as a collapse. A
    // success becomes FAILED. `records a null native id without inventing a collision` is the test
    // that kills it (CR-M-2).
    if (nativeId !== null) {
      const seen = nativeIdByIdentityKey.get(identityKey)
      if (seen !== undefined && seen !== nativeId) {
        // The offending item was already counted in `raw`, so it needs a disposition or the
        // balance invariant refuses the whole batch — and an adapter invariant failure would then
        // surface as an unhandled throw instead of the FAILED batch the ACs ask for. It is
        // `invalid`: we could not observe it as a distinct record.
        counts.invalid += 1
        return {
          ok: false,
          counts,
          failure: {
            code: 'ADAPTER_INVARIANT',
            message: new AdapterIdentityCollisionError(identityKey, seen, nativeId).message,
          },
        }
      }
      nativeIdByIdentityKey.set(identityKey, nativeId)
    }

    // No de-duplication here on purpose. The store HAS a `duplicates` disposition and the
    // collector owns it; a provider that silently dropped a repeat would make its own `raw` count
    // unaccountable and hide a real re-listing from the collector.
    counts.normalized += 1
    observations.push(result.observation)
  }

  let nextCursor: string | null
  try {
    nextCursor = spec.nextCursor(envelope, at)
  } catch (error) {
    return {
      ok: false,
      counts,
      failure: {
        code: 'PARSE_DRIFT',
        message: error instanceof Error ? error.message : 'the next cursor could not be read',
      },
    }
  }

  return { ok: true, observations, nextCursor, counts }
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/**
 * Turn a spec into a `ReportingJobSourceProvider`.
 *
 * This wrapper would fail the deletion test as a pass-through — except for what it makes
 * IMPOSSIBLE: there is no slot in which an adapter supplies `collectReport`, so the bounded loop,
 * the reserve-before-I/O ordering and the derived outcome cannot be replaced by one of 25 adapter
 * authors. That is behaviour, not indirection.
 */
export function defineApiJsonProvider<TConfig extends SourceConfigFields, TEnvelope, TItem>(
  spec: ApiJsonSourceSpec<TConfig, TEnvelope, TItem>,
): ReportingJobSourceProvider<Validated<TConfig>> {
  return {
    type: spec.type,
    parseConfig(raw: unknown) {
      return markValidated(spec.configSchema.parse(raw))
    },
    async collectReport(config, ctx) {
      // A config that `parseConfig` never saw has not been validated, whatever its shape.
      assertValidatedConfig(config)
      return collectJsonPages(spec, config, ctx)
    },
  }
}
