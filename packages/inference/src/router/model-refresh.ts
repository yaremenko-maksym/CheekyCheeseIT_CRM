import { z } from 'zod'
import type { FetchLike } from '../http/bounded-request'
import { sendClassifiedChat, type StructuredOutput } from '../internal/classified-chat'
import { isVisionCapable } from '../internal/model-id'
import { createStrictSchema } from '../internal/strict-schema'
import {
  hostedBaseUrl,
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
  pickListedModels,
  pickLiveModels,
  restNonAlive,
  type ModelFacts,
  type ModelVerdict,
  type ProbeAnswer,
  withheldPromotions,
} from './model-picks'
import { routeChatFields } from './openrouter'
import { releasesUnit, VISION_RESERVE_REQUESTS } from './router'
import {
  clearByProof,
  clearRetired,
  isBusyDead,
  isBusyDeadReprobeDue,
  isCreditHeldUntilProof,
  isRetired,
  isSpent,
  markCredit,
  markStartupRefresh,
  needsProofProbe,
  ownCapRemaining,
  PROBE_CAP,
  providerDay,
  providerRecord,
  setJobFailed,
  setModelRecords,
  setStaleModels,
  staleModelsOf,
  type OwnCapPort,
  type RouteState,
  type RouteStatePort,
} from './state'

export { PROBE_CAP }

/** At most 10 requests a minute across the sweep, whatever the model's per-minute limit. */
export const PROBE_PAUSE_MS = 6_000
export const PROBE_MAX_TOKENS = 16
export const STARTUP_REFRESH_MIN_GAP_MS = 60 * 60 * 1000

/** The fixed synthetic prompt (§3.4, VCF's form): no CV, vacancy or user text ever goes here. */
export const MODEL_PROBE_PROMPT = 'Reply only with the JSON {"ok":true}.'
const PROBE_JSON_SCHEMA = createStrictSchema(z.object({ ok: z.boolean() })).jsonSchema

export type ModelRefreshJob = 'daily' | 'chain' | 'startup'
export type ProviderFailure =
  'AUTH' | 'CREDIT' | 'LISTING' | 'NOTHING_SURVIVED' | 'WRITE' | 'INTERNAL'
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

type ProbeOutcome =
  | { kind: 'capped' }
  | { kind: 'unwritten' }
  | { kind: 'auth' }
  | { kind: 'credit' }
  | ({ kind: 'answered'; rejected: boolean } & ProbeAnswer)

/** One fixed-prompt chat through the production builder, under the production unit rules (§5.1). */
async function probeModel(
  route: HostedRouteConfig,
  model: string,
  deps: ModelRefreshDeps,
  proofModel: string | undefined,
): Promise<ProbeOutcome> {
  const p = route.provider
  // A probe of a vision model obeys the router's vision reserve (finding 4, Master D2): the last
  // requests of the day stay with image calls. Stopped as `capped`, so an unprobed model is not alive.
  const left = ownCapRemaining(
    deps.state.snapshot(),
    p,
    route.freeLimit,
    providerDay(p, deps.now()),
  )
  if (isVisionCapable(p, model) && left <= VISION_RESERVE_REQUESTS) return { kind: 'capped' }
  const unit = await deps.ownCap.reserve(p, route.freeLimit)
  if (unit === null) return { kind: 'capped' }
  // A failed state write is a fault, not the cap (R2): reported as STATE, not CAP.
  if (unit === 'WRITE_FAILED') return { kind: 'unwritten' }
  const structuredOutput: StructuredOutput =
    route.structuredOutput === 'json_schema'
      ? { mode: 'json_schema', schema: PROBE_JSON_SCHEMA }
      : { mode: route.structuredOutput }
  const outcome = await sendClassifiedChat({
    provider: p,
    baseUrl: hostedBaseUrl(route),
    model,
    apiKey: route.apiKey,
    instruction: MODEL_PROBE_PROMPT,
    input: MODEL_PROBE_PROMPT,
    maxTokens: PROBE_MAX_TOKENS,
    structuredOutput,
    timeoutMs: route.timeoutMs,
    fetchImpl: deps.fetchImpl,
    ...routeChatFields(route),
  })
  const { result: r, status } = outcome
  if (r.ok && r.totalTokens !== undefined) await deps.ownCap.addTokens(p, r.totalTokens)
  if (releasesUnit(outcome)) await deps.ownCap.release(p, unit)
  if (r.code === 'AUTH') return { kind: 'auth' }
  // Only a provider whose CREDIT waits for a proof stops here; any other keeps main's probe verdict.
  if (r.code === 'CREDIT' && isCreditHeldUntilProof(p)) {
    await deps.state.update(markCredit(p, providerDay(p, deps.now())))
    return { kind: 'credit' }
  }
  const byStatus = classifyModelStatus(status)
  // §3.2: the only proof that clears `AUTH` is a keyed 2xx chat; a listing never does. The same
  // probe, built like a production request, clears a proof-held `CREDIT` and `FLAG_REJECTED` (§3.5).
  if (byStatus === 'alive' && needsProofProbe(deps.state.snapshot(), p)) {
    await deps.state.update(clearByProof(p, model, proofModel))
  }
  // A probe refused by a routing field makes that model ineligible; it never sets the provider bit.
  const rejected = r.code === 'FLAG_REJECTED'
  const verdict = r.code === 'RETIRED' || rejected ? 'dead' : byStatus
  deps.onEvent({ type: 'MODEL_PROBED', provider: p, model, verdict })
  return {
    kind: 'answered',
    model,
    verdict,
    busy429: status === 429 && r.code === 'BUSY',
    rejected,
  }
}

type Sweep = {
  answers: ProbeAnswer[]
  /** Models a probe found `FLAG_REJECTED`: never written to the managed list (§3.5). */
  rejected: string[]
  stopped: 'capped' | 'unwritten' | 'auth' | 'credit' | null
}

/**
 * The model whose 2xx probe clears a `FLAG_REJECTED` bit (§3.5): the flagged model while it is in
 * the vetted list and not retired, even if spent, cooling down or not probed now; otherwise the
 * first vetted model that is not retired.
 */
function proofModelOf(
  s: RouteState,
  p: HostedProvider,
  vetted: readonly string[],
): string | undefined {
  const flagModel = providerRecord(s, p).flagModel
  if (flagModel === undefined) return undefined
  const live = vetted.filter((m) => !isRetired(s, p, m))
  return live.includes(flagModel) ? flagModel : live[0]
}

export type ProbeAllOptions = {
  /** The provider's vetted list, which names the proof model; the probed models when absent. */
  vetted?: readonly string[]
  /**
   * Models a proof retry may go to (§3.5); absent when no retry may be sent. At most two proof
   * probes; each takes its own unit.
   */
  proofRetry?: readonly string[] | undefined
}

export async function probeAll(
  route: HostedRouteConfig,
  models: readonly string[],
  deps: ModelRefreshDeps,
  opts: ProbeAllOptions = {},
): Promise<Sweep> {
  const p = route.provider
  const vetted = opts.vetted ?? models
  const answers: ProbeAnswer[] = []
  const rejected: string[] = []
  // A refresh drops a rejected model from the list, so it no longer names the proof model.
  const proofModel = (): string | undefined =>
    proofModelOf(
      deps.state.snapshot(),
      p,
      opts.proofRetry !== undefined ? vetted.filter((m) => !rejected.includes(m)) : vetted,
    )
  const firstProof = proofModel()
  const queue = [...models]
  for (const [i, model] of queue.entries()) {
    if (i > 0) await deps.sleep(PROBE_PAUSE_MS)
    const o = await probeModel(route, model, deps, proofModel())
    if (o.kind !== 'answered') return { answers, rejected, stopped: o.kind }
    answers.push({ model: o.model, verdict: o.verdict, busy429: o.busy429 })
    if (!o.rejected) continue
    rejected.push(o.model)
    const next = proofModel()
    if (opts.proofRetry !== undefined && model === firstProof && next !== undefined) {
      if (opts.proofRetry.includes(next) && !queue.includes(next)) queue.push(next)
    }
  }
  return { answers, rejected, stopped: null }
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
 * leaves the list file untouched. Probes already made still record their probe day, but a promotion
 * counts only once the list moved. A refused state write skips the provider with reason `STATE`, never `done`.
 */
async function refreshProvider(
  route: HostedRouteConfig,
  deps: ModelRefreshDeps,
  maxProbes: number,
  proofProbe: boolean,
): Promise<ProviderOutcome> {
  const p = route.provider
  const unit = await deps.ownCap.reserve(p, route.freeLimit)
  if (unit === null) return skipped(p, 'CAP')
  if (unit === 'WRITE_FAILED') return skipped(p, 'STATE')
  const listing = await fetchModelListing({
    provider: p,
    apiKey: route.apiKey,
    accountId: route.accountId,
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

  const nowMs = deps.now()
  const today = new Date(nowMs).toISOString().slice(0, 10)
  const spentDay = providerDay(p, nowMs)
  const before = deps.state.snapshot()
  // The reader falls back to the pinned list, which may name a held model: a verdict still wins here.
  const managed = await deps.managedModels(p, route.models)
  const current = managed.filter((m) => !isBusyDead(before, m))
  const listed =
    p === 'gemini' ? geminiCandidates(listing.models, current, route.contextTokens) : []
  // A held model's due re-probe waits behind every other candidate, so it cannot take their slot.
  const candidates = [
    ...listed.filter((m) => !isBusyDead(before, m)),
    ...listed.filter((m) => isBusyDeadReprobeDue(before, m, today)),
  ]
  const eligible = [...current, ...candidates].filter(
    (m) => !isSpent(before, p, m, spentDay) && deps.hadOkCall?.(p, m) !== true,
  )
  // The start-up probe is the only proof that clears `AUTH` (§3.2), so nothing eligible cannot skip it.
  const pool = eligible.length === 0 && proofProbe ? current : eligible
  // A `FLAG_REJECTED` bit clears only by a probe of its proof model, so that model goes first, even
  // after an OK call; spent or cooling down, it waits, and no other model's 2xx clears the bit.
  const proof = proofProbe ? proofModelOf(before, p, managed) : undefined
  const ordered =
    proof !== undefined && current.includes(proof) && !isSpent(before, p, proof, spentDay)
      ? [proof, ...pool.filter((m) => m !== proof)]
      : pool
  const due = ordered.slice(0, maxProbes)
  const { answers, rejected, stopped } = await probeAll(route, due, deps, {
    vetted: managed,
    ...(proofProbe ? { proofRetry: current.filter((m) => !isSpent(before, p, m, spentDay)) } : {}),
  })

  const after = deps.state.snapshot()
  const day = applyProbeDay({
    answers,
    pinned: route.models,
    probation: after.probation,
    busy: after.busy,
    held: after.busyDead,
    today,
  })
  const pick = (): string[] => {
    if (p !== 'gemini') {
      return pickListedModels({
        provider: p,
        current: current.filter((m) => !rejected.includes(m)),
        listing: listing.models.filter((m) => !rejected.includes(m.id)),
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
  const written = stopped === null && (await deps.writeManagedList(p, next))
  let recorded = true
  if (p === 'gemini') {
    const known = new Set([...next, ...listing.models.map((m) => m.id)])
    // List entries last, so the oldest off-list record goes first at the cap, never the list's.
    const kept = <T extends { model: string }>(records: T[]): T[] => [
      ...records.filter((r) => known.has(r.model) && !next.includes(r.model)),
      ...records.filter((r) => next.includes(r.model)),
    ]
    const rested = restNonAlive({
      answers,
      // Never wipe: an empty `next` is not written, so the file still serves `current` (§3.4).
      list: next.length === 0 ? current : next,
      held: day.held,
      probation: written ? day.probation : withheldPromotions(day.probation, day.promotedNow),
      today,
    })
    recorded = await deps.state.update(
      setModelRecords(
        kept(rested.probation),
        kept(day.busy),
        rested.held.filter((r) => known.has(r.model)),
      ),
    )
  }
  if (stopped === 'capped') return skipped(p, 'CAP')
  if (stopped === 'unwritten') return skipped(p, 'STATE')
  if (stopped === 'auth') return failed(p, 'AUTH')
  if (stopped === 'credit') return failed(p, 'CREDIT')
  if (next.length === 0) return failed(p, 'NOTHING_SURVIVED')
  if (!written) return failed(p, 'WRITE')

  // The file moved whatever the records do next, so this is said even if they are refused below.
  for (const model of day.promotedNow) {
    if (next.includes(model)) deps.onEvent({ type: 'MODEL_PROMOTED', provider: p, model })
  }
  // The fresh list is the authority: the provider's retirements restart from it (SR-M-5), and a
  // stale entry the refresh removed has nothing left to warn about.
  const cleared =
    recorded &&
    (await deps.state.update((s) =>
      setStaleModels(
        p,
        staleModelsOf(s, p).filter((m) => next.includes(m)),
      )(clearRetired(p)(s)),
    ))
  return cleared ? { provider: p, outcome: 'done' } : failed(p, 'WRITE')
}

/** A persisted bit this provider can clear only with a keyed 2xx chat probe (§3.2, §3.5). */
function needsProof(deps: ModelRefreshDeps, route: HostedRouteConfig): boolean {
  return needsProofProbe(deps.state.snapshot(), route.provider)
}

function dailyProof(deps: ModelRefreshDeps, route: HostedRouteConfig): boolean {
  return route.provider === 'openrouter' && needsProof(deps, route)
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
    // Listing-only providers spend no daily probe: Groq and Cloudflare additions are vouched for by
    // their family pattern and listing filters, and each probe would cost the day's small allowance.
    route.provider === 'gemini'
      ? refreshProvider(route, deps, PROBE_CAP, false)
      : // A listing-only provider sends no daily chat; OpenRouter sends one only to clear a bit
        // that needs its proof (§3.5); a proof probe answered `FLAG_REJECTED` gets one more, to the
        // model now first, when that model may be probed (§3.5). Groq and Cloudflare clear `AUTH` at start-up only.
        refreshProvider(route, deps, dailyProof(deps, route) ? 1 : 0, dailyProof(deps, route)),
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
    // No second proof probe here: the chain check never edits the list (§3.4 layer 3).
    const { answers, stopped } = await probeAll(route, inUse.slice(0, PROBE_CAP), deps, {
      vetted: inUse,
    })
    const dead = answers.filter((a) => a.verdict === 'dead').map((a) => a.model)
    await deps.state.update((s) =>
      setStaleModels(
        p,
        stopped === null ? dead : [...new Set([...staleModelsOf(s, p), ...dead])],
      )(s),
    )
    if (dead.length > 0) deps.onEvent({ type: 'MODEL_LIST_STALE', provider: p, models: dead })
    if (stopped === 'capped') return skipped(p, 'CAP')
    if (stopped === 'unwritten') return skipped(p, 'STATE')
    if (stopped === 'credit') return failed(p, 'CREDIT')
    return stopped === 'auth' ? failed(p, 'AUTH') : { provider: p, outcome: 'done' }
  })
  await deps.state.update(setJobFailed('chain', !result.ok))
  return result
}

/**
 * The clearing proof of §3.2: a provider with a persisted `AUTH` gets one refresh with one chat
 * probe at start-up, at most once an hour; a proof probe answered `FLAG_REJECTED` gets one more, to the
 * model now first, when that model may be probed (§3.5). The stamp is durable before any request, so
 * a crash loop cannot burn the allowance. A success here is one provider's, so it never clears the daily job.
 */
export async function runStartupModelRefresh(deps: ModelRefreshDeps): Promise<ModelRefreshResult> {
  const result = await forEachProvider(deps, 'startup', async (route) => {
    const p = route.provider
    const record = providerRecord(deps.state.snapshot(), p)
    if (!needsProof(deps, route)) return skipped(p, 'NOT_NEEDED')
    const nowMs = deps.now()
    // A first refresh has no stamp: NaN compares false.
    // A clock gone back reads as recent: it can only delay a refresh, never repeat one.
    if (nowMs - Date.parse(String(record.lastStartupRefreshAt)) < STARTUP_REFRESH_MIN_GAP_MS) {
      return skipped(p, 'RECENT')
    }
    if (!(await deps.state.update(markStartupRefresh(p, nowMs)))) return skipped(p, 'STATE')
    return refreshProvider(route, deps, 1, true)
  })
  if (!result.ok) await deps.state.update(setJobFailed('daily', true))
  return result
}
