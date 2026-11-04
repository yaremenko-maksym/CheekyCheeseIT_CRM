import { setTimeout as wait } from 'node:timers/promises'
import type { z } from 'zod'
import type { InferenceErrorCode } from '../contracts/errors'
import type { ExtractionPort, ExtractionRequest, ExtractionResult } from '../contracts/extraction'
import type { FetchLike } from '../http/bounded-request'
import {
  sendClassifiedChat,
  type ClassifiedChatCode,
  type ClassifiedChatOutcome,
  type StructuredOutput,
} from '../internal/classified-chat'
import { runExtraction } from '../internal/extraction-pipeline'
import { createStrictSchema, type JsonSchema } from '../internal/strict-schema'
import {
  HOSTED_BASE_URLS,
  localRuntimeKey,
  routerConfigSchema,
  type HostedProvider,
  type HostedRouteConfig,
  type LocalRouteConfig,
  type RouterConfig,
  type RouterProvider,
} from './config'
import { promptFits } from './fit'
import { pinnedModelsOnly, type ManagedModels } from './managed-models'
import {
  isProviderBlocked,
  isRetired,
  isSpent,
  markAuth,
  markCredit,
  markRetired,
  markSpent,
  providerDay,
  providerRecord,
  type OwnCapPort,
  type OwnCapUnit,
  type RouteStatePort,
} from './state'

/** One short backoff on a busy model, at most once per model per call (VCF Gemini: 9 s). */
export const BUSY_BACKOFF_MS = 9_000

/** Why an attempt ended: a leaf code, or a stop decided before any request was sent. */
export type AttemptCode = ClassifiedChatCode | 'PROMPT_TOO_LARGE' | 'CAP' | 'BUDGET'
/** Why a hosted route was not tried at all. */
export type SkipCode = 'AUTH' | 'CREDIT' | 'FIT' | 'NO_MODEL'

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
  | {
      type: 'FELL_TO_LOCAL'
      plan: 'full-then-small' | 'small'
      reasons: { route: HostedProvider; code: AttemptCode | SkipCode }[]
    }
  | {
      type: 'CALL'
      code: 'OK' | InferenceErrorCode | 'ABORTED'
      floorAnswered: boolean
      latencyMs: number
    }

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

type Step = { ok: true; text: string } | { ok: false; code: AttemptCode; retryAfterMs?: number }

/**
 * Whether the request's own-cap unit is given back (§5.1 unit table). An abort gives it back only
 * when nothing was sent: one cancelled in flight is a `TIMEOUT` to the provider, which may have
 * counted it, and `TIMEOUT` is committed.
 */
function releasesUnit({ result: r, sent }: ClassifiedChatOutcome): boolean {
  if (r.ok) return false
  if (r.code === 'TRANSPORT') return !r.responded
  if (r.code === 'ABORTED') return !sent
  return r.code === 'AUTH' || r.code === 'CREDIT' || r.code === 'RETIRED'
}

/**
 * One local request in flight per runtime across every router in the process (§5.5 item 5): two
 * adapters, or a later preflight going through a router, queue behind each other.
 */
const localTails = new Map<string, Promise<void>>()

/** The number of runtimes with queued local work; empty once every request settled (tests). */
export function pendingLocalQueues(): number {
  return localTails.size
}

function serialLocal<R>(runtime: string, fn: () => Promise<R>): Promise<R> {
  const run = (localTails.get(runtime) ?? Promise.resolve()).then(fn)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  localTails.set(runtime, tail)
  void tail.then(() => {
    if (localTails.get(runtime) === tail) localTails.delete(runtime)
  })
  return run
}

/** Leaving a route: these codes concern the provider or this input, not one model (§5.1). */
const NEXT_ROUTE = new Set<AttemptCode>([
  'AUTH',
  'CREDIT',
  'REFUSED',
  'TIMEOUT',
  'TRANSPORT',
  'CAP',
  'BUDGET',
])

/** The floor's public code (§5.2 item 6, §5.1 `PROMPT_TOO_LARGE`). */
function floorCode(code: AttemptCode): InferenceErrorCode | 'ABORTED' {
  if (code === 'ABORTED' || code === 'TIMEOUT' || code === 'INVALID_OUTPUT') return code
  return code === 'PROMPT_TOO_LARGE' ? 'INVALID_OUTPUT' : 'PROVIDER_ERROR'
}

const refused: Router = { run: async () => ({ ok: false, code: 'NOT_CONFIGURED' }) }

/**
 * The router core (ADR §2.1, §5.2): fit filter → rotation → hosted cascade → hand-back → local
 * floor, under a hosted budget and a floor budget. Never throws. A refused config, a missing
 * `onEvent` or a hosted route without an `OwnCapPort` builds a router that answers
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
  const hostedRoutes = cfg.routes.filter((r): r is HostedRouteConfig => r.provider !== 'local')
  if (hostedRoutes.length > 0 && deps.ownCap === undefined) return refuse()
  const local = cfg.routes.at(-1) as LocalRouteConfig
  const ownCap = deps.ownCap as OwnCapPort
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? abortableSleep
  const managedModels = deps.managedModels ?? pinnedModelsOnly
  const state = deps.routeState

  // Process memory (§3.1): rotation, minimum gaps, busy cool-downs, loud-once.
  let rotation = 0
  const nextFreeAt = new Map<HostedProvider, number>()
  const coolUntil = new Map<string, { p: HostedProvider; until: number; day: string }>()
  const announced = new Set<string>()
  const runtime = localRuntimeKey(local.baseUrl)

  const coolKey = (p: HostedProvider, model: string): string => `${p}\u0000${model}`
  /** The map holds only live cool-downs (SR-L-70); one never outlives the provider's reset (§5.1). */
  const coolingDown = (p: HostedProvider, model: string): boolean => {
    for (const [key, c] of coolUntil) {
      if (now() >= c.until || c.day !== providerDay(c.p, now())) coolUntil.delete(key)
    }
    return coolUntil.has(coolKey(p, model))
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
    let rendered: { jsonSchema: JsonSchema; replySchema: z.ZodType<T> } | null
    try {
      rendered = createStrictSchema(req.schema)
    } catch {
      rendered = null // a schema JSON Schema cannot express: routes fall back to json_object
    }
    const schema = rendered?.replySchema ?? req.schema
    const structured = (mode: HostedRouteConfig['structuredOutput']): StructuredOutput =>
      mode === 'json_schema'
        ? rendered === null
          ? { mode: 'json_object' }
          : { mode: 'json_schema', schema: rendered.jsonSchema }
        : { mode }
    let totalTokens: number | undefined
    const addTokens = (n: number | undefined): void => {
      if (n !== undefined) totalTokens = (totalTokens ?? 0) + n
    }
    const finish = (result: RouterResult<T>, floorAnswered: boolean): RouterResult<T> => {
      emit({
        type: 'CALL',
        code: result.ok ? 'OK' : result.code,
        floorAnswered,
        latencyMs: now() - start,
      })
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
      if (r.code === 'SPENT_DAY')
        writes.push(state.update(markSpent(p, model, providerDay(p, now()))))
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
        baseUrl: HOSTED_BASE_URLS[p],
        model,
        apiKey: route.apiKey,
        instruction: req.instruction,
        input: req.input,
        correction,
        maxTokens: route.maxAnswerTokens,
        structuredOutput: structured(route.structuredOutput),
        timeoutMs: Math.max(1, Math.min(route.timeoutMs, hostedDeadline - now())),
        signal,
        fetchImpl: deps.fetchImpl,
      })
      await withinBudget(settle(route, model, outcome, unit))
      const r = outcome.result
      attempted(p, model, r.code, t0, outcome)
      if (!r.ok) return r
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
          const pause = r.retryAfterMs ?? BUSY_BACKOFF_MS
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
    const reasons: { route: HostedProvider; code: AttemptCode | SkipCode }[] = []
    const candidates: { route: HostedRouteConfig; models: string[] }[] = []
    for (const route of hostedRoutes) {
      const p = route.provider
      const snap = state.snapshot()
      const today = providerDay(p, now())
      if (isProviderBlocked(snap, p, today)) {
        const code = providerRecord(snap, p).auth ? 'AUTH' : 'CREDIT'
        disable(p, code)
        reasons.push({ route: p, code })
        continue
      }
      if (!promptFits(route, req.instruction, inputChars)) {
        reasons.push({ route: p, code: 'FIT' })
        continue
      }
      const models = (await managedModels(p, route.models)).filter(
        (m) => !isSpent(snap, p, m, today) && !isRetired(snap, p, m) && !coolingDown(p, m),
      )
      if (models.length === 0) reasons.push({ route: p, code: 'NO_MODEL' })
      else candidates.push({ route, models })
    }

    // ---- rotation (§5.2 item 3) ----
    const rotatable = candidates.filter((c) => c.route.rotate)
    // No rotatable candidate: the index is NaN and `first` is undefined.
    const first = rotatable[rotation++ % rotatable.length]
    const order =
      first === undefined ? candidates : [first, ...candidates.filter((c) => c !== first)]

    // ---- hosted cascade ----
    for (const { route, models } of order) {
      for (const model of models) {
        const r = await tryModel(route, model)
        if (r.ok) return finish(success(r.data), false)
        if (r.code === 'ABORTED') return finish(r as RouterResult<T>, false)
        reasons.push({ route: route.provider, code: r.code })
        if (NEXT_ROUTE.has(r.code)) break
      }
    }

    // ---- hand-back and floor (§5.2 items 5-6) ----
    // An abort during a step that sends nothing (a cap refusal, a state write) ends here, not on the floor.
    if (signal?.aborted === true) return finish({ ok: false, code: 'ABORTED' }, false)
    // Every fall is an event, a local-only config included: the consumer counts floor falls (§5.3).
    emit({
      type: 'FELL_TO_LOCAL',
      plan: candidates.length > 0 ? 'full-then-small' : 'small',
      reasons,
    })
    const floorDeadline = now() + cfg.floorBudgetMs
    const floor = await runExtraction({
      schema,
      call: async (correction?: string): Promise<Step> => {
        if (!promptFits(local, req.instruction, inputChars)) {
          attempted('local', local.model, 'PROMPT_TOO_LARGE', now())
          return { ok: false, code: 'PROMPT_TOO_LARGE' }
        }
        // An abort while queued is refused by `boundedRequest` before any fetch, as on hosted routes.
        return serialLocal(runtime, async (): Promise<Step> => {
          const remaining = floorDeadline - now()
          if (remaining <= 0) return { ok: false, code: 'TIMEOUT' }
          const t0 = now()
          const outcome = await sendClassifiedChat({
            provider: 'local',
            baseUrl: local.baseUrl,
            model: local.model,
            apiKey: local.apiKey,
            instruction: req.instruction,
            input: req.input,
            correction,
            maxTokens: local.maxAnswerTokens,
            structuredOutput: structured(local.structuredOutput),
            timeoutMs: Math.min(local.timeoutMs, remaining),
            signal,
            fetchImpl: deps.fetchImpl,
          })
          const r = outcome.result
          attempted('local', local.model, r.code, t0, outcome)
          if (!r.ok) return r
          addTokens(r.totalTokens)
          return { ok: true, text: r.text }
        })
      },
    })
    if (floor.ok) return finish(success(floor.data), true)
    return finish({ ok: false, code: floorCode(floor.code) } as RouterResult<T>, false)
  }

  return {
    // A throwing port adapter (a custom state or cap store) must not escape: the router never throws.
    run: (req, signal) =>
      run(req, signal).catch(() => {
        emit({ type: 'CALL', code: 'PROVIDER_ERROR', floorAnswered: false, latencyMs: 0 })
        return { ok: false, code: 'PROVIDER_ERROR' }
      }),
  }
}

/**
 * The `router` extraction provider: an `ExtractionPort` over `createRouter` (ADR §2.1). The public
 * result type is unchanged; internal codes never leave the package. The port passes no signal
 * (5.4c-6 adds it to `ExtractionRequest`), so `ABORTED` cannot occur here.
 */
export function createRouterExtractionAdapter(config: unknown, deps: RouterDeps): ExtractionPort {
  const router = createRouter(config, deps)
  return {
    extract<T>(req: ExtractionRequest<T>): Promise<ExtractionResult<T>> {
      return router.run(req) as Promise<ExtractionResult<T>>
    },
  }
}
