import { GROQ_MODEL_PATTERN } from '../internal/model-id'
import { MANAGED_LIST_TARGET } from './managed-models'
import {
  BUSY_DEAD_DAYS,
  PROMOTION_STREAK,
  type BusyDeadEntry,
  type BusyEntry,
  type ProbationEntry,
} from './state'

/** The floor of a managed model's context window; a model under it cannot take a chunk (§3.4). */
export const MIN_MANAGED_CONTEXT = 16_000

export type ModelVerdict = 'alive' | 'dead' | 'transient' | 'unknown'

/** `undefined` is no status at all: a timeout or a network error, never `dead` (§3.4). */
export function classifyModelStatus(status: number | undefined): ModelVerdict {
  const code = status ?? 0
  if (code >= 200 && code < 300) return 'alive'
  if (code === 404) return 'dead'
  return code === 429 || code === 503 ? 'transient' : 'unknown'
}

/** A provider-reported number is untrusted: it can never widen what the route accepts (§3.4). */
export function effectiveContext(reported: number, routeWindow: number): number {
  return Math.min(reported, routeWindow)
}

/**
 * One probe day of a probation record (SR-M-9). A second probe on one day counts once, and a day
 * earlier than the record's (a clock gone back) earns nothing.
 */
export function nextProbation(
  record: ProbationEntry | undefined,
  model: string,
  verdict: 'alive' | 'transient' | 'unknown',
  today: string,
): ProbationEntry {
  if (verdict !== 'alive') {
    return { provider: 'gemini', model, aliveStreak: 0, lastProbeDay: today }
  }
  if (record !== undefined && record.lastProbeDay >= today) return record
  return {
    provider: 'gemini',
    model,
    aliveStreak: Math.min(PROMOTION_STREAK, (record?.aliveStreak ?? 0) + 1),
    lastProbeDay: today,
  }
}

/**
 * One probe day of a busy record: a 429 without a per-day quota id counts, once per day; any other
 * answer ends the run of consecutive days (no record). A no-probe day never reaches this.
 */
export function nextBusy(
  record: BusyEntry | undefined,
  model: string,
  busy429: boolean,
  today: string,
): BusyEntry | undefined {
  if (!busy429) return undefined
  if (record !== undefined && record.lastProbeDay >= today) return record
  return {
    provider: 'gemini',
    model,
    busyDays: Math.min(BUSY_DEAD_DAYS, (record?.busyDays ?? 0) + 1),
    lastProbeDay: today,
  }
}

export type ProbeAnswer = { model: string; verdict: ModelVerdict; busy429: boolean }

/**
 * Folds one run's probes into the Gemini records. Three busy days turn a verdict `dead` and stamp
 * it; a dead model loses both records; a pinned model needs no probation record. A held model's
 * re-probe clears the stamp only on an alive answer (back as probation, streak 0); any other answer
 * restamps it. `promotedNow` is the transition to a full streak, not its possession.
 */
export function applyProbeDay(args: {
  answers: readonly ProbeAnswer[]
  pinned: readonly string[]
  probation: readonly ProbationEntry[] | undefined
  busy: readonly BusyEntry[] | undefined
  held: readonly BusyDeadEntry[] | undefined
  today: string
}): {
  probation: ProbationEntry[]
  busy: BusyEntry[]
  held: BusyDeadEntry[]
  verdicts: Map<string, ModelVerdict>
  promotedNow: Set<string>
} {
  let probation = [...(args.probation ?? [])]
  let busy = [...(args.busy ?? [])]
  let held = [...(args.held ?? [])]
  const verdicts = new Map<string, ModelVerdict>()
  const promotedNow = new Set<string>()
  const stamp = (model: string): BusyDeadEntry => ({
    provider: 'gemini',
    model,
    day: args.today,
  })
  for (const { model, verdict, busy429 } of args.answers) {
    if (held.some((r) => r.model === model)) {
      held = held.filter((r) => r.model !== model)
      if (verdict === 'alive') {
        verdicts.set(model, 'alive')
        if (!args.pinned.includes(model)) {
          probation = [
            ...probation.filter((r) => r.model !== model),
            { provider: 'gemini', model, aliveStreak: 0, lastProbeDay: args.today },
          ]
        }
      } else {
        verdicts.set(model, 'dead')
        held = [...held, stamp(model)]
      }
      continue
    }
    const others = busy.filter((r) => r.model !== model)
    const nowBusy = nextBusy(
      busy.find((r) => r.model === model),
      model,
      busy429,
      args.today,
    )
    const final = nowBusy?.busyDays === BUSY_DEAD_DAYS ? 'dead' : verdict
    busy = nowBusy === undefined || final === 'dead' ? others : [...others, nowBusy]
    verdicts.set(model, final)
    if (nowBusy?.busyDays === BUSY_DEAD_DAYS) held = [...held, stamp(model)]
    const before = probation.find((r) => r.model === model)
    const rest = probation.filter((r) => r.model !== model)
    if (final === 'dead') {
      probation = rest
    } else if (!args.pinned.includes(model)) {
      const wasFull = before?.aliveStreak === PROMOTION_STREAK
      const after = nextProbation(before, model, final, args.today)
      probation = [...rest, after]
      if (after.aliveStreak === PROMOTION_STREAK && !wasFull) promotedNow.add(model)
    }
  }
  return { probation, busy, held, verdicts, promotedNow }
}

export type ModelFacts = {
  /** `undefined`: not probed in this run. */
  verdict?: ModelVerdict | undefined
  /** Effective context; `undefined` when this listing did not report the model. */
  context?: number | undefined
}

const STATUS_RANK: Record<ModelVerdict, number> = { alive: 0, transient: 1, unknown: 2, dead: 3 }

/**
 * VCF's `pickLiveModels` with the CRM order (SR-H-1). Dead and too-small models go; existing
 * entries keep their order; probed new candidates go to the tail, by status then context. Only a
 * model just promoted moves above older ones. An unprobed candidate is not added.
 */
export function pickLiveModels(args: {
  current: readonly string[]
  candidates: readonly string[]
  facts: ReadonlyMap<string, ModelFacts>
  promotedNow: ReadonlySet<string>
  minContext: number
}): string[] {
  const { current, candidates, facts, promotedNow, minContext } = args
  const usable = (id: string): boolean => {
    const f = facts.get(id)
    return f?.verdict !== 'dead' && (f?.context ?? Number.POSITIVE_INFINITY) >= minContext
  }
  const fresh = candidates
    .filter((id) => !current.includes(id) && usable(id) && facts.get(id)?.verdict !== undefined)
    .sort((a, b) => {
      const fa = facts.get(a)!
      const fb = facts.get(b)!
      const byStatus = STATUS_RANK[fa.verdict!] - STATUS_RANK[fb.verdict!]
      return byStatus !== 0 ? byStatus : (fb.context ?? 0) - (fa.context ?? 0)
    })
  const all = [...current.filter(usable), ...fresh]
  return [
    ...all.filter((id) => promotedNow.has(id)),
    ...all.filter((id) => !promotedNow.has(id)),
  ].slice(0, MANAGED_LIST_TARGET)
}

export type GroqListed = { id: string; context?: number | undefined; active?: boolean | undefined }

/**
 * VCF's `pickGroqModels` with the CRM restriction (SR-H-1): current ids still listed and active,
 * plus at most one addition, the largest-context chat model inside the checked-in family. Groq
 * additions are never chat-probed, so the family pattern is what vouches for them. A current id with
 * no reported context stays (only the route window bounds it); an addition must report one.
 */
export function pickGroqModels(args: {
  current: readonly string[]
  listing: readonly GroqListed[]
  routeWindow: number
  minContext: number
}): string[] {
  const { current, listing, routeWindow, minContext } = args
  const fits = (m: GroqListed): boolean =>
    m.active === true &&
    effectiveContext(m.context ?? Number.POSITIVE_INFINITY, routeWindow) >= minContext
  const live = listing.filter(fits)
  const kept = current.filter((id) => live.some((m) => m.id === id))
  const [addition] = live
    .filter(
      (m) => m.context !== undefined && !current.includes(m.id) && GROQ_MODEL_PATTERN.test(m.id),
    )
    .sort((a, b) => b.context! - a.context!)
  return [...kept, ...(addition === undefined ? [] : [addition.id])].slice(0, MANAGED_LIST_TARGET)
}
