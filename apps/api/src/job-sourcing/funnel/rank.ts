/**
 * Rank score of one job opportunity for one audience (Task 4.3). Pure: no clock, no I/O; the
 * evaluation time is an argument, so identical inputs give identical scores.
 *
 *   age   = max(0, (evaluationTime - trustedPublishedAtOrFirstSeenAt) / 86_400_000)
 *   score = clamp(round(100 * e^(-age / 7) + 10 * min(matchCount, 10) - penalties), 0, 1000)
 *
 * Eligibility gates (restrictions, availability) are NOT penalties: they decide whether a posting
 * is shown at all and never reach this function. Penalties exist only for UNKNOWN facts.
 * Weights stay at these defaults until a labelled comparison (precision@10/@20, wasted review time)
 * justifies a change.
 */

const MS_PER_DAY = 86_400_000
const MAX_SCORE = 1000

export interface RankConfig {
  freshnessWeight: number
  decayDays: number
  matchWeight: number
  matchCap: number
  penalties: { unknownSeniority: number; unknownStack: number; unknownRemote: number }
  /**
   * Equal for every platform today (A1d). Scales the positive terms (freshness + matches) so a
   * future per-platform weight cannot be confused with a penalty; 1 is the identity.
   */
  platformWeight: number
}

export const RANK_DEFAULTS: RankConfig = {
  freshnessWeight: 100,
  decayDays: 7,
  matchWeight: 10,
  matchCap: 10,
  penalties: { unknownSeniority: 15, unknownStack: 20, unknownRemote: 10 },
  platformWeight: 1,
}

/** INITIAL_SWEEP: first seen during the configuration version's first complete run (not "new"). */
export type FirstSeenKind = 'NORMAL' | 'INITIAL_SWEEP'
export type RankWarning = 'FUTURE_DATE' | 'UNKNOWN_DATE'

export interface RankInput {
  evaluationTime: Date
  /** Published date that passed the date policy (status OK); null when the source has none. */
  trustedPublishedAt: Date | null
  firstSeenAt: Date
  firstSeenKind: FirstSeenKind
  /** Already scoped to the audience: see `scopedMatchCount`. */
  matchCount: number
  unknownSeniority: boolean
  unknownStack: boolean
  unknownRemote: boolean
}

export interface RankResult {
  score: number
  warnings: RankWarning[]
}

const isValidDate = (d: Date | null): d is Date => d !== null && !Number.isNaN(d.getTime())

/** HR sees matches against the teams they are authorized for; ADMIN against the whole studio. */
export function scopedMatchCount(
  role: 'HR' | 'ADMIN',
  counts: { authorizedTeam: number; studio: number },
): number {
  return role === 'HR' ? counts.authorizedTeam : counts.studio
}

export function rankScore(input: RankInput, config: RankConfig = RANK_DEFAULTS): RankResult {
  const warnings: RankWarning[] = []
  const evaluatedAt = input.evaluationTime.getTime()

  let usePublished = isValidDate(input.trustedPublishedAt)
  if (usePublished && input.trustedPublishedAt!.getTime() > evaluatedAt) {
    usePublished = false
    warnings.push('FUTURE_DATE')
  }

  // A first-seen time recorded during the initial sweep says when WE first looked, not when the
  // posting appeared, so it cannot stand in for the age: freshness is dropped instead.
  const sweepUnknown = !usePublished && input.firstSeenKind === 'INITIAL_SWEEP'
  if (sweepUnknown) warnings.push('UNKNOWN_DATE')

  let freshness = 0
  if (!sweepUnknown) {
    const reference = usePublished ? input.trustedPublishedAt! : input.firstSeenAt
    const age = Math.max(0, (evaluatedAt - reference.getTime()) / MS_PER_DAY)
    freshness = config.freshnessWeight * Math.exp(-age / config.decayDays)
  }

  const matches = Number.isFinite(input.matchCount) ? Math.max(0, Math.trunc(input.matchCount)) : 0
  const positive =
    (freshness + config.matchWeight * Math.min(matches, config.matchCap)) * config.platformWeight

  const penalties =
    (input.unknownSeniority ? config.penalties.unknownSeniority : 0) +
    (input.unknownStack ? config.penalties.unknownStack : 0) +
    (input.unknownRemote ? config.penalties.unknownRemote : 0)

  // Math.max(0, -0) is +0, so a clamped zero is never negative zero.
  const score = Math.min(MAX_SCORE, Math.max(0, Math.round(positive - penalties)))
  return { score, warnings }
}

export interface RankedRow {
  score: number
  firstSeenAt: Date
  opportunityId: string
}

/** Descending (score, firstSeenAt, opportunityId): the total order generation pagination relies on. */
export function compareRanked(a: RankedRow, b: RankedRow): number {
  if (a.score !== b.score) return b.score - a.score
  const seen = b.firstSeenAt.getTime() - a.firstSeenAt.getTime()
  if (seen !== 0) return seen
  if (a.opportunityId === b.opportunityId) return 0
  return a.opportunityId < b.opportunityId ? 1 : -1
}
