import { setTimeout as wait } from 'node:timers/promises'
import type { InferenceErrorCode } from '../contracts/errors'
import {
  MAX_IMAGE_REQUEST_CHARS,
  type ExtractionPort,
  type ExtractionRequest,
  type ExtractionResult,
} from '../contracts/extraction'
import type { FetchLike } from '../http/bounded-request'
import {
  CLASSIFIED_CHAT_CODES,
  sendClassifiedChat,
  type ClassifiedChatOutcome,
} from '../internal/classified-chat'
import { runExtraction } from '../internal/extraction-pipeline'
import { isVisionCapable } from '../internal/model-id'
import {
  hostedBaseUrl,
  routerConfigSchema,
  type HostedProvider,
  type HostedRouteConfig,
  type RouterConfig,
  type RouterProvider,
} from './config'
import { promptFits } from './fit'
import { pinnedModelsOnly, type ManagedModels } from './managed-models'
import { routeChatFields } from './openrouter'
import { allLimitBlocked, type RouteEnd } from './readiness'
import {
  isRetired,
  isSpent,
  ownCapRemaining,
  markAuth,
  markCredit,
  markFlagRejected,
  markProviderSpent,
  markRetired,
  markSpent,
  providerBlock,
  providerDay,
  type OwnCapPort,
  type OwnCapUnit,
  type RouteStatePort,
} from './state'
import { renderSchema, structuredOutputFor } from './structured-output'

/** One short backoff on a busy model, at most once per model per call (VCF Gemini: 9 s). */
export const BUSY_BACKOFF_MS = 9_000
/**
 * The shortest pause after a busy answer, whatever `retry-after` says (a Groq `0` meant two requests
 * 15 ms apart). At or below `BUSY_BACKOFF_MS`, so the one in-call wait still happens.
 */
export const MIN_BUSY_BACKOFF_MS = 3_000
/**
 * Requests of the sole vision route's own day a text call leaves to image calls: only that route can
 * read pages, so text calls stop taking it at this many requests left.
 */
export const VISION_RESERVE_REQUESTS = 10

/** Why an attempt ended: a leaf code, or a stop decided before any request was sent. */
export const ATTEMPT_CODES = [...CLASSIFIED_CHAT_CODES, 'CAP', 'BUDGET'] as const
export type AttemptCode = (typeof ATTEMPT_CODES)[number]
/**
 * Why a hosted route was not tried at all. A route whose every model is spent for the day skips with
 * `SPENT_DAY`, the attempt code of the same cause (H.2).
 */
export type SkipCode = 'AUTH' | 'CREDIT' | 'FLAG_REJECTED' | 'FIT' | 'NO_MODEL'
/** One route's reason in an `EXHAUSTED` event: route and internal code, never text (H.2). */
export type ExhaustedReason = { route: HostedProvider; code: AttemptCode | SkipCode }

/**
 * Events carry route, model, internal code, counts and timings only (ADR §4 item 2, §6.2): never
 * a key, a header, the input, the instruction, a model reply or a provider body.
 */
export type RouterEvent =
  | { type: 'CONFIG_REFUSED' }
  | {
      type: 'ATTEMPT'
      route: RouterProvider
      model: string
      code: AttemptCode
      inputChars: number
      latencyMs: number
      /** The HTTP status, when a response arrived (§6.2). */
      status?: number
      /** The provider's own token count, the only cost the free tiers report (§6.2). */
      totalTokens?: number
    }
  | { type: 'RETIRED'; route: HostedProvider; model: string; servedModel?: string }
  | { type: 'PROVIDER_DISABLED'; route: HostedProvider; code: 'AUTH' | 'CREDIT' }
  /** No hosted route answered (H.2): every reason a route was skipped or left, in order. */
  | { type: 'EXHAUSTED'; reasons: ExhaustedReason[] }
  | { type: 'CALL'; code: 'OK' | InferenceErrorCode | 'ABORTED'; latencyMs: number }

export type RouterDeps = {
  /** Mandatory (ADR §5.3): the router has no "no events" mode. */
  onEvent: (e: RouterEvent) => void
  routeState: RouteStatePort
  /** Required whenever a hosted route is configured: an uncapped hosted route cannot be built. */
  ownCap?: OwnCapPort
  managedModels?: ManagedModels
  fetchImpl?: FetchLike
  now?: () => number
  /** Resolves after `ms` or as soon as `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** The router's own result: the public one, or an abort, which cascades nowhere (§5.5 item 3). */
export type RouterResult<T> = ExtractionResult<T> | { ok: false; code: 'ABORTED' }

export type Router = {
  run<T>(req: ExtractionRequest<T>, signal?: AbortSignal): Promise<RouterResult<T>>
}

/** Resolves after `ms`, or at once when `signal` aborts (the platform timer rejects; that is a wake-up). */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return wait(ms, undefined, { signal } as { signal: AbortSignal }).then(
    () => undefined,
    () => undefined,
  )
}

type Step =
  | { ok: true; text: string }
  | { ok: false; code: AttemptCode; retryAfterMs?: number; status?: number }

/**
 * Whether the request's own-cap unit is given back (§5.1 unit table). An abort gives it back only
 * when nothing was sent: one cancelled in flight is a `TIMEOUT` to the provider, which may have
 * counted it, and `TIMEOUT` is committed.
 */
export function releasesUnit({ result: r, sent }: ClassifiedChatOutcome): boolean {
  if (r.ok) return false
  if (r.code === 'TRANSPORT') return !r.responded
  if (r.code === 'ABORTED') return !sent
  return (
    r.code === 'AUTH' || r.code === 'CREDIT' || r.code === 'FLAG_REJECTED' || r.code === 'RETIRED'
  )
}

/** Leaving a route: these codes concern the provider or this input, not one model (§5.1). */
const NEXT_ROUTE = new Set<AttemptCode>([
  'AUTH',
  'CREDIT',
  'FLAG_REJECTED',
  'REFUSED',
  'TIMEOUT',
  'TRANSPORT',
  'CAP',
  'BUDGET',
])

/**
 * Parameter count in billions read from a model id (R15): `70b` 70, `1.5b` 1.5, `8x7b` 56; in
 * `30b-a3b` the active count has a letter before it, so the total wins. No size token: undefined.
 */
export function modelSizeB(id: string): number | undefined {
  const m = /(?:^|[^a-z0-9])(?:(\d+)x)?(\d+(?:\.\d+)?)b(?![a-z0-9])/.exec(id.toLowerCase())
  return m === null ? undefined : Number(m[2]) * Number(m[1] ?? 1)
}

/**
 * The code of a text call no hosted route answered and that is not `LIMITS_EXHAUSTED` (Amendment
 * 2026-11-08 H.2): `INVALID_OUTPUT` only when every attempt was an invalid answer, so the record
 * caused it; anything transient, a skip or a spent budget is `PROVIDER_ERROR`. The list is never
 * empty here: each configured route leaves a skip reason or at least one attempt.
 */
function cascadeCode(reasons: { code: AttemptCode | SkipCode }[]): InferenceErrorCode {
  return reasons.every((r) => r.code === 'INVALID_OUTPUT') ? 'INVALID_OUTPUT' : 'PROVIDER_ERROR'
}

/**
 * Providers whose free day is per account (§3.5): one `SPENT_DAY` leaves the route, and the route
 * ends limit-blocked whatever else it answered.
 */
const ACCOUNT_DAY: ReadonlySet<HostedProvider> = new Set(['openrouter'])

/**
 * Providers whose rate limit is per account (OpenRouter `:free`): a 429 cools every model. Gemini,
 * Groq and Cloudflare limit per model, so their 429 cools only the model (Master D1, 2026-11-23).
 */
const ACCOUNT_RATE: ReadonlySet<HostedProvider> = new Set(['openrouter'])

/** How a provider blocked by its persisted bits ends the call (H.2): only a limit is `LIMIT`. */
const BLOCK_END = {
  AUTH: 'UNAVAILABLE',
  CREDIT: 'LIMIT',
  SPENT_DAY: 'LIMIT',
  FLAG_REJECTED: 'OTHER',
} as const satisfies Record<string, RouteEnd>

/** Codes that settle a route's end in the call at once; each also leaves the route. */
const ROUTE_END_CODES: Partial<Record<AttemptCode, RouteEnd>> = {
  AUTH: 'UNAVAILABLE',
  CREDIT: 'LIMIT',
  CAP: 'LIMIT',
}

/**
 * A route's limit bookkeeping through one call (H.2, R1). A tried route that was left by no settled
 * end and no transient answer had every model it could try answer `SPENT_DAY`, so it is spent
 * through. A model cooling down, or one answering `RETIRED` in this call, is no spent model.
 */
type RouteTally = { end?: RouteEnd; transient: boolean }

function endOf(t: RouteTally): RouteEnd {
  return t.end ?? (t.transient ? 'OTHER' : 'LIMIT')
}

const refused: Router = { run: async () => ({ ok: false, code: 'NOT_CONFIGURED' }) }

/**
 * The router core (ADR §2.1, §5.2): fit filter → rotation → hosted cascade, under the hosted budget.
 * Hosted-only: the local floor is withdrawn (Amendment 2026-11-08, H.1). Never throws. A refused
 * config, a missing `onEvent` or a missing `OwnCapPort` builds a router that answers
 * `NOT_CONFIGURED` and sends nothing.
 */
export function createRouter(rawConfig: unknown, deps: RouterDeps): Router {
  if (typeof deps.onEvent !== 'function') return refused
  const emit = (e: RouterEvent): void => {
    try {
      deps.onEvent(e)
    } catch {
      // a throwing consumer must not break the call; the consumer's own test guards it (5.4c-3)
    }
  }
  const refuse = (): Router => {
    emit({ type: 'CONFIG_REFUSED' })
    return refused
  }
  let parsed: ReturnType<typeof routerConfigSchema.safeParse>
  try {
    parsed = routerConfigSchema.safeParse(rawConfig)
  } catch {
    return refuse() // a throwing refine must not carry the raw config out (SR-H-65)
  }
  if (!parsed.success) return refuse()
  const cfg: RouterConfig = parsed.data
  const hostedRoutes: HostedRouteConfig[] = cfg.routes
  // Every route is hosted, so an uncapped router cannot be built (D5).
  if (deps.ownCap === undefined) return refuse()
  const ownCap = deps.ownCap
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? abortableSleep
  const managedModels = deps.managedModels ?? pinnedModelsOnly
  const state = deps.routeState

  // Process memory (§3.1): rotation, minimum gaps, busy cool-downs, loud-once.
  let rotation = 0
  const nextFreeAt = new Map<HostedProvider, number>()
  const coolUntil = new Map<string, { p: HostedProvider; until: number; day: string }>()
  const announced = new Set<string>()
  // Only Gemini reads images and each provider appears once, so at most one route is a vision route.
  // Stryker disable next-line MethodExpression: equivalent, config admits only vision-capable Gemini ids
  const visionRoute = hostedRoutes.find((r) => r.models.some((m) => isVisionCapable(r.provider, m)))

  const coolKey = (p: HostedProvider, model: string): string => `${p}\u0000${model}`
  /** A model id is never empty, so the empty one stands for every model of the provider. */
  // Stryker disable next-line StringLiteral: equivalent, any value no model id takes works the same
  const ALL_MODELS = ''
  /** The map holds only live cool-downs (SR-L-70); one never outlives the provider's reset (§5.1). */
  const coolingDown = (p: HostedProvider, model: string): boolean => {
    for (const [key, c] of coolUntil) {
      if (now() >= c.until || c.day !== providerDay(c.p, now())) coolUntil.delete(key)
    }
    return coolUntil.has(coolKey(p, model)) || coolUntil.has(coolKey(p, ALL_MODELS))
  }
  const coolDown = (p: HostedProvider, model: string, ms: number): void => {
    coolUntil.set(coolKey(p, model), { p, until: now() + ms, day: providerDay(p, now()) })
  }
  const disable = (p: HostedProvider, code: 'AUTH' | 'CREDIT'): void => {
    if (announced.has(`${p}:${code}`)) return
    announced.add(`${p}:${code}`)
    emit({ type: 'PROVIDER_DISABLED', route: p, code })
  }

  async function run<T>(req: ExtractionRequest<T>, signal?: AbortSignal): Promise<RouterResult<T>> {
    const start = now()
    const hostedDeadline = start + cfg.hostedBudgetMs
    const inputChars = req.input.length
    const images = req.images
    const rendered = renderSchema(req.schema)
    const schema = rendered?.replySchema ?? req.schema
    let totalTokens: number | undefined
    const addTokens = (n: number | undefined): void => {
      if (n !== undefined) totalTokens = (totalTokens ?? 0) + n
    }
    const finish = (result: RouterResult<T>): RouterResult<T> => {
      emit({ type: 'CALL', code: result.ok ? 'OK' : result.code, latencyMs: now() - start })
      return result
    }
    const success = (data: T): RouterResult<T> => ({
      ok: true,
      data,
      ...(totalTokens !== undefined && { usage: { totalTokens } }),
    })
    const attempted = (
      route: RouterProvider,
      model: string,
      code: AttemptCode,
      t0: number,
      outcome?: ClassifiedChatOutcome,
    ): void => {
      const tokens = outcome?.result.ok === true ? outcome.result.totalTokens : undefined
      emit({
        type: 'ATTEMPT',
        route,
        model,
        code,
        inputChars,
        latencyMs: now() - t0,
        ...(outcome?.status !== undefined && { status: outcome.status }),
        ...(tokens !== undefined && { totalTokens: tokens }),
      })
    }

    // Images are checked here too, not only by the caller: at least one, strict base64, inside the
    // request cap. An empty list is no vision request.
    if (
      images !== undefined &&
      (images.length === 0 ||
        images.some((b64) => b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) ||
        images.reduce((n, b64) => n + b64.length, 0) > MAX_IMAGE_REQUEST_CHARS)
    ) {
      return finish({ ok: false, code: 'PROVIDER_ERROR' })
    }

    /**
     * Waits for port writes no longer than the hosted budget (SR-L-70). Every port applies its change
     * to memory before it writes, so a slow store delays nothing but its own durability. Residual
     * window, accepted to keep the ceiling: a write still pending when the process exits is lost, so
     * the own cap restarts low by that much; the provider's own limit (`SPENT_DAY`) is the backstop.
     */
    async function withinBudget<R>(work: Promise<R>): Promise<R | undefined> {
      const stop = new AbortController()
      const timer = wait(Math.max(0, hostedDeadline - now()), undefined, {
        signal: stop.signal,
      }).then(
        () => undefined,
        () => undefined,
      )
      try {
        return await Promise.race([work, timer])
      } finally {
        stop.abort()
      }
    }

    /**
     * Applies the persisted and in-memory effects of one hosted answer (§5.1 router action and
     * ledger). Every change is started at once, so each reaches memory before any write is awaited.
     */
    function settle(
      route: HostedRouteConfig,
      model: string,
      outcome: ClassifiedChatOutcome,
      unit: OwnCapUnit,
    ): Promise<unknown> {
      const p = route.provider
      const r = outcome.result
      // Stryker disable next-line ArrayDeclaration: equivalent mutant, `Promise.all` ignores the values
      const writes: Promise<unknown>[] = []
      if (r.ok && r.totalTokens !== undefined) writes.push(ownCap.addTokens(p, r.totalTokens))
      if (releasesUnit(outcome)) writes.push(ownCap.release(p, unit))
      if (r.code === 'SPENT_DAY') {
        writes.push(state.update(markSpent(p, model, providerDay(p, now()))))
        if (ACCOUNT_DAY.has(p))
          writes.push(state.update(markProviderSpent(p, providerDay(p, now()))))
      }
      if (r.code === 'FLAG_REJECTED') writes.push(state.update(markFlagRejected(p, model)))
      if (r.code === 'RETIRED') {
        writes.push(state.update(markRetired(p, model, now())))
        emit({ type: 'RETIRED', route: p, model, ...(r.ok && { servedModel: r.servedModel }) })
      }
      if (r.code === 'AUTH') {
        writes.push(state.update(markAuth(p)))
        disable(p, 'AUTH')
      }
      if (r.code === 'CREDIT') {
        writes.push(state.update(markCredit(p, providerDay(p, now()))))
        disable(p, 'CREDIT')
      }
      return Promise.all(writes)
    }

    /** One hosted HTTP request (§5.2 item 4): budget, own-cap unit, minimum gap, send, classify. */
    async function sendHosted(
      route: HostedRouteConfig,
      model: string,
      correction?: string,
    ): Promise<Step> {
      const p = route.provider
      if (now() >= hostedDeadline) return { ok: false, code: 'BUDGET' }
      const unit = await withinBudget(ownCap.reserve(p, route.freeLimit))
      if (unit === undefined) return { ok: false, code: 'BUDGET' } // a store slower than the budget
      if (unit === null) return { ok: false, code: 'CAP' }
      // A failed state write is a fault, not a limit (R2): transient, and dead-route evidence.
      if (unit === 'WRITE_FAILED') return { ok: false, code: 'BUDGET' }
      // The gap slot is claimed before any wait, so overlapping calls are spaced too (CR-M-3).
      const slot = Math.max(now(), nextFreeAt.get(p) ?? 0)
      if (slot >= hostedDeadline) {
        await withinBudget(ownCap.release(p, unit))
        return { ok: false, code: 'BUDGET' }
      }
      nextFreeAt.set(p, slot + route.minGapMs)
      if (slot > now()) await sleep(slot - now(), signal)
      // An aborted signal never reaches the network: the leaf refuses it before fetching and reports
      // it as not sent, so `settle` gives the unit back.
      const t0 = now()
      const outcome = await sendClassifiedChat({
        provider: p,
        baseUrl: hostedBaseUrl(route),
        model,
        apiKey: route.apiKey,
        instruction: req.instruction,
        input: req.input,
        correction,
        images: req.images,
        maxTokens: route.maxAnswerTokens,
        structuredOutput: structuredOutputFor(rendered, route.structuredOutput),
        timeoutMs: Math.max(1, Math.min(route.timeoutMs, hostedDeadline - now())),
        signal,
        fetchImpl: deps.fetchImpl,
        ...routeChatFields(route),
      })
      await withinBudget(settle(route, model, outcome, unit))
      const r = outcome.result
      attempted(p, model, r.code, t0, outcome)
      // The caller cools every model of an account-wide limit on a 429 (finding 3).
      if (!r.ok) return outcome.status === 429 ? { ...r, status: 429 } : r
      addTokens(r.totalTokens)
      return { ok: true, text: r.text }
    }

    /** One model of a hosted route: one structured extraction, one BUSY wait at most (§5.1 `BUSY`). */
    async function tryModel(
      route: HostedRouteConfig,
      model: string,
    ): Promise<{ ok: true; data: T } | { ok: false; code: AttemptCode }> {
      const p = route.provider
      let waited = false
      const call = async (correction?: string): Promise<Step> => {
        for (;;) {
          const r = await sendHosted(route, model, correction)
          if (r.ok || r.code !== 'BUSY') return r
          const pause = Math.max(MIN_BUSY_BACKOFF_MS, r.retryAfterMs ?? BUSY_BACKOFF_MS)
          // Set before the wait, so an overlapping call does not hit the same provider meanwhile.
          if (r.status === 429 && ACCOUNT_RATE.has(p)) coolDown(p, ALL_MODELS, pause)
          if (!waited && pause <= BUSY_BACKOFF_MS && now() + pause < hostedDeadline) {
            waited = true
            await sleep(pause, signal)
            continue
          }
          coolDown(p, model, pause)
          return r
        }
      }
      return runExtraction({ schema, call })
    }

    // ---- candidates (§5.2 item 2) ----
    const reasons: ExhaustedReason[] = []
    const tallies = new Map<HostedRouteConfig, RouteTally>()
    const skip = (
      route: HostedRouteConfig,
      code: SkipCode | 'SPENT_DAY' | 'CAP',
      end: RouteEnd,
    ): void => {
      reasons.push({ route: route.provider, code })
      tallies.set(route, { end, transient: false })
    }
    const candidates: { route: HostedRouteConfig; models: string[] }[] = []
    for (const route of hostedRoutes) {
      const p = route.provider
      const snap = state.snapshot()
      const today = providerDay(p, now())
      const block = providerBlock(snap, p, today)
      if (block !== null) {
        if (block === 'AUTH' || block === 'CREDIT') disable(p, block)
        skip(route, block, BLOCK_END[block])
        continue
      }
      if (!promptFits(route, req.instruction, inputChars)) {
        skip(route, 'FIT', 'OTHER')
        continue
      }
      // The vision reserve: a text call leaves the sole vision route's last requests to image calls.
      if (
        images === undefined &&
        route === visionRoute &&
        ownCapRemaining(snap, p, route.freeLimit, today) <= VISION_RESERVE_REQUESTS
      ) {
        skip(route, 'CAP', 'LIMIT')
        continue
      }
      const fitting = (await managedModels(p, route.models)).filter(
        (m) => images === undefined || isVisionCapable(p, m),
      )
      // The models this call could try: a retired one is no longer one of them (A1).
      const tryable = fitting.filter((m) => !isRetired(snap, p, m))
      const unspent = tryable.filter((m) => !isSpent(snap, p, m, today))
      const models = unspent.filter((m) => !coolingDown(p, m))
      if (models.length > 0) {
        candidates.push({ route, models })
        tallies.set(route, { transient: models.length < unspent.length })
      } else if (unspent.length === 0 && tryable.length > 0) skip(route, 'SPENT_DAY', 'LIMIT')
      // Unavailable only when no model takes the images; a route retired through is transient (R1).
      else if (fitting.length === 0 && images !== undefined) skip(route, 'NO_MODEL', 'UNAVAILABLE')
      else skip(route, 'NO_MODEL', 'OTHER')
    }

    const pairsOf = (cs: typeof candidates) =>
      cs.flatMap(({ route, models }) => models.map((model) => ({ route, model })))
    let pairs: { route: HostedRouteConfig; model: string }[]
    if (req.modelPreference === 'largest') {
      // R15: largest first across routes, no rotation; a stable sort keeps ties in today's order.
      const size = (m: string) => modelSizeB(m) ?? 0
      pairs = pairsOf(candidates).sort((a, b) => size(b.model) - size(a.model))
    } else {
      // ---- rotation (§5.2 item 3) ----
      const rotatable = candidates.filter((c) => c.route.rotate)
      // No rotatable candidate: the index is NaN and `first` is undefined.
      // An image call reads the rotation but does not advance it: text calls keep their turn.
      const first = rotatable[(images === undefined ? rotation++ : rotation) % rotatable.length]
      pairs = pairsOf(
        first === undefined ? candidates : [first, ...candidates.filter((c) => c !== first)],
      )
    }

    // ---- hosted cascade ----
    const left = new Set<HostedRouteConfig>()
    for (const { route, model } of pairs) {
      // An account-wide 429 earlier in this call cools the provider: its other models wait too.
      if (left.has(route) || coolingDown(route.provider, model)) continue
      const r = await tryModel(route, model)
      if (r.ok) return finish(success(r.data))
      if (r.code === 'ABORTED') return finish(r as RouterResult<T>)
      reasons.push({ route: route.provider, code: r.code })
      const t = tallies.get(route)!
      const end = ROUTE_END_CODES[r.code]
      const accountSpent = r.code === 'SPENT_DAY' && ACCOUNT_DAY.has(route.provider)
      if (end !== undefined) t.end = end
      else if (accountSpent) t.end = 'LIMIT'
      else if (r.code !== 'SPENT_DAY') t.transient = true
      // An image call has one vision route: a timed-out model gives the next model its turn.
      const nextModel = r.code === 'TIMEOUT' && images !== undefined
      if ((NEXT_ROUTE.has(r.code) && !nextModel) || accountSpent) left.add(route)
    }

    // ---- the end of the cascade (H.2) ----
    // An abort during a step that sends nothing (a cap refusal, a state write) ends here.
    if (signal?.aborted === true) return finish({ ok: false, code: 'ABORTED' })
    emit({ type: 'EXHAUSTED', reasons })
    // Images never reach any model with the pages dropped. NOT_CONFIGURED only when no configured
    // route could ever take images; a blocked, spent or too-small vision route fails this call.
    if (images !== undefined && visionRoute === undefined) {
      return finish({ ok: false, code: 'NOT_CONFIGURED' })
    }
    if (allLimitBlocked([...tallies.values()].map(endOf))) {
      return finish({ ok: false, code: 'LIMITS_EXHAUSTED' })
    }
    return finish({
      ok: false,
      code: images !== undefined ? 'PROVIDER_ERROR' : cascadeCode(reasons),
    })
  }

  return {
    // A throwing port adapter (a custom state or cap store) must not escape: the router never throws.
    run: (req, signal) =>
      run(req, signal).catch(() => {
        emit({ type: 'CALL', code: 'PROVIDER_ERROR', latencyMs: 0 })
        return { ok: false, code: 'PROVIDER_ERROR' }
      }),
  }
}

/**
 * The `router` extraction provider: an `ExtractionPort` over `createRouter` (ADR §2.1). Internal codes
 * never leave the package: `ABORTED` leaves as `TIMEOUT`, the public code of a call that ran out, and
 * the caller that aborted has already stopped listening (§5.5 item 3).
 */
export function createRouterExtractionAdapter(config: unknown, deps: RouterDeps): ExtractionPort {
  const router = createRouter(config, deps)
  return {
    async extract<T>(req: ExtractionRequest<T>): Promise<ExtractionResult<T>> {
      const r = await router.run(req, req.signal)
      return r.ok || r.code !== 'ABORTED' ? r : { ok: false, code: 'TIMEOUT' }
    },
  }
}
