import { z } from 'zod'
import type { FetchLike } from '../http/bounded-request'
import { sendClassifiedChat, type StructuredOutput } from '../internal/classified-chat'
import { createStrictSchema } from '../internal/strict-schema'
import {
  HOSTED_BASE_URLS,
  HOSTED_PROVIDERS,
  type HostedProvider,
  type HostedRouteConfig,
  type RouterConfig,
} from './config'
import type { ManagedListWriter, ManagedModels } from './managed-models'
import { fetchModelListing, type ListedModel } from './model-listing'
import {
  applyProbeDay,
  classifyModelStatus,
  effectiveContext,
  MIN_MANAGED_CONTEXT,
  pickGroqModels,
  pickLiveModels,
  type ModelFacts,
  type ModelVerdict,
  type ProbeAnswer,
} from './model-picks'
import { releasesUnit } from './router'
import {
  clearAuth,
  clearRetired,
  isSpent,
  markStartupRefresh,
  providerDay,
  providerRecord,
  setJobFailed,
  setModelRecords,
  setStaleModels,
  type OwnCapPort,
  type RouteStatePort,
} from './state'

/** The list's `TARGET` plus one, so a full list still probes a new candidate each day. */
export const PROBE_CAP = 6
/** At most 10 requests a minute across the sweep, whatever the model's per-minute limit. */
export const PROBE_PAUSE_MS = 6_000
export const PROBE_MAX_TOKENS = 16
export const STARTUP_REFRESH_MIN_GAP_MS = 60 * 60 * 1000

/** The fixed synthetic prompt (§3.4, VCF's form): no CV, vacancy or user text ever goes here. */
export const MODEL_PROBE_PROMPT = 'Reply only with the JSON {"ok":true}.'
const PROBE_JSON_SCHEMA = createStrictSchema(z.object({ ok: z.boolean() })).jsonSchema

export type ModelRefreshJob = 'daily' | 'chain' | 'startup'
export type ProviderFailure = 'AUTH' | 'LISTING' | 'NOTHING_SURVIVED' | 'WRITE' | 'INTERNAL'
export type ProviderSkip = 'UNCONFIGURED' | 'CAP' | 'NOT_NEEDED' | 'RECENT' | 'STATE'

export type ProviderOutcome =
  | { provider: HostedProvider; outcome: 'done' }
  | { provider: HostedProvider; outcome: 'failed'; reason: ProviderFailure }
  | { provider: HostedProvider; outcome: 'skipped'; reason: ProviderSkip }

/** `ok` is false when any configured provider failed; a skipped one is not a failure. */
export type ModelRefreshResult = { ok: boolean; providers: ProviderOutcome[] }

/** Provider names, validated model ids, verdicts, counts and codes; never a key or a body. */
export type ModelRefreshEvent =
  | { type: 'MODEL_IDS_DROPPED'; provider: HostedProvider; dropped: number; beyondCap: number }
  | { type: 'MODEL_PROBED'; provider: HostedProvider; model: string; verdict: ModelVerdict }
  | { type: 'MODEL_PROMOTED'; provider: HostedProvider; model: string }
  | { type: 'MODEL_LIST_STALE'; provider: HostedProvider; models: string[] }
  | ({ type: 'MODEL_REFRESH_PROVIDER'; job: ModelRefreshJob } & ProviderOutcome)
  | { type: 'MODEL_REFRESH_FAILED'; job: ModelRefreshJob }

export type ModelRefreshDeps = {
  config: RouterConfig
  state: RouteStatePort
  ownCap: OwnCapPort
  managedModels: ManagedModels
  writeManagedList: ManagedListWriter
  onEvent: (e: ModelRefreshEvent) => void
  now: () => number
  sleep: (ms: number) => Promise<void>
  fetchImpl?: FetchLike | undefined
  /** A model with an `OK` call since the last refresh has a no-probe day (§3.4). */
  hadOkCall?: ((p: HostedProvider, model: string) => boolean) | undefined
}

const failed = (provider: HostedProvider, reason: ProviderFailure): ProviderOutcome => ({
  provider,
  outcome: 'failed',
  reason,
})
const skipped = (provider: HostedProvider, reason: ProviderSkip): ProviderOutcome => ({
  provider,
  outcome: 'skipped',
  reason,
})

type ProbeOutcome = { kind: 'capped' } | { kind: 'auth' } | ({ kind: 'answered' } & ProbeAnswer)

/** One fixed-prompt chat through the production builder, under the production unit rules (§5.1). */
async function probeModel(
  route: HostedRouteConfig,
  model: string,
  deps: ModelRefreshDeps,
): Promise<ProbeOutcome> {
  const p = route.provider
  const unit = await deps.ownCap.reserve(p, route.freeLimit)
  if (unit === null) return { kind: 'capped' }
  const structuredOutput: StructuredOutput =
    route.structuredOutput === 'json_schema'
      ? { mode: 'json_schema', schema: PROBE_JSON_SCHEMA }
      : { mode: route.structuredOutput }
  const outcome = await sendClassifiedChat({
    provider: p,
    baseUrl: HOSTED_BASE_URLS[p],
    model,
    apiKey: route.apiKey,
    instruction: MODEL_PROBE_PROMPT,
    input: MODEL_PROBE_PROMPT,
    maxTokens: PROBE_MAX_TOKENS,
    structuredOutput,
    timeoutMs: route.timeoutMs,
    fetchImpl: deps.fetchImpl,
  })
  const { result: r, status } = outcome
  if (r.ok && r.totalTokens !== undefined) await deps.ownCap.addTokens(p, r.totalTokens)
  if (releasesUnit(outcome)) await deps.ownCap.release(p, unit)
  if (r.code === 'AUTH') return { kind: 'auth' }
  const byStatus = classifyModelStatus(status)
  // §3.2: the only proof that clears `AUTH` is a keyed 2xx chat; a listing never does.
  if (byStatus === 'alive' && providerRecord(deps.state.snapshot(), p).auth) {
    await deps.state.update(clearAuth(p))
  }
  const verdict = r.code === 'RETIRED' ? 'dead' : byStatus
  deps.onEvent({ type: 'MODEL_PROBED', provider: p, model, verdict })
  return { kind: 'answered', model, verdict, busy429: status === 429 && r.code === 'BUSY' }
}

type Sweep = { answers: ProbeAnswer[]; stopped: 'capped' | 'auth' | null }

async function probeAll(
  route: HostedRouteConfig,
  models: readonly string[],
  deps: ModelRefreshDeps,
): Promise<Sweep> {
  const answers: ProbeAnswer[] = []
  for (const [i, model] of models.entries()) {
    if (i > 0) await deps.sleep(PROBE_PAUSE_MS)
    const o = await probeModel(route, model, deps)
    if (o.kind !== 'answered') return { answers, stopped: o.kind }
    answers.push({ model: o.model, verdict: o.verdict, busy429: o.busy429 })
  }
  return { answers, stopped: null }
}

/** New Gemini ids with a reported context over the floor, largest effective context first. */
function geminiCandidates(
  listed: readonly ListedModel[],
  current: readonly string[],
  routeWindow: number,
): string[] {
  const context = (m: ListedModel): number => effectiveContext(m.context ?? 0, routeWindow)
  return listed
    .filter((m) => !current.includes(m.id) && context(m) >= MIN_MANAGED_CONTEXT)
    .sort((a, b) => context(b) - context(a))
    .map((m) => m.id)
}

/**
 * One provider's refresh (§3.4 layer 2). A failed listing, `AUTH`, a cap refusal or an empty result
 * leaves the list file untouched. Probes already made still record their probe day.
 */
async function refreshProvider(
  route: HostedRouteConfig,
  deps: ModelRefreshDeps,
  maxProbes: number,
): Promise<ProviderOutcome> {
  const p = route.provider
  const unit = await deps.ownCap.reserve(p, route.freeLimit)
  if (unit === null) return skipped(p, 'CAP')
  const listing = await fetchModelListing({
    provider: p,
    apiKey: route.apiKey,
    timeoutMs: route.timeoutMs,
    fetchImpl: deps.fetchImpl,
  })
  if (listing.kind !== 'ok') {
    if (listing.kind === 'auth' || listing.noResponse) await deps.ownCap.release(p, unit)
    return failed(p, listing.kind === 'auth' ? 'AUTH' : 'LISTING')
  }
  if (listing.dropped + listing.beyondCap > 0) {
    deps.onEvent({
      type: 'MODEL_IDS_DROPPED',
      provider: p,
      dropped: listing.dropped,
      beyondCap: listing.beyondCap,
    })
  }

  const current = await deps.managedModels(p, route.models)
  const candidates =
    p === 'gemini' ? geminiCandidates(listing.models, current, route.contextTokens) : []
  const nowMs = deps.now()
  const spentDay = providerDay(p, nowMs)
  const before = deps.state.snapshot()
  const due = [...current, ...candidates]
    .filter((m) => !isSpent(before, p, m, spentDay) && deps.hadOkCall?.(p, m) !== true)
    .slice(0, maxProbes)
  const { answers, stopped } = await probeAll(route, due, deps)

  const after = deps.state.snapshot()
  const day = applyProbeDay({
    answers,
    pinned: route.models,
    probation: after.probation ?? [],
    busy: after.busy ?? [],
    today: new Date(nowMs).toISOString().slice(0, 10),
  })
  const pick = (): string[] => {
    if (p === 'groq') {
      return pickGroqModels({
        current,
        listing: listing.models,
        routeWindow: route.contextTokens,
        minContext: MIN_MANAGED_CONTEXT,
      })
    }
    const facts = new Map<string, ModelFacts>(
      listing.models.map((m) => [
        m.id,
        {
          // A missing or garbage limit is unknown, not small: it must not remove a current model.
          context:
            m.context === undefined ? undefined : effectiveContext(m.context, route.contextTokens),
        },
      ]),
    )
    for (const [model, verdict] of day.verdicts) {
      facts.set(model, { ...facts.get(model), verdict })
    }
    return pickLiveModels({
      current,
      candidates,
      facts,
      promotedNow: day.promotedNow,
      minContext: MIN_MANAGED_CONTEXT,
    })
  }
  const next = stopped === null ? pick() : current
  if (p === 'gemini') {
    const known = new Set([...next, ...listing.models.map((m) => m.id)])
    await deps.state.update(
      setModelRecords(
        day.probation.filter((r) => known.has(r.model)),
        day.busy.filter((r) => known.has(r.model)),
      ),
    )
  }
  if (stopped === 'capped') return skipped(p, 'CAP')
  if (stopped === 'auth') return failed(p, 'AUTH')
  if (next.length === 0) return failed(p, 'NOTHING_SURVIVED')
  if (!(await deps.writeManagedList(p, next))) return failed(p, 'WRITE')

  // The fresh list is the authority: the provider's retirements restart from it (SR-M-5), and a
  // stale entry the refresh removed has nothing left to warn about.
  await deps.state.update((s) => {
    const named = (s.modelListStale ?? []).filter((e) => e.provider === p).map((e) => e.model)
    return setStaleModels(
      p,
      named.filter((m) => next.includes(m)),
    )(clearRetired(p)(s))
  })
  for (const model of day.promotedNow) {
    if (next.includes(model)) deps.onEvent({ type: 'MODEL_PROMOTED', provider: p, model })
  }
  return { provider: p, outcome: 'done' }
}

/** The allowlist drives the loop, so a config or a listing cannot introduce a provider. */
function hostedRoute(deps: ModelRefreshDeps, p: HostedProvider): HostedRouteConfig | undefined {
  const route = deps.config.routes.find((r): r is HostedRouteConfig => r.provider === p)
  return route !== undefined && route.apiKey.length > 0 ? route : undefined
}

/** Providers run one by one and independently: an exception in one never stops the next. */
async function forEachProvider(
  deps: ModelRefreshDeps,
  job: ModelRefreshJob,
  run: (route: HostedRouteConfig) => Promise<ProviderOutcome>,
): Promise<ModelRefreshResult> {
  const providers: ProviderOutcome[] = []
  for (const p of HOSTED_PROVIDERS) {
    const route = hostedRoute(deps, p)
    const outcome =
      route === undefined
        ? skipped(p, 'UNCONFIGURED')
        : await run(route).catch(() => failed(p, 'INTERNAL'))
    deps.onEvent({ type: 'MODEL_REFRESH_PROVIDER', job, ...outcome })
    providers.push(outcome)
  }
  const ok = providers.every((r) => r.outcome !== 'failed')
  if (!ok) deps.onEvent({ type: 'MODEL_REFRESH_FAILED', job })
  return { ok, providers }
}

/** §3.4 layer 2, the daily job. Scheduling it is the worker's (5.4c-W). */
export async function runDailyModelRefresh(deps: ModelRefreshDeps): Promise<ModelRefreshResult> {
  const result = await forEachProvider(deps, 'daily', (route) =>
    // Groq's availability comes from its listing: its daily job sends no chat.
    refreshProvider(route, deps, route.provider === 'groq' ? 0 : PROBE_CAP),
  )
  await deps.state.update(setJobFailed('daily', !result.ok))
  return result
}

/**
 * §3.4 layer 3, the weekly chain check: one probe per model in use. It never edits a list and earns
 * no streak. `MODEL_LIST_STALE` is replaced by a provider's finished run; an unfinished one can
 * only add to it, since a model it never reached has not been proven alive.
 */
export async function runModelChainCheck(deps: ModelRefreshDeps): Promise<ModelRefreshResult> {
  const result = await forEachProvider(deps, 'chain', async (route) => {
    const p = route.provider
    const inUse = await deps.managedModels(p, route.models)
    const { answers, stopped } = await probeAll(route, inUse.slice(0, PROBE_CAP), deps)
    const dead = answers.filter((a) => a.verdict === 'dead').map((a) => a.model)
    await deps.state.update((s) => {
      const previous = (s.modelListStale ?? []).filter((e) => e.provider === p).map((e) => e.model)
      return setStaleModels(p, stopped === null ? dead : [...new Set([...previous, ...dead])])(s)
    })
    if (dead.length > 0) deps.onEvent({ type: 'MODEL_LIST_STALE', provider: p, models: dead })
    if (stopped === 'capped') return skipped(p, 'CAP')
    return stopped === 'auth' ? failed(p, 'AUTH') : { provider: p, outcome: 'done' }
  })
  await deps.state.update(setJobFailed('chain', !result.ok))
  return result
}

/**
 * The clearing proof of §3.2: a provider with a persisted `AUTH` gets one refresh with one chat
 * probe at start-up, at most once an hour. The stamp is durable before any request, so a crash loop
 * cannot burn the allowance. A success here is one provider's, so it never clears the daily job.
 */
export async function runStartupModelRefresh(deps: ModelRefreshDeps): Promise<ModelRefreshResult> {
  const result = await forEachProvider(deps, 'startup', async (route) => {
    const p = route.provider
    const record = providerRecord(deps.state.snapshot(), p)
    if (!record.auth) return skipped(p, 'NOT_NEEDED')
    const nowMs = deps.now()
    const last = record.lastStartupRefreshAt
    // A clock gone back reads as recent: it can only delay a refresh, never repeat one.
    if (last !== undefined && nowMs - Date.parse(last) < STARTUP_REFRESH_MIN_GAP_MS) {
      return skipped(p, 'RECENT')
    }
    if (!(await deps.state.update(markStartupRefresh(p, nowMs)))) return skipped(p, 'STATE')
    return refreshProvider(route, deps, 1)
  })
  if (!result.ok) await deps.state.update(setJobFailed('daily', true))
  return result
}
