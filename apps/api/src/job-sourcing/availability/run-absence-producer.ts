/**
 * Backlog 470: the producer that hands the availability worker the records a run did NOT see.
 *
 * Before it, the only `AVAILABILITY:*` work came from a record whose head advanced
 * (`source-record.store.ts`), i.e. a record the run DID see; a posting taken down at the source is
 * never observed again, so nothing ever asked the D4 counter or the WINDOW expiry about it and no
 * absence closure could fire, whatever the run's coverage.
 *
 * Called by the ledger's `endRun`, in the transaction that writes the run's terminal row, so the
 * work exists exactly when the SUCCEEDED row with its coverage does. It decides nothing itself:
 * the consumers re-read the run history and apply D4 (3 misses over >= 24 h, the >50% drop guard)
 * or the expiry window. It only enqueues:
 *
 *   - FULL_INVENTORY: every record of this source, not CLOSED, with no `job_run_records` row for
 *     this run;
 *   - WINDOW: the same, minus EXPIRED records and records seen within the type's expiry window
 *     (those cannot expire yet, so enqueueing them is pure queue load);
 *   - anything else (PARTIAL, or a non-SUCCEEDED ending): nothing. A failed or truncated run never
 *     produces closure work.
 *
 * The reason carries the run id (the `RECORD_RELISTED:<runId>` precedent): an absent record's head
 * does not move, so a fixed reason would collide on `(kind, entity, target_version, reason)` with
 * the previous run's row and the counter could never reach its third miss.
 */
import type { JobCollectionCoverage, JobCollectionOutcome } from '@crm/shared'
import { sql } from 'drizzle-orm'
import { expiryWindowMsFor } from '../health/provider-facts'
import { AVAILABILITY_REASON_PREFIX } from '../ownership/dirty-work.store'
import type { SqlExecutor } from '../scheduling/host-state'
import type { JobSourceType } from '@crm/shared'

/** `job_dirty_work.reason` prefix of a run's absence work; the run id follows (<= 100 chars). */
export const RUN_ABSENT_REASON_PREFIX = `${AVAILABILITY_REASON_PREFIX}RUN_ABSENT:`

export interface RunAbsenceInput {
  readonly runId: string
  readonly sourceId: string
  readonly sourceType: JobSourceType
  readonly cycleId: string | null
  readonly outcome: JobCollectionOutcome
  readonly coverage: JobCollectionCoverage
  /** The run's `ended_at`: the instant the WINDOW age is measured from. */
  readonly endedAt: Date
}

/** Enqueue the run's absent records for the availability worker; returns how many rows it added. */
export async function enqueueRunAbsentRecords(
  tx: SqlExecutor,
  input: RunAbsenceInput,
): Promise<number> {
  if (input.outcome !== 'SUCCEEDED') return 0
  let eligible
  if (input.coverage === 'FULL_INVENTORY') eligible = sql`r.availability <> 'CLOSED'`
  else if (input.coverage === 'WINDOW') {
    const seenBefore = new Date(input.endedAt.getTime() - expiryWindowMsFor(input.sourceType))
    eligible = sql`r.availability NOT IN ('CLOSED', 'EXPIRED')
                   AND r.last_observed_at < ${seenBefore.toISOString()}::timestamptz`
  } else return 0
  const { rows } = await tx.execute(
    sql`INSERT INTO job_dirty_work (entity_kind, entity_id, target_version, reason, cycle_id)
        SELECT 'SOURCE_RECORD', r.id, h.observation_seq, ${`${RUN_ABSENT_REASON_PREFIX}${input.runId}`},
               ${input.cycleId}::uuid
          FROM job_source_records r
          JOIN job_source_record_heads h ON h.source_record_id = r.id
         WHERE r.source_id = ${input.sourceId}::uuid AND ${eligible}
           AND NOT EXISTS (SELECT 1 FROM job_run_records jr
                            WHERE jr.run_id = ${input.runId}::uuid AND jr.source_record_id = r.id)
        ON CONFLICT (entity_kind, entity_id, target_version, reason) DO NOTHING
        RETURNING id`,
  )
  return rows.length
}
