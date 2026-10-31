/**
 * Source-fetch-strategy U4 — the provenance the pass records on a health event: which runs bracket
 * a change, and the evidence JSON (observed metrics against the baseline). Kept schema-free so it
 * is unit-testable without loading the Drizzle schema graph (CR-M-3 / SPEC-M-2).
 */
import { median } from './detectors'
import type { RunFact } from './types'

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
 * baseline, plus the reasons and the consecutive-failure count (ADR section 10). Small by
 * construction, so always within the 8192-char evidence CHECK.
 */
export function buildEvidence(
  runs: readonly PassRun[],
  reasons: readonly string[],
  consecutiveFailures: number,
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
  }
}
