/**
 * Source-fetch-strategy U4 — the provenance the pass records on a health event: which runs bracket
 * a change, and the evidence JSON (observed metrics against the baseline). Kept schema-free so it
 * is unit-testable without loading the Drizzle schema graph (CR-M-3 / SPEC-M-2).
 */
import { durationMs, median } from './detectors'
import type { RunFact } from './types'

const DAY_MS = 24 * 60 * 60 * 1000

/** A run row as the pass reads it: the detector fields plus the provenance the event records. */
export interface PassRun extends RunFact {
  readonly errorMessage: string | null
}

/** The most recent run that brought items in and did not fail — the last good reading. */
export function lastGoodRunId(runs: readonly PassRun[]): string | null {
  return (
    runs.find((r) => r.received > 0 && (r.outcome === 'SUCCEEDED' || r.outcome === 'PARTIAL'))
      ?.runId ?? null
  )
}

/** The oldest run of the current head streak of bad readings (failed, or a non-304 empty). */
export function firstBadRunId(runs: readonly PassRun[]): string | null {
  const isBad = (r: PassRun): boolean =>
    r.outcome === 'FAILED' ||
    r.outcome === 'CANCELLED' ||
    (r.received === 0 && r.lastHttpStatus !== 304)
  let bad: string | null = null
  for (const r of runs) {
    if (!isBad(r)) break
    bad = r.runId
  }
  return bad
}

/**
 * The event's evidence: the observed metrics of the latest run against the source's own received
 * baseline, the reasons, the consecutive-failure count, and a per-reason observed-vs-baseline pair
 * for the threshold detectors (SLOW, PAYLOAD_GROWTH, VOLUME_DROP) that U5a alerts and the U7 source
 * page display (ADR section 10, SPEC-M-5). Small by construction, so always within the 8192-char
 * evidence CHECK.
 *
 * The `metrics` pairs mirror the comparisons the detectors make, so they must track
 * `detectSlowdownGrowth` and `detectVolumeDrop` — observed and baseline are recomputed here rather
 * than threaded out of the detectors, which the fix round scoped to this function.
 */
export function buildEvidence(
  runs: readonly PassRun[],
  reasons: readonly string[],
  consecutiveFailures: number,
  now: Date,
): Record<string, unknown> {
  const latest = runs[0]
  const fetchedReceived = runs
    .filter((r) => r.outcome === 'SUCCEEDED' || r.outcome === 'PARTIAL')
    .map((r) => r.received)
  return {
    reasons,
    consecutiveFailures,
    latestRunId: latest?.runId ?? null,
    observed: {
      received: latest?.received ?? null,
      bytesRead: latest?.bytesRead ?? null,
      httpStatus: latest?.lastHttpStatus ?? null,
      newestItemPublishedAt: latest?.newestItemPublishedAt?.toISOString() ?? null,
    },
    baseline: { receivedMedian: median(fetchedReceived) },
    metrics: reasonMetrics(runs, now),
  }
}

/**
 * Observed-vs-baseline for the three threshold detectors, each pair being the exact value the
 * detector compares. Mirrors `detectSlowdownGrowth` (finished runs, positive duration/byte medians)
 * and `detectVolumeDrop` (fetched+finished runs, 24h received sum vs same-weekday 14-day median).
 */
function reasonMetrics(runs: readonly PassRun[], now: Date): Record<string, unknown> {
  const finished = runs.filter((r) => r.endedAt !== null)
  const latestFinished = finished[0]

  // A finished run always has a numeric duration (`endedAt !== null`), so the `!` is safe and there
  // is no null guard to leave as an equivalent mutant — only the observable `> 0`.
  const positiveDurations = finished.map((r) => durationMs(r)!).filter((d) => d > 0)
  // A null bytes reading coalesces to 0 and is then dropped by `> 0` (same as the detector), so the
  // only guard here is the observable `> 0`.
  const positiveBytes = finished.map((r) => r.bytesRead ?? 0).filter((b) => b > 0)

  const fetchedFinished = finished.filter(
    (r) => r.outcome === 'SUCCEEDED' || r.outcome === 'PARTIAL',
  )
  const perDay = new Map<string, { received: number; weekday: number }>()
  for (const r of fetchedFinished) {
    const key = r.startedAt.toISOString().slice(0, 10)
    const entry = perDay.get(key) ?? { received: 0, weekday: r.startedAt.getUTCDay() }
    entry.received += r.received
    perDay.set(key, entry)
  }
  const todayKey = now.toISOString().slice(0, 10)
  const sameWeekdayReceived = [...perDay.entries()]
    .filter(([key, v]) => key !== todayKey && v.weekday === now.getUTCDay())
    .map(([, v]) => v.received)
  const received24h = fetchedFinished
    .filter((r) => now.getTime() - r.startedAt.getTime() < DAY_MS)
    .reduce((sum, r) => sum + r.received, 0)

  return {
    SLOW: {
      observedMs: latestFinished === undefined ? null : durationMs(latestFinished),
      baselineMs: median(positiveDurations),
    },
    PAYLOAD_GROWTH: {
      observedBytes: latestFinished?.bytesRead ?? null,
      baselineBytes: median(positiveBytes),
    },
    VOLUME_DROP: {
      observed24hReceived: received24h,
      baselineSameWeekdayMedian: median(sameWeekdayReceived),
    },
  }
}
