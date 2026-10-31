/**
 * Source-fetch-strategy U4 — the pure detectors (section 10's detector table).
 *
 * One function per row of the table. Each is pure over a `HealthSnapshot` (a source's 14-day
 * run window, newest first, plus its manifest facts) and returns the reasons it fires, or
 * `[]`. The pass assembles the snapshot from the database; nothing here touches it.
 *
 * All thresholds live in `HEALTH_THRESHOLDS` below — the one place section 10 says they live,
 * so they are tunable without a migration.
 */
import type { HealthReason, HealthSnapshot, RunFact } from './types'

/** The tunable thresholds (section 10, "confidence MED"). One module, no migration to change. */
export const HEALTH_THRESHOLDS = {
  /** Volume drop: 24 h `received` below this fraction of the same-weekday 14-day median. */
  volumeDropRatio: 0.3,
  /** …given at least this many distinct days of history. */
  volumeDropMinHistoryDays: 7,
  /** Silence: no new items for this multiple of the median gap between new items. */
  silenceGapMultiple: 4,
  /** Empty answer: `received = 0` (not a 304) on this many consecutive runs. */
  emptyResponseRuns: 2,
  /** Format drift: `invalid / received` above this fraction. */
  formatDriftInvalidRatio: 0.1,
  /** Slow / payload growth: duration or bytes over this multiple of the 14-day median. */
  slowdownGrowthMultiple: 3,
  /** Deadline: a policy deadline nearer than this is `DEADLINE_NEAR` (30 days). */
  deadlineNearMs: 30 * 24 * 60 * 60 * 1000,
} as const

const DAY_MS = 24 * 60 * 60 * 1000

/** The median of a non-empty list, or null when there is nothing to take it of. Exported for test. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

/** A run's duration, or null while it is unfinished. Exported for test. */
export function durationMs(run: RunFact): number | null {
  return run.endedAt === null ? null : run.endedAt.getTime() - run.startedAt.getTime()
}

/** Finished runs only, newest first — the base of every detector but the deadline one. Exported for test. */
export function answered(s: HealthSnapshot): RunFact[] {
  return s.runs.filter((r) => r.endedAt !== null)
}

/** A `304 Not Modified` run: a clean no-change answer, never an empty one (AC 4). */
function isNotModified(run: RunFact): boolean {
  return run.lastHttpStatus === 304
}

/**
 * Volume drop — `received` over 24 h below 30% of the 14-day median for the same weekday,
 * given at least 7 distinct days of history.
 */
export function detectVolumeDrop(s: HealthSnapshot): readonly HealthReason[] {
  const runs = answered(s)
  const perDay = new Map<string, { received: number; weekday: number }>()
  for (const run of runs) {
    const key = run.startedAt.toISOString().slice(0, 10)
    const entry = perDay.get(key) ?? { received: 0, weekday: run.startedAt.getUTCDay() }
    entry.received += run.received
    perDay.set(key, entry)
  }
  if (perDay.size < HEALTH_THRESHOLDS.volumeDropMinHistoryDays) return []

  const todayKey = s.now.toISOString().slice(0, 10)
  const todayWeekday = s.now.getUTCDay()
  const sameWeekdayPast = [...perDay.entries()]
    .filter(([key, v]) => key !== todayKey && v.weekday === todayWeekday)
    .map(([, v]) => v.received)
  const baseline = median(sameWeekdayPast)
  // Stryker disable next-line all: a readability guard with no observable effect — a null or
  // non-positive baseline already yields [] at the comparison below (0.3 * null === 0 in JS, and
  // received24h is a sum of non-negative counts, so `received24h < 0` is false either way).
  if (baseline === null || baseline <= 0) return []

  const received24h = runs
    .filter((r) => s.now.getTime() - r.startedAt.getTime() < DAY_MS)
    .reduce((sum, r) => sum + r.received, 0)
  return received24h < HEALTH_THRESHOLDS.volumeDropRatio * baseline ? ['VOLUME_DROP'] : []
}

/**
 * Silence — no `created` for 4× the source's median gap between new items, while `received`
 * is still above 0 (the feed answers, but nothing in it is new).
 */
export function detectSilence(s: HealthSnapshot): readonly HealthReason[] {
  const runs = answered(s)
  const withCreated = runs.filter((r) => r.created > 0)
  // Stryker disable next-line ConditionalExpression: with fewer than two new-item runs the gap
  // list below is empty and the `medianGap <= 0` guard returns [] regardless, so skipping this
  // early return changes nothing; it is kept because reading `withCreated[0]` later assumes a run.
  if (withCreated.length < 2) return []
  // newest first; the gap between each consecutive pair of new-item runs.
  const gaps = withCreated
    .slice(1)
    .map((r, i) => withCreated[i]!.startedAt.getTime() - r.startedAt.getTime())
  // `withCreated.length >= 2` guarantees at least one gap, so the median is a number.
  const medianGap = median(gaps)!
  if (medianGap <= 0) return []
  const sinceLastNew = s.now.getTime() - withCreated[0]!.startedAt.getTime()
  const stillReceiving = runs.some((r) => r.received > 0)
  return sinceLastNew > HEALTH_THRESHOLDS.silenceGapMultiple * medianGap && stillReceiving
    ? ['NO_NEW_ITEMS']
    : []
}

/**
 * Empty answer — `received = 0` (not a 304) on the two most recent runs of a source whose
 * 14-day median is above 0. A 304 run is filtered out before the window is read (AC 4).
 */
export function detectEmptyResponse(s: HealthSnapshot): readonly HealthReason[] {
  const base = answered(s).filter((r) => !isNotModified(r))
  // Stryker disable next-line ConditionalExpression,EqualityOperator: EMPTY_RESPONSE can only fire
  // when the 14-day median is above 0, which needs at least one non-empty run in addition to the two
  // recent empties — so firing always has base.length >= 3 and this length-2 boundary is never the
  // deciding factor; the guard stays only to bound `.slice(0, 2)` meaningfully.
  if (base.length < HEALTH_THRESHOLDS.emptyResponseRuns) return []
  const recentAllEmpty = base
    .slice(0, HEALTH_THRESHOLDS.emptyResponseRuns)
    .every((r) => r.received === 0)
  // `base` is non-empty here (the guard above), so the median is a number.
  const baseline = median(base.map((r) => r.received))!
  return recentAllEmpty && baseline > 0 ? ['EMPTY_RESPONSE'] : []
}

/**
 * Format drift — an ending `PARSE_DRIFT`, `invalid / received` above 10%, or a changed
 * `envelope_fingerprint` between the two most recent runs that carried one.
 */
export function detectFormatDrift(s: HealthSnapshot): readonly HealthReason[] {
  const runs = answered(s)
  const latest = runs[0]
  if (latest === undefined) return []
  const parseDrift = latest.errorCode === 'PARSE_DRIFT'
  const invalidUp =
    latest.received > 0 &&
    latest.invalid / latest.received > HEALTH_THRESHOLDS.formatDriftInvalidRatio
  const fingerprints = runs
    .filter((r) => r.envelopeFingerprint !== null)
    .map((r) => r.envelopeFingerprint)
  const fingerprintChanged = fingerprints.length >= 2 && fingerprints[0] !== fingerprints[1]
  return parseDrift || invalidUp || fingerprintChanged ? ['SCHEMA_DRIFT'] : []
}

/**
 * Access change — the latest answered status is 401 / 403 / 451 (`ACCESS_CHANGED`) or 429
 * (`THROTTLED`; a 429 also pauses the host elsewhere).
 */
export function detectAccessChange(s: HealthSnapshot): readonly HealthReason[] {
  const latest = answered(s).find((r) => r.lastHttpStatus !== null)
  const status = latest?.lastHttpStatus
  if (status === 401 || status === 403 || status === 451) return ['ACCESS_CHANGED']
  if (status === 429) return ['THROTTLED']
  return []
}

/**
 * Slowdown and payload growth — the latest run's duration (`SLOW`) or `bytes_read`
 * (`PAYLOAD_GROWTH`) over 3× the 14-day median.
 */
export function detectSlowdownGrowth(s: HealthSnapshot): readonly HealthReason[] {
  const runs = answered(s)
  const latest = runs[0]
  if (latest === undefined) return []
  const reasons: HealthReason[] = []

  // `runs` are finished, so every duration is a number (no null branch to leave untested).
  const duration = (r: RunFact): number => r.endedAt!.getTime() - r.startedAt.getTime()
  const medianDuration = median(runs.map(duration).filter((d) => d > 0))
  // Stryker disable ConditionalExpression,LogicalOperator: a null median means no positive-duration
  // history, and then the latest run's own duration is 0 too, so bypassing the null guard yields
  // `0 > 0` = false — no observable effect. Only the `>` comparison is behavioural, and it is pinned
  // by the 3x-boundary and zero-duration tests. (A block, not `next-line`: prettier re-wraps the if.)
  if (
    medianDuration !== null &&
    duration(latest) > HEALTH_THRESHOLDS.slowdownGrowthMultiple * medianDuration
  )
    reasons.push('SLOW')
  // Stryker restore ConditionalExpression,LogicalOperator

  const positiveBytes = runs
    .map((r) => r.bytesRead)
    // Stryker disable next-line ConditionalExpression: equivalent — the `> 0` filter below already
    // drops null (`null > 0` is false), so whether this null filter runs or not the result is the
    // same. It exists only to narrow the type for the comparison that follows.
    .filter((b): b is number => b !== null)
    .filter((b) => b > 0)
  const medianBytes = median(positiveBytes)
  // Stryker disable ConditionalExpression,LogicalOperator: a null latest `bytesRead` coerces to 0
  // (`null > x` is false), and a null median means no positive-byte history — which, since the
  // latest is itself in `runs`, implies the latest had no bytes either, so both null guards are
  // unobservable. The `>` comparison is behavioural and is pinned by a test.
  if (
    latest.bytesRead !== null &&
    medianBytes !== null &&
    latest.bytesRead > HEALTH_THRESHOLDS.slowdownGrowthMultiple * medianBytes
  )
    reasons.push('PAYLOAD_GROWTH')
  // Stryker restore ConditionalExpression,LogicalOperator
  return reasons
}

/**
 * Stale answer — the freshest `newest_item_published_at` we have seen is older than the
 * provider's own delay allows.
 */
export function detectStaleFeed(s: HealthSnapshot): readonly HealthReason[] {
  if (s.freshnessMaxAgeMs === null) return []
  const seen = answered(s)
    .map((r) => r.newestItemPublishedAt)
    .filter((d): d is Date => d !== null)
  if (seen.length === 0) return []
  // The freshest item across every run — `Math.max` over the instants, so there is no comparison
  // operator to leave half-tested (`seen` is non-empty).
  const newest = Math.max(...seen.map((d) => d.getTime()))
  return s.now.getTime() - newest > s.freshnessMaxAgeMs ? ['STALE_FEED'] : []
}

/**
 * Board gone — an employer board answers 404 or zero jobs now, after having had some.
 */
export function detectBoardGone(s: HealthSnapshot): readonly HealthReason[] {
  if (!s.isEmployerBoard) return []
  const runs = answered(s)
  const latest = runs[0]
  if (latest === undefined) return []
  const goneNow = latest.lastHttpStatus === 404 || latest.received === 0
  const hadSome = runs.slice(1).some((r) => r.received > 0)
  return goneNow && hadSome ? ['BOARD_GONE'] : []
}

/**
 * Deadline — a policy deadline less than 30 days away (but not yet passed; a passed deadline
 * is a BLOCKED cause the pass computes, not a detector reason).
 */
export function detectDeadlineNear(s: HealthSnapshot): readonly HealthReason[] {
  if (s.policyDeadline === null) return []
  const remaining = s.policyDeadline.getTime() - s.now.getTime()
  return remaining > 0 && remaining < HEALTH_THRESHOLDS.deadlineNearMs ? ['DEADLINE_NEAR'] : []
}

/** Every detector of section 10, in table order. */
const DETECTORS: readonly ((s: HealthSnapshot) => readonly HealthReason[])[] = [
  detectVolumeDrop,
  detectSilence,
  detectEmptyResponse,
  detectFormatDrift,
  detectAccessChange,
  detectSlowdownGrowth,
  detectStaleFeed,
  detectBoardGone,
  detectDeadlineNear,
]

/** Run every detector over the snapshot and return the distinct reasons that fired. */
export function runDetectors(s: HealthSnapshot): HealthReason[] {
  const fired = new Set<HealthReason>()
  for (const detector of DETECTORS) for (const reason of detector(s)) fired.add(reason)
  return [...fired]
}
