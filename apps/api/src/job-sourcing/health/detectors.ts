/**
 * Source-fetch-strategy U4 — the pure detectors (section 10's detector table).
 *
 * One function per row of the table. Each is pure over a `HealthSnapshot` (a source's 14-day
 * run window, newest first, plus its manifest facts) and returns the reasons it fires, or
 * `[]`. The pass assembles the snapshot from the database; nothing here touches it.
 *
 * All thresholds live in `HEALTH_THRESHOLDS` below — the one place section 10 says they live,
 * so they are tunable without a migration.
 *
 * `outcome` matters (CR-M-1): a FAILED or CANCELLED run is not an empty answer, is not a board
 * going quiet, and must not deflate the volume baseline. "Received volume" and "a clean empty
 * answer" are read from runs that actually fetched (`SUCCEEDED` / `PARTIAL`), never from failures.
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

/** Runs that actually fetched data: a clean or partial success. Failures never count as volume. */
function fetched(runs: readonly RunFact[]): RunFact[] {
  return runs.filter((r) => r.outcome === 'SUCCEEDED' || r.outcome === 'PARTIAL')
}

/** A clean complete fetch — the only run that can be a genuine "empty answer". */
function isSuccess(run: RunFact): boolean {
  return run.outcome === 'SUCCEEDED'
}

/** A `304 Not Modified` run: a clean no-change answer, never an empty one (AC 4). */
function isNotModified(run: RunFact): boolean {
  return run.lastHttpStatus === 304
}

/**
 * Volume drop — `received` over 24 h below 30% of the 14-day median for the same weekday,
 * given at least 7 distinct days of history. Only fetched runs count: a failed run brings back
 * nothing and must not deflate the baseline (CR-M-1).
 */
export function detectVolumeDrop(s: HealthSnapshot): readonly HealthReason[] {
  const runs = fetched(answered(s))
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
  // Stryker disable next-line ConditionalExpression: only the "never return" direction is equivalent — a null baseline then reaches `received24h < 0.3 * null` which is `< 0`, false for a non-negative sum, so it yields [] anyway (the guard is a type-checker narrowing). The `===`→`!==` EqualityOperator and the 30% comparison stay live and are pinned by the no-baseline and 29/30 tests.
  if (baseline === null) return []

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
  // Stryker disable next-line ConditionalExpression: with fewer than two new-item runs the gap list below is empty and the `medianGap <= 0` guard returns [] regardless, so skipping this early return changes nothing; it is kept because `withCreated[0]` later assumes a run. The `< 2` boundary is pinned by the one-run and two-run tests.
  if (withCreated.length < 2) return []
  // newest first; the gap between each consecutive pair of new-item runs.
  const gaps = withCreated
    .slice(1)
    .map((r, i) => withCreated[i]!.startedAt.getTime() - r.startedAt.getTime())
  // `withCreated.length >= 2` guarantees at least one gap, so the median is a number.
  const medianGap = median(gaps)!
  if (medianGap <= 0) return []
  const sinceLastNew = s.now.getTime() - withCreated[0]!.startedAt.getTime()
  const stillReceiving = fetched(runs).some((r) => r.received > 0)
  return sinceLastNew > HEALTH_THRESHOLDS.silenceGapMultiple * medianGap && stillReceiving
    ? ['NO_NEW_ITEMS']
    : []
}

/**
 * Empty answer — a clean fetch (`SUCCEEDED`) that returned `received = 0` (not a 304) on the two
 * most recent such runs, of a source whose 14-day median is above 0. A FAILED run is not an empty
 * answer, so only successes are read (CR-M-1); a 304 is filtered out (AC 4).
 */
export function detectEmptyResponse(s: HealthSnapshot): readonly HealthReason[] {
  const base = answered(s).filter((r) => isSuccess(r) && !isNotModified(r))
  // Stryker disable next-line ConditionalExpression,EqualityOperator: EMPTY_RESPONSE needs a 14-day median above 0, i.e. at least one non-empty success beyond the two empties, so firing always has base.length >= 3 — this length-2 boundary never decides. It bounds `.slice(0, 2)` meaningfully.
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
 * `envelope_fingerprint` between the two most recent runs that carried one. Read off the latest
 * answered run (a failed parse is itself drift, so no outcome filter here).
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
  // Stryker disable next-line ConditionalExpression: equivalent — with no runs the medians below are null, both baseline checks are false, and `latest` is only read when a median exists, so the function returns [] whether this early return runs or not. It is a type-checker narrowing for `latest`.
  if (latest === undefined) return []
  const reasons: HealthReason[] = []
  const dur = (r: RunFact): number => r.endedAt!.getTime() - r.startedAt.getTime()

  const medianDuration = median(runs.map(dur).filter((d) => d > 0))
  if (
    medianDuration !== null &&
    dur(latest) > HEALTH_THRESHOLDS.slowdownGrowthMultiple * medianDuration
  ) {
    reasons.push('SLOW')
  }

  const positiveBytes = runs.map((r) => r.bytesRead).filter((b): b is number => b !== null && b > 0)
  const medianBytes = median(positiveBytes)
  if (
    medianBytes !== null &&
    latest.bytesRead !== null &&
    latest.bytesRead > HEALTH_THRESHOLDS.slowdownGrowthMultiple * medianBytes
  ) {
    reasons.push('PAYLOAD_GROWTH')
  }
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
 * Board gone — an employer board answers 404, or a clean fetch returns zero jobs, now, after
 * having had some. A FAILED latest run (a transient error) is not a board going quiet (CR-M-1).
 */
export function detectBoardGone(s: HealthSnapshot): readonly HealthReason[] {
  if (!s.isEmployerBoard) return []
  const runs = answered(s)
  const latest = runs[0]
  if (latest === undefined) return []
  const goneNow = latest.lastHttpStatus === 404 || (isSuccess(latest) && latest.received === 0)
  const hadSome = fetched(runs.slice(1)).some((r) => r.received > 0)
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
