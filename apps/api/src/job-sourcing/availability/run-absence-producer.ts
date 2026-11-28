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
import { expiryWindowMsFor, feedDepthMsFor } from '../health/provider-facts'
import { RECORD_RELISTED_REASON, RUN_ABSENT_REASON_PREFIX } from '../ownership/dirty-work-reasons'
import type { SqlExecutor } from '../scheduling/host-state'

export { RUN_ABSENT_REASON_PREFIX }

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
  // CR-M-1, R3-CR-M-1: lock every listed record of the run in the house order first, held and
  // quarantined together, sorted once before chunking, so the run's locks as a whole follow
  // `byNaturalKey` (namespace, then identity key, by code unit), the order the observation writer
  // takes them in. A source's records can span namespaces (the record's namespace is the
  // observation's), so each key's namespace is read first, unlocked. The marks below then read the
  // locked rows in new statements (R2-CR-M-1 in `source-record.store`).
  const keys = [...new Set([...input.present.held, ...input.present.quarantined])]
  const natural: string[] = []
  for (let i = 0; i < keys.length; i += PRESENCE_CHUNK)
    natural.push(...(await naturalKeysOf(tx, input.sourceId, keys.slice(i, i + PRESENCE_CHUNK))))
  // The `byNaturalKey` sort key: namespace NUL identity key, so the string sort IS the tuple order.
  natural.sort()
  for (let i = 0; i < natural.length; i += PRESENCE_CHUNK)
    await lockChunk(tx, input.sourceId, natural.slice(i, i + PRESENCE_CHUNK))
  let held = 0
  for (let i = 0; i < input.present.held.length; i += PRESENCE_CHUNK)
    held += await markChunk(tx, input, input.present.held.slice(i, i + PRESENCE_CHUNK), true)
  for (let i = 0; i < input.present.quarantined.length; i += PRESENCE_CHUNK)
    await markChunk(tx, input, input.present.quarantined.slice(i, i + PRESENCE_CHUNK), false)
  return held
}

/** Keys per statement: bounds the jsonb parameter however long the listing is. */
const PRESENCE_CHUNK = 1000

const keyListOf = (keys: readonly string[]) =>
  sql`(SELECT jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb))`

/** `namespace NUL identity_key` of this source's records listed under `keys`. */
async function naturalKeysOf(
  tx: SqlExecutor,
  sourceId: string,
  keys: readonly string[],
): Promise<string[]> {
  const { rows } = await tx.execute(
    sql`SELECT r.namespace, r.identity_key FROM job_source_records r
         WHERE r.source_id = ${sourceId}::uuid AND r.identity_key IN ${keyListOf(keys)}`,
  )
  return rows.map((r) => `${String(r['namespace'])}\u0000${String(r['identity_key'])}`)
}

async function lockChunk(tx: SqlExecutor, sourceId: string, natural: readonly string[]) {
  const pairs = JSON.stringify(natural.map((k) => k.split('\u0000')))
  await tx.execute(
    sql`SELECT r.id FROM job_source_records r
         WHERE r.source_id = ${sourceId}::uuid
           AND (r.namespace, r.identity_key) IN
               (SELECT p ->> 0, p ->> 1 FROM jsonb_array_elements(${pairs}::jsonb) p)
         ORDER BY r.namespace COLLATE "C", r.identity_key COLLATE "C"
         FOR UPDATE`,
  )
}

async function markChunk(
  tx: SqlExecutor,
  input: { runId: string; sourceId: string; cycleId: string | null },
  keys: readonly string[],
  reopen: boolean,
): Promise<number> {
  const keyList = keyListOf(keys)
  const { rows } = await tx.execute(
    sql`WITH listed AS (
            SELECT r.id, r.latest_revision_id FROM job_source_records r
             WHERE r.source_id = ${input.sourceId}::uuid AND r.latest_revision_id IS NOT NULL
               AND r.identity_key IN ${keyList}
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
    const depth = feedDepthMsFor(input.sourceType)
    // CR-M-3: a posting older than the feed depth was outside the run's reach: no miss, no work.
    const reachable =
      depth === undefined
        ? sql``
        : sql` AND coalesce((SELECT rv.published_at FROM job_source_record_revisions rv
                              WHERE rv.id = r.latest_revision_id), r.first_seen_at)
                   > ${new Date(input.endedAt.getTime() - depth).toISOString()}::timestamptz`
    eligible = sql`r.availability NOT IN ('CLOSED', 'EXPIRED')
                   AND r.last_observed_at < ${seenBefore.toISOString()}::timestamptz
                   AND EXISTS (SELECT 1 FROM job_collection_runs cr
                                WHERE cr.id = ${input.runId}::uuid AND cr.received > 0)${reachable}`
    // An empty WINDOW run is no expiry miss (window-expiry-updater), so its work could never act.
  } else return 0
  const reason = `${RUN_ABSENT_REASON_PREFIX}${input.runId}`
  const { rows } = await tx.execute(
    sql`WITH picked AS (
        SELECT r.id, h.observation_seq AS seq
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
        ), rearmed AS (
        -- SR-M-2 / CR-H-2: a record re-arms its finished absence row instead of adding one per run,
        -- so the queue holds about one such row per record however many runs pass, and the rotation
        -- subquery above reads a bounded set through idx_job_dirty_work_entity. No DELETE needed.
        UPDATE job_dirty_work w
           SET target_version = t.seq, reason = ${reason}, cycle_id = ${input.cycleId}::uuid,
               status = 'PENDING', completed_at = NULL, retry_count = 0, last_error_code = NULL,
               created_at = clock_timestamp()
          FROM (SELECT DISTINCT ON (d.entity_id) d.id, p.seq
                  FROM picked p
                  JOIN job_dirty_work d ON d.entity_kind = 'SOURCE_RECORD' AND d.entity_id = p.id
                                       AND d.status = 'DONE'
                                       AND starts_with(d.reason, ${RUN_ABSENT_REASON_PREFIX})
                 ORDER BY d.entity_id, d.created_at DESC, d.id) t
         WHERE w.id = t.id
        RETURNING w.entity_id
        ), inserted AS (
        INSERT INTO job_dirty_work (entity_kind, entity_id, target_version, reason, cycle_id)
        SELECT 'SOURCE_RECORD', p.id, p.seq, ${reason}, ${input.cycleId}::uuid
          FROM picked p
         WHERE p.id NOT IN (SELECT entity_id FROM rearmed)
        ON CONFLICT (entity_kind, entity_id, target_version, reason) DO NOTHING
        RETURNING id
        )
        SELECT entity_id FROM rearmed UNION ALL SELECT id FROM inserted`,
  )
  return rows.length
}
