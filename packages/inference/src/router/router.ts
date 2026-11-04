import type { z } from 'zod'
import type { InferenceErrorCode } from '../contracts/errors'
import type { ExtractionPort, ExtractionRequest, ExtractionResult } from '../contracts/extraction'
import type { FetchLike } from '../http/bounded-request'
import {
  sendClassifiedChatCompletion,
  type ClassifiedChatCode,
  type ClassifiedChatResult,
  type StructuredOutput,
} from '../internal/classified-chat'
import { runExtraction } from '../internal/extraction-pipeline'
import { createStrictSchema, type JsonSchema } from '../internal/strict-schema'
import {
  HOSTED_BASE_URLS,
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

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve()
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done)
  })
}

type Step = { ok: true; text: string } | { ok: false; code: AttemptCode }
type Leaf = Extract<ClassifiedChatResult, { ok: false }>

/** Codes after which the request's own-cap unit is given back (§5.1 unit table). */
function releasesUnit(r: Leaf): boolean {
  if (r.code === 'TRANSPORT') return !r.responded
  return r.code === 'AUTH' || r.code === 'CREDIT' || r.code === 'RETIRED' || r.code === 'ABORTED'
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
  const parsed = routerConfigSchema.safeParse(rawConfig)
  const hostedRoutes = parsed.success
    ? parsed.data.routes.filter((r): r is HostedRouteConfig => r.provider !== 'local')
    : []
  if (!parsed.success || (hostedRoutes.length > 0 && deps.ownCap === undefined)) {
    emit({ type: 'CONFIG_REFUSED' })
    return refused
  }
  const cfg: RouterConfig = parsed.data
  const local = cfg.routes.at(-1) as LocalRouteConfig
  const ownCap = deps.ownCap as OwnCapPort
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? abortableSleep
  const managedModels = deps.managedModels ?? pinnedModelsOnly
  const state = deps.routeState

  // Process memory (§3.1): rotation, minimum gaps, busy cool-downs, loud-once.
  let rotation = 0
  const nextFreeAt = new Map<HostedProvider, number>()
  const coolUntil = new Map<string, { until: number; day: string }>()
  const announced = new Set<string>()
  let localTail: Promise<unknown> = Promise.resolve()

  const coolKey = (p: HostedProvider, model: string): string => `${p}\u0000${model}`
  const coolingDown = (p: HostedProvider, model: string): boolean => {
    const c = coolUntil.get(coolKey(p, model))
    // A cool-down never outlives the provider's reset (§5.1 durations).
    return c !== undefined && c.day === providerDay(p, now()) && now() < c.until
  }
  const disable = (p: HostedProvider, code: 'AUTH' | 'CREDIT'): void => {
    if (announced.has(`${p}:${code}`)) return
    announced.add(`${p}:${code}`)
    emit({ type: 'PROVIDER_DISABLED', route: p, code })
  }

  /** One local request at a time, abandoned calls included (§5.5 item 5). */
  function serialLocal<R>(fn: () => Promise<R>): Promise<R> {
    const run = localTail.then(fn)
    localTail = run.catch(() => undefined)
    return run
  }

  async function run<T>(req: ExtractionRequest<T>, signal?: AbortSignal): Promise<RouterResult<T>> {
    const start = now()
    // A function, not a narrowed property: the signal can abort across every await below.
    const aborted = (): boolean => signal?.aborted === true
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
      tokens?: number,
    ): void =>
      emit({
        type: 'ATTEMPT',
        route,
        model,
        code,
        inputChars,
        latencyMs: now() - t0,
        ...(tokens !== undefined && { totalTokens: tokens }),
      })

    /** Applies the persisted and in-memory effects of one hosted answer (§5.1 router action and ledger). */
    async function settle(
      route: HostedRouteConfig,
      model: string,
      r: ClassifiedChatResult,
    ): Promise<void> {
      const p = route.provider
      if (r.ok) {
        if (r.totalTokens !== undefined) await ownCap.addTokens(p, r.totalTokens)
        if (r.code === 'RETIRED') {
          await state.update(markRetired(p, model, now()))
          emit({ type: 'RETIRED', route: p, model, servedModel: r.servedModel })
        }
        return
      }
      if (releasesUnit(r)) await ownCap.release(p)
      if (r.code === 'SPENT_DAY') await state.update(markSpent(p, model, providerDay(p, now())))
      if (r.code === 'RETIRED') {
        await state.update(markRetired(p, model, now()))
        emit({ type: 'RETIRED', route: p, model })
      }
      if (r.code === 'AUTH') {
        await state.update(markAuth(p))
        disable(p, 'AUTH')
      }
      if (r.code === 'CREDIT') {
        await state.update(markCredit(p, providerDay(p, now())))
        disable(p, 'CREDIT')
      }
    }

    /** One hosted HTTP request (§5.2 item 4): budget, own-cap unit, minimum gap, send, classify. */
    async function sendHosted(
      route: HostedRouteConfig,
      model: string,
      correction?: string,
    ): Promise<Step> {
      const p = route.provider
      if (aborted()) return { ok: false, code: 'ABORTED' }
      if (now() >= hostedDeadline) return { ok: false, code: 'BUDGET' }
      if (!(await ownCap.reserve(p))) return { ok: false, code: 'CAP' }
      const gap = (nextFreeAt.get(p) ?? 0) - now()
      if (gap > 0) {
        if (now() + gap >= hostedDeadline) {
          await ownCap.release(p)
          return { ok: false, code: 'BUDGET' }
        }
        await sleep(gap, signal)
        if (aborted()) {
          await ownCap.release(p)
          return { ok: false, code: 'ABORTED' }
        }
      }
      const t0 = now()
      const r = await sendClassifiedChatCompletion({
        provider: p,
        baseUrl: HOSTED_BASE_URLS[p],
        model,
        apiKey: route.apiKey,
        ...(req.instruction !== undefined && { instruction: req.instruction }),
        input: req.input,
        ...(correction !== undefined && { correction }),
        maxTokens: route.maxAnswerTokens,
        structuredOutput: structured(route.structuredOutput),
        timeoutMs: Math.max(1, Math.min(route.timeoutMs, hostedDeadline - now())),
        signal,
        fetchImpl: deps.fetchImpl,
      })
      nextFreeAt.set(p, now() + route.minGapMs)
      await settle(route, model, r)
      attempted(p, model, r.code, t0, r.ok ? r.totalTokens : undefined)
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
          const leaf = r as Step & { retryAfterMs?: number }
          const pause = leaf.retryAfterMs ?? BUSY_BACKOFF_MS
          if (!waited && pause <= BUSY_BACKOFF_MS && now() + pause < hostedDeadline) {
            waited = true
            await sleep(pause, signal)
            continue
          }
          coolUntil.set(coolKey(p, model), { until: now() + pause, day: providerDay(p, now()) })
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
    const first = rotatable.length > 0 ? rotatable[rotation++ % rotatable.length] : undefined
    const order =
      first === undefined ? candidates : [first, ...candidates.filter((c) => c !== first)]

    // ---- hosted cascade ----
    for (const { route, models } of order) {
      for (const model of models) {
        // Re-checked per model: an earlier attempt of this call may have spent or retired it.
        const snap = state.snapshot()
        const today = providerDay(route.provider, now())
        if (isSpent(snap, route.provider, model, today) || isRetired(snap, route.provider, model))
          continue
        const r = await tryModel(route, model)
        if (r.ok) return finish(success(r.data), false)
        if (r.code === 'ABORTED') return finish(r as RouterResult<T>, false)
        reasons.push({ route: route.provider, code: r.code })
        if (NEXT_ROUTE.has(r.code)) break
      }
    }

    // ---- hand-back and floor (§5.2 items 5-6) ----
    if (aborted()) return finish({ ok: false, code: 'ABORTED' }, false)
    if (hostedRoutes.length > 0) {
      emit({
        type: 'FELL_TO_LOCAL',
        plan: candidates.length > 0 ? 'full-then-small' : 'small',
        reasons,
      })
    }
    const floorDeadline = now() + cfg.floorBudgetMs
    const floor = await runExtraction({
      schema,
      call: async (correction?: string): Promise<Step> => {
        if (aborted()) return { ok: false, code: 'ABORTED' }
        if (!promptFits(local, req.instruction, inputChars)) {
          attempted('local', local.model, 'PROMPT_TOO_LARGE', now())
          return { ok: false, code: 'PROMPT_TOO_LARGE' }
        }
        return serialLocal(async (): Promise<Step> => {
          if (aborted()) return { ok: false, code: 'ABORTED' }
          const remaining = floorDeadline - now()
          if (remaining <= 0) return { ok: false, code: 'TIMEOUT' }
          const t0 = now()
          const r = await sendClassifiedChatCompletion({
            provider: 'local',
            baseUrl: local.baseUrl,
            model: local.model,
            ...(local.apiKey !== undefined && { apiKey: local.apiKey }),
            ...(req.instruction !== undefined && { instruction: req.instruction }),
            input: req.input,
            ...(correction !== undefined && { correction }),
            maxTokens: local.maxAnswerTokens,
            structuredOutput: structured(local.structuredOutput),
            timeoutMs: Math.min(local.timeoutMs, remaining),
            signal,
            fetchImpl: deps.fetchImpl,
          })
          attempted('local', local.model, r.code, t0, r.ok ? r.totalTokens : undefined)
          if (!r.ok) return r
          addTokens(r.totalTokens)
          return { ok: true, text: r.text }
        })
      },
    })
    if (floor.ok) return finish(success(floor.data), true)
    return finish({ ok: false, code: floorCode(floor.code) } as RouterResult<T>, false)
  }

  return { run }
}

/**
 * The `router` extraction provider: an `ExtractionPort` over `createRouter` (ADR §2.1). The public
 * result type is unchanged; internal codes never leave the package. The port takes no signal
 * until 5.4c-6, so an abort cannot reach it; it would surface as `TIMEOUT`.
 */
export function createRouterExtractionAdapter(config: unknown, deps: RouterDeps): ExtractionPort {
  const router = createRouter(config, deps)
  return {
    async extract<T>(req: ExtractionRequest<T>): Promise<ExtractionResult<T>> {
      const r = await router.run(req)
      return !r.ok && r.code === 'ABORTED'
        ? { ok: false, code: 'TIMEOUT' }
        : (r as ExtractionResult<T>)
    },
  }
}
