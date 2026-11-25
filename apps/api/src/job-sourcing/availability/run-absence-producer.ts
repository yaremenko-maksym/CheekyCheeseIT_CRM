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
import type { JobCollectionCoverage, JobCollectionOutcome, JobSourceType } from '@crm/shared'
import { sql } from 'drizzle-orm'
import { expiryWindowMsFor } from '../health/provider-facts'
import { AVAILABILITY_REASON_PREFIX } from '../ownership/dirty-work-reasons'
import type { SqlExecutor } from '../scheduling/host-state'
import { RECORD_RELISTED_REASON } from '../store/source-record.store'

/** `job_dirty_work.reason` prefix of a run's absence work; the run id follows (<= 100 chars). */
export const RUN_ABSENT_REASON_PREFIX = `${AVAILABILITY_REASON_PREFIX}RUN_ABSENT:`

/** Postings a run saw listed and did not keep (see `RunEnding.present`). */
export interface RunPresence {
  readonly held: readonly string[]
  readonly quarantined: readonly string[]
}

/**
 * Mark the listed-but-not-kept postings present in this run: a `job_run_records` row at the
 * record's latest revision and a fresh `last_observed_at`, for the records of THIS source only.
 * Without it the absence paths would read a held or quarantined posting as gone. Returns how many
 * `held` records it newly marked, the number the run row adds to `received` and `unchanged`.
 *
 * Matched by `source_id`, while `heldIdentityKeys` matches `(source_type, namespace)`: a key held
 * by a sibling source's record is not marked here, and it cannot be closed by this run either,
 * because `enqueueRunAbsentRecords` scans this source's records only. The sibling's own runs judge it.
 */
export async function markListedPresent(
  tx: SqlExecutor,
  input: { runId: string; sourceId: string; cycleId: string | null; present: RunPresence },
): Promise<number> {
  let held = 0
  for (let i = 0; i < input.present.held.length; i += PRESENCE_CHUNK)
    held += await markChunk(tx, input, input.present.held.slice(i, i + PRESENCE_CHUNK), true)
  for (let i = 0; i < input.present.quarantined.length; i += PRESENCE_CHUNK)
    await markChunk(tx, input, input.present.quarantined.slice(i, i + PRESENCE_CHUNK), false)
  return held
}

/** Keys per statement: bounds the jsonb parameter however long the listing is. */
const PRESENCE_CHUNK = 1000

async function markChunk(
  tx: SqlExecutor,
  input: { runId: string; sourceId: string; cycleId: string | null },
  keys: readonly string[],
  reopen: boolean,
): Promise<number> {
  const { rows } = await tx.execute(
    sql`WITH listed AS (
            SELECT r.id, r.latest_revision_id FROM job_source_records r
             WHERE r.source_id = ${input.sourceId}::uuid AND r.latest_revision_id IS NOT NULL
               AND r.identity_key IN (SELECT jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb))
          ), marked AS (
            INSERT INTO job_run_records (run_id, source_record_id, revision_id)
            SELECT ${input.runId}::uuid, id, latest_revision_id FROM listed
            ON CONFLICT (run_id, source_record_id) DO NOTHING
            RETURNING source_record_id
          )
          UPDATE job_source_records r SET last_observed_at = clock_timestamp(), updated_at = clock_timestamp()
            FROM marked WHERE r.id = marked.source_record_id
          RETURNING r.id`,
  )
  // S8f: a CLOSED/EXPIRED posting listed again must reopen, as an observed one does
  // (`saveObservationPage`); without this row a held posting would stay closed while present.
  // A quarantined listing is present (never absent) but is no proof of a live vacancy: no reopen.
  const ids = rows.map((r) => String(r['id']))
  if (reopen && ids.length > 0)
    await tx.execute(
      sql`INSERT INTO job_dirty_work (entity_kind, entity_id, target_version, reason, cycle_id)
            SELECT 'SOURCE_RECORD', r.id, h.observation_seq, ${`${RECORD_RELISTED_REASON}:${input.runId}`},
                   ${input.cycleId}::uuid
              FROM job_source_records r
              JOIN job_source_record_heads h ON h.source_record_id = r.id
             WHERE r.id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)
               AND r.availability IN ('CLOSED', 'EXPIRED')
            ON CONFLICT (entity_kind, entity_id, target_version, reason) DO NOTHING`,
    )
  return rows.length
}

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

/**
 * Rows one run may enqueue, so the statement stays short while `endRun` holds the source, meter and
 * run locks. The rest carry over: a record still absent is picked up by a later run, once the first
 * ones close (CLOSED leaves the scan), are still PENDING (skipped), or were queued more recently
 * (the order puts the least recently queued first). It stays inside `endRun`'s transaction so the
 * work exists exactly when the run row with its coverage does.
 */
export const ABSENT_PER_RUN = 1000

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
                   AND r.last_observed_at < ${seenBefore.toISOString()}::timestamptz
                   AND EXISTS (SELECT 1 FROM job_collection_runs cr
                                WHERE cr.id = ${input.runId}::uuid AND cr.received > 0)`
    // An empty WINDOW run is no expiry miss (window-expiry-updater), so its work could never act.
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
           -- One PENDING absence row per record is enough: the worker folds every run since its
           -- watermark, so a record still waiting from an earlier run is not queued again.
           AND NOT EXISTS (SELECT 1 FROM job_dirty_work w
                            WHERE w.entity_kind = 'SOURCE_RECORD' AND w.entity_id = r.id
                              AND w.status = 'PENDING'
                              AND starts_with(w.reason, ${RUN_ABSENT_REASON_PREFIX}))
         -- Rotate fairly: the record queued longest ago (or never) goes first, so a block that keeps
         -- re-qualifying (drop-guard review, EXPIRED) cannot starve the records past the cap.
         ORDER BY (SELECT max(w.created_at) FROM job_dirty_work w
                    WHERE w.entity_kind = 'SOURCE_RECORD' AND w.entity_id = r.id
                      AND starts_with(w.reason, ${RUN_ABSENT_REASON_PREFIX})) ASC NULLS FIRST, r.id
         LIMIT ${ABSENT_PER_RUN}
        ON CONFLICT (entity_kind, entity_id, target_version, reason) DO NOTHING
        RETURNING id`,
  )
  return rows.length
}
