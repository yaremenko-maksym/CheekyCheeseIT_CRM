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

/** The median of a non-empty list, or null when there is nothing to take it of. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

/** A run's duration, or null while it is unfinished. */
function durationMs(run: RunFact): number | null {
  return run.endedAt === null ? null : run.endedAt.getTime() - run.startedAt.getTime()
}

/** Finished runs only, newest first — the base of every detector but the deadline one. */
function answered(s: HealthSnapshot): RunFact[] {
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
  if (baseline === null || baseline <= 0) return []

  const received24h = runs
    .filter((r) => s.now.getTime() - r.startedAt.getTime() <= DAY_MS)
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
  if (withCreated.length < 2) return []
  // newest first; gaps between consecutive new-item runs.
  const gaps: number[] = []
  for (let i = 0; i < withCreated.length - 1; i++) {
    gaps.push(withCreated[i]!.startedAt.getTime() - withCreated[i + 1]!.startedAt.getTime())
  }
  const medianGap = median(gaps)
  if (medianGap === null || medianGap <= 0) return []
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
  if (base.length < HEALTH_THRESHOLDS.emptyResponseRuns) return []
  const recentAllEmpty = base
    .slice(0, HEALTH_THRESHOLDS.emptyResponseRuns)
    .every((r) => r.received === 0)
  const baseline = median(base.map((r) => r.received))
  return recentAllEmpty && baseline !== null && baseline > 0 ? ['EMPTY_RESPONSE'] : []
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

  const latestDuration = durationMs(latest)
  const medianDuration = median(
    runs.map(durationMs).filter((d): d is number => d !== null && d > 0),
  )
  if (
    latestDuration !== null &&
    medianDuration !== null &&
    latestDuration > HEALTH_THRESHOLDS.slowdownGrowthMultiple * medianDuration
  ) {
    reasons.push('SLOW')
  }

  const medianBytes = median(
    runs.map((r) => r.bytesRead).filter((b): b is number => b !== null && b > 0),
  )
  if (
    latest.bytesRead !== null &&
    medianBytes !== null &&
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
  const newest = answered(s)
    .map((r) => r.newestItemPublishedAt)
    .filter((d): d is Date => d !== null)
    .reduce<Date | null>((max, d) => (max === null || d > max ? d : max), null)
  if (newest === null) return []
  return s.now.getTime() - newest.getTime() > s.freshnessMaxAgeMs ? ['STALE_FEED'] : []
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
