import type { StructurerOutcome } from '../../structuring/html-structurer.port'
import type { EnrichmentRecord } from './html-ports'

const HOUR_MS = 60 * 60 * 1000
const LONGEST_MODEL_BACKOFF_MS = 24 * HOUR_MS
/** When a record-caused failure is due again after its 1st and 2nd time; the 3rd parks it. */
const MODEL_BACKOFF_MS: readonly number[] = [6 * HOUR_MS, LONGEST_MODEL_BACKOFF_MS]

/**
 * What one model pass means for one record (ADR §5.4, the outcome table).
 * - CLEARED: answered (a page that gave no fields too), or a configuration state or a decision.
 * - RECORD_CAUSED: this record's reply was unusable while another record's was fine.
 * - OWED: not the record's fault. Never counts, so an outage or a stop parks nothing.
 * - TIMED_OUT: OWED, and the call in flight when the pass timed out: offered last from now on.
 */
export type ModelSettlement = 'CLEARED' | 'RECORD_CAUSED' | 'OWED' | 'TIMED_OUT'

const allOf = (ids: readonly string[], settlement: ModelSettlement): Map<string, ModelSettlement> =>
  new Map(ids.map((id) => [id, settlement]))

/** `outcome` is null when the structurer threw. */
export function settlementsOf(
  outcome: StructurerOutcome | null,
  ids: readonly string[],
): Map<string, ModelSettlement> {
  if (outcome === null) return allOf(ids, 'OWED')
  if (outcome.kind === 'SKIPPED_AI_INPUT_NO' || outcome.kind === 'SKIPPED_AI_INPUT_UNSPECIFIED') {
    return allOf(ids, 'CLEARED')
  }
  const stop = outcome.kind === 'PARTIAL' ? outcome.stoppedBy : outcome
  if ('code' in stop && stop.code === 'NOT_CONFIGURED') return allOf(ids, 'CLEARED')

  const owed = new Set('remainingIds' in outcome ? outcome.remainingIds : null)
  const failed = new Set(
    outcome.perRecordIssues.filter(({ failure }) => failure !== null).map(({ id }) => id),
  )
  // Nothing succeeded: a bad runtime or digest answers that way on every record, so none is blamed.
  const anyAnswered = ids.some((id) => !owed.has(id) && !failed.has(id))
  // A stop leaves the record it stopped on first in `remainingIds`.
  const timedOut = stop.kind === 'EXTRACTOR_FAILED' && stop.code === 'TIMEOUT'
  const inFlight = timedOut && 'remainingIds' in outcome ? outcome.remainingIds[0] : undefined

  const of = (id: string): ModelSettlement => {
    if (id === inFlight) return 'TIMED_OUT'
    if (owed.has(id)) return 'OWED'
    if (!failed.has(id)) return 'CLEARED'
    return anyAnswered ? 'RECORD_CAUSED' : 'OWED'
  }
  return new Map(ids.map((id) => [id, of(id)]))
}

/** The record after a pass. `modelAttempts` counts only record-caused failures in a row. */
export function settledRecord(
  record: EnrichmentRecord,
  settlement: ModelSettlement,
  revisitAfterMs: number,
): EnrichmentRecord {
  const dueAfter = (ms: number): Date => new Date(record.lastAttemptAt.getTime() + ms)
  if (settlement === 'CLEARED') {
    return {
      ...record,
      modelPending: false,
      modelAttempts: 0,
      modelOfferLast: false,
      nextDueAt: dueAfter(revisitAfterMs),
    }
  }
  if (settlement === 'RECORD_CAUSED') {
    const modelAttempts = record.modelAttempts + 1
    const backoff = MODEL_BACKOFF_MS[modelAttempts - 1]
    return {
      ...record,
      modelPending: backoff !== undefined,
      modelAttempts,
      modelOfferLast: false,
      nextDueAt: dueAfter(backoff ?? revisitAfterMs),
    }
  }
  return {
    ...record,
    modelPending: true,
    // Kept while owed: two slow pages taking turns at the front would still block the rest.
    modelOfferLast: settlement === 'TIMED_OUT' || record.modelOfferLast === true,
    nextDueAt: dueAfter(LONGEST_MODEL_BACKOFF_MS),
  }
}

/** True when this settlement of this record parks it until its content changes. */
export function parks(record: EnrichmentRecord, settlement: ModelSettlement): boolean {
  return settlement === 'RECORD_CAUSED' && record.modelAttempts + 1 > MODEL_BACKOFF_MS.length
}
