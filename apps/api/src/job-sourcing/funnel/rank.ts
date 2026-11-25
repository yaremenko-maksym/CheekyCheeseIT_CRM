/**
 * Rank score of one job opportunity for one audience (Task 4.3). Pure: no clock, no I/O; the
 * evaluation time is an argument, so identical inputs give identical scores.
 *
 *   age   = max(0, (evaluationTime - trustedPublishedAtOrFirstSeenAt) / 86_400_000)
 *   fit   = clamp(fit, 0, 1), or RELEVANCE_NEUTRAL_FIT (0.5) when null / non-finite
 *   score = clamp(round((100 * e^(-age / 7) + 300 * fit) * platformWeight - penalties), 0, 1000)
 *
 * `fit` is the current-key Jev grade of one vacancy against one senior (eval.3). It is an ordering
 * signal only: vacancy text is untrusted model input, so the fit never filters or hides a posting,
 * and an ungraded pair ranks at the neutral value instead of dropping out.
 *
 * Eligibility gates (restrictions, availability) are NOT penalties: they decide whether a posting
 * is shown at all and never reach this function. Penalties exist only for UNKNOWN facts.
 * Weights stay at these defaults until a labelled comparison (precision@10/@20, wasted review time)
 * justifies a change.
 */

const MS_PER_DAY = 86_400_000
export const MAX_SCORE = 1000

/** The fit an ungraded (or malformed) pair ranks at: the middle, never the bottom. */
export const RELEVANCE_NEUTRAL_FIT = 0.5

export interface RankConfig {
  freshnessWeight: number
  decayDays: number
  relevanceWeight: number
  penalties: { unknownSeniority: number; unknownStack: number; unknownRemote: number }
  /**
   * Equal for every platform today (A1d). Scales the positive terms (freshness + relevance) so a
   * future per-platform weight cannot be confused with a penalty; 1 is the identity.
   */
  platformWeight: number
}

export const RANK_DEFAULTS: RankConfig = {
  freshnessWeight: 100,
  decayDays: 7,
  relevanceWeight: 300,
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
  /** Current-key Jev fit in [0,1]; null = not graded (ranks at RELEVANCE_NEUTRAL_FIT). */
  fit: number | null
  unknownSeniority: boolean
  unknownStack: boolean
  unknownRemote: boolean
}

export interface RankResult {
  score: number
  warnings: RankWarning[]
}

const isValidDate = (d: Date | null): d is Date => d !== null && !Number.isNaN(d.getTime())

export function rankScore(input: RankInput, config: RankConfig = RANK_DEFAULTS): RankResult {
  const warnings: RankWarning[] = []
  const evaluatedAt = input.evaluationTime.getTime()
  const firstSeenAt = input.firstSeenAt.getTime()
  // An invalid evaluation time makes every age unknowable; it must not leak NaN into a score.
  const evaluationValid = Number.isFinite(evaluatedAt)

  let publishedAt: number | null = null
  const published = input.trustedPublishedAt
  if (evaluationValid && isValidDate(published)) {
    if (published.getTime() > evaluatedAt) warnings.push('FUTURE_DATE')
    else publishedAt = published.getTime()
  }

  // A first-seen time recorded during the initial sweep says when WE first looked, not when the
  // posting appeared, so it cannot stand in for the age; an invalid one cannot either. A trusted
  // published date keeps its real age in both cases.
  const referenceAt =
    publishedAt ??
    (input.firstSeenKind === 'NORMAL' && Number.isFinite(firstSeenAt) ? firstSeenAt : null)

  let freshness = 0
  if (evaluationValid && referenceAt !== null) {
    const age = Math.max(0, (evaluatedAt - referenceAt) / MS_PER_DAY)
    freshness = config.freshnessWeight * Math.exp(-age / config.decayDays)
  } else {
    warnings.push('UNKNOWN_DATE')
  }

  const fit =
    input.fit !== null && Number.isFinite(input.fit)
      ? Math.min(1, Math.max(0, input.fit))
      : RELEVANCE_NEUTRAL_FIT
  const positive = (freshness + config.relevanceWeight * fit) * config.platformWeight

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

/** An invalid date sorts as the oldest possible, so the order stays total. */
const timeOf = (d: Date) => (Number.isNaN(d.getTime()) ? Number.NEGATIVE_INFINITY : d.getTime())

/** Descending (score, firstSeenAt, opportunityId): the total order generation pagination relies on. */
export function compareRanked(a: RankedRow, b: RankedRow): number {
  if (a.score !== b.score) return b.score - a.score
  const ta = timeOf(a.firstSeenAt)
  const tb = timeOf(b.firstSeenAt)
  // Only reached when they differ, so at most one is -Infinity and the difference is never NaN.
  if (ta !== tb) return tb - ta
  return (a.opportunityId < b.opportunityId ? 1 : 0) - (a.opportunityId > b.opportunityId ? 1 : 0)
}
