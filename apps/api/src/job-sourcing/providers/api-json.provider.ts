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
  decideCheckpoint,
  type FetchRequest,
  type InvalidSample,
  markValidated,
  MAX_SAMPLES,
  type MeterReservation,
  type ReportingJobSourceProvider,
  type RequestReport,
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

/** The ceiling of the store's `intColumnPositiveSchema` — a PostgreSQL `integer` column. */
export const PG_INT_MAX = 2_147_483_647

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

/** Where the loop is in the provider's pagination. `page` is 1-based and about to be fetched. */
export interface PageCursor {
  page: number
  cursor: string | null
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
  pageRequest(config: TConfig, at: PageCursor): PageRequest
  extractItems(envelope: TEnvelope, config: TConfig): readonly unknown[]
  /** The cursor for the NEXT page, or `null` when the provider's inventory is exhausted. */
  nextCursor(envelope: TEnvelope, at: PageCursor): string | null
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

/** HTTP status -> our typed code. Classified from the STATUS, never from the body text. */
function classifyStatus(status: number): CollectionErrorCode | null {
  if (status >= 200 && status < 300) return null
  if (status === 304) return null
  if (status === 401 || status === 403) return 'ACCESS_POLICY'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'UPSTREAM'
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
  let at: PageCursor = { page: 1, cursor: null }
  let checkpoint: ValidatedCheckpoint | null = null

  if (decision.kind === 'RESUME') {
    at = { page: decision.from.page + 1, cursor: decision.from.cursor }
    checkpoint = decision.from
  } else if (decision.kind === 'RESTART_WITH_OVERLAP') {
    // The cursor belonged to a config / policy / adapter that no longer exists, so discovery
    // starts over — and over a WIDER window, because whatever moved across the old boundary while
    // the config changed would otherwise never be read again.
    scope = widenScope(scope, overlapMs)
  }

  const observations: SourceObservation[] = []
  const requests: RequestReport[] = []
  const samples: InvalidSample[] = []
  const counts: CollectionCounts = { raw: 0, normalized: 0, invalid: 0, quarantined: 0 }
  const seenCursors = new Set<string>(at.cursor === null ? [] : [at.cursor])
  const nativeIdByIdentityKey = new Map<string, string>()

  let pagesCompleted = 0
  let stop: StopReason = 'EXHAUSTED'

  const addSample = (page: number, reason: string, raw: unknown): void => {
    if (samples.length >= MAX_SAMPLES) return
    samples.push(buildInvalidSample(page, reason, raw, ctx.secrets))
  }

  while (true) {
    if (at.page > limits.maxPages) {
      stop = 'PAGE_CAP'
      break
    }

    const startedAt = ctx.now()
    const pageRequest = spec.pageRequest(config, at)

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

    const cached =
      pageRequest.cacheKey === undefined ? null : await ctx.cache.get(pageRequest.cacheKey)
    const request: FetchRequest =
      cached === null
        ? pageRequest.request
        : {
            ...pageRequest.request,
            headers: { ...pageRequest.request.headers, 'if-none-match': cached.etag },
          }

    /**
     * Stryker disable next-line StringLiteral: the failure paths below deliberately do NOT assign
     * this, because `failure !== null` short-circuits before anything parses the body — so no
     * test can observe what it holds on those paths. Declared once here instead of three times,
     * which is also why there is one mutant to explain rather than four.
     */
    let bodyText = ''
    let status: number
    let failure: PageAttemptFailure | null = null

    try {
      const response = await ctx.fetchText(request)
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
          await ctx.cache.put(pageRequest.cacheKey, { etag: response.etag, bodyText })
        }
      }
    } catch (error) {
      // No response arrived. The reservation is UNCERTAIN, not RELEASED: a timeout may already
      // have been billed, and claiming otherwise would understate what we owe.
      status = 0
      failure = {
        code: ctx.signal.aborted ? 'CANCELLED' : 'TRANSIENT_NETWORK',
        message: error instanceof Error ? error.message : 'the request failed',
        status: null,
      }
      if (reservation !== null) await ctx.meter.reconcile(reservation, 'UNCERTAIN')
      reservation = null
    }

    if (reservation !== null) {
      await ctx.meter.reconcile(reservation, 'USED')
      reservation = null
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
            counts,
            nativeIdByIdentityKey,
            addSample,
            limits,
          )
          if (!pageResult.ok) {
            failure = { ...pageResult.failure, status }
          } else {
            const next: ValidatedCheckpoint = {
              configVersion: config.configVersion,
              policyVersion: ctx.policyVersion,
              adapterVersion: spec.adapterVersion,
              cursor: pageResult.nextCursor,
              page: at.page,
              completedAt: ctx.now(),
            }
            try {
              // Observations AND checkpoint, together, before the loop may continue.
              await ctx.checkpoints.savePage({
                observations: pageResult.observations,
                checkpoint: next,
              })
              observations.push(...pageResult.observations)
              checkpoint = next
              pagesCompleted += 1
            } catch (error) {
              // OUR failure, not the provider's: it is PERSISTENCE and it never touches
              // `counts.invalid` (AC3). The page is not counted as completed, so the checkpoint
              // still names the last page that really landed.
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
              const nextCursor = pageResult.nextCursor
              if (nextCursor === null) {
                stop = 'EXHAUSTED'
                break
              }
              if (seenCursors.has(nextCursor)) {
                stop = 'CURSOR_CYCLE'
                break
              }
              seenCursors.add(nextCursor)
              at = { page: at.page + 1, cursor: nextCursor }
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
    facts: { stop, pagesCompleted, counts, scope },
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
  | { ok: true; observations: SourceObservation[]; nextCursor: string | null }
  | { ok: false; failure: { code: CollectionErrorCode; message: string } }

/**
 * Validate and observe one page's items. Mutates `counts` and the identity map, which is why it is
 * private: the balance invariant `raw === normalized + invalid + quarantined` is only true across
 * the whole page, and exposing a half-applied count would be exposing an internal seam.
 */
async function observePage<TConfig extends SourceConfigFields, TEnvelope, TItem>(
  spec: ApiJsonSourceSpec<TConfig, TEnvelope, TItem>,
  config: TConfig,
  ctx: CollectionContext,
  envelope: TEnvelope,
  at: PageCursor,
  counts: CollectionCounts,
  nativeIdByIdentityKey: Map<string, string>,
  addSample: (page: number, reason: string, raw: unknown) => void,
  limits: ApiJsonLimits,
): Promise<PageResult> {
  let items: readonly unknown[]
  try {
    items = spec.extractItems(envelope, config)
  } catch (error) {
    return {
      ok: false,
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
      failure: {
        code: 'PARSE_DRIFT',
        message: error instanceof Error ? error.message : 'the next cursor could not be read',
      },
    }
  }

  return { ok: true, observations, nextCursor }
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
