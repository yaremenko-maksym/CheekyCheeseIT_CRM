import { sql } from 'drizzle-orm'
import type { MeterDb } from '../metering/account-meter.store'
import type { SourceObservation } from '../normalize/observation'
import type { SavedPage } from '../ownership/job-run-ledger'
import { type OwnedRun, type RunHandle, assertOwned } from '../ownership/run-ownership'
import { validatedCheckpointSchema } from '../providers/reporting-provider'
import type { SqlExecutor } from '../scheduling/host-state'
import { byNaturalKey, withLockRetry } from './lock-order'
import { revisionPayload } from './record-payload'

/**
 * The observation store (r5 Task 4.5): one source record per (provider, namespace, identity
 * key), its immutable revisions, run membership and the dirty work a new revision produces.
 *
 * Every write path starts with `assertOwned` (ADR 2026-10-24, "Operations"): a fenced executor
 * gets `RunFencedError` and its transaction writes nothing. Short READ COMMITTED transactions;
 * records are locked in ascending (namespace, identity key) — the `savePage` row of the ADR's
 * lock-acquisition table, which this store extends rather than changes.
 *
 * `saveObservations` is the tx-level seam Task 4.6 calls inside `savePage`'s own transaction;
 * `saveObservationPage` is the stand-alone page write (observations + checkpoint, one tx).
 */

const READ_COMMITTED = { isolationLevel: 'read committed' } as const
/** Attempts to find the record after `ON CONFLICT DO NOTHING` returned no row. */
const RECORD_ATTEMPTS = 3
/** `job_dirty_work.reason` of a new latest revision. */
export const SOURCE_REVISION_REASON = 'SOURCE_REVISION'

/** The record could be neither inserted nor read back: a concurrent delete, every attempt. */
export class RecordUnavailableError extends Error {
  readonly code = 'RECORD_UNAVAILABLE' as const

  constructor() {
    super('the source record was neither inserted nor visible after bounded retries')
    this.name = 'RecordUnavailableError'
  }
}

export interface SavedObservation {
  recordId: string
  revisionId: string
  receivedSeq: number
  createdRecord: boolean
  createdRevision: boolean
  /** The revision became the record's latest (and dirty work was enqueued for it). */
  advanced: boolean
}

type Row = Record<string, unknown>

async function sourceTypeOf(tx: SqlExecutor, owned: OwnedRun): Promise<unknown> {
  const { rows } = await tx.execute(
    sql`SELECT type FROM job_sources WHERE id = ${owned.sourceId}::uuid`,
  )
  return rows[0]?.['type']
}

/** Step 2: the record's id, inserting it if new. No CTE-visibility assumption. */
async function recordIdFor(
  tx: SqlExecutor,
  o: SourceObservation,
  sourceUrl: string,
  applicationUrl: string | null,
): Promise<{ id: string; created: boolean }> {
  const id = o.identity
  for (let attempt = 1; attempt <= RECORD_ATTEMPTS; attempt += 1) {
    const { rows } = await tx.execute(
      sql`INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key, source_url, application_url)
          VALUES (${id.provider}::job_source_type, ${id.namespace}, ${id.identityKind}::job_identity_kind,
                  ${id.identityKey}, ${sourceUrl}, ${applicationUrl})
          ON CONFLICT (source_type, namespace, identity_key) DO NOTHING
          RETURNING id`,
    )
    if (rows[0] !== undefined) return { id: String(rows[0]['id']), created: true }
    // A separate statement: under READ COMMITTED it sees the winner the INSERT waited for.
    const { rows: found } = await tx.execute(
      sql`SELECT id FROM job_source_records
           WHERE source_type = ${id.provider}::job_source_type AND namespace = ${id.namespace}
             AND identity_key = ${id.identityKey}`,
    )
    if (found[0] !== undefined) return { id: String(found[0]['id']), created: false }
  }
  throw new RecordUnavailableError()
}

/** Steps 2–7 for one observation, inside the caller's transaction, ownership already asserted. */
async function writeObservation(
  tx: SqlExecutor,
  owned: OwnedRun,
  o: SourceObservation,
): Promise<SavedObservation> {
  const p = revisionPayload(o)
  const record = await recordIdFor(tx, o, p.sourceUrl, p.applicationUrl)

  // 3. Lock the record; read its latest revision's arrival order under the lock.
  const { rows: locked } = await tx.execute(
    sql`SELECT v.received_seq AS latest_seq
          FROM job_source_records r
          LEFT JOIN job_source_record_revisions v ON v.id = r.latest_revision_id
         WHERE r.id = ${record.id}::uuid
           FOR UPDATE OF r`,
  )
  const latestSeq = locked[0]?.['latest_seq']

  // 4. Content-addressed description, then the immutable revision, both idempotent.
  if (p.description !== null) {
    await tx.execute(
      sql`INSERT INTO job_text_blobs (sha256, text) VALUES (${p.description.sha256}, ${p.description.text})
          ON CONFLICT (sha256) DO NOTHING`,
    )
  }
  const { rows: inserted } = await tx.execute(
    sql`INSERT INTO job_source_record_revisions
          (source_record_id, adapter_version, normalizer_version, content_hash, normalized,
           original_identity, evidence, description_sha256, published_at_raw, published_at)
        VALUES (${record.id}::uuid, ${p.adapterVersion}, ${p.normalizerVersion}, ${p.contentHash},
                ${JSON.stringify(p.normalized)}::jsonb, ${JSON.stringify(p.originalIdentity)}::jsonb,
                ${JSON.stringify(p.evidence)}::jsonb, ${p.description?.sha256 ?? null},
                ${p.publishedAtRaw}, ${p.publishedAt}::timestamptz)
        ON CONFLICT (source_record_id, normalizer_version, content_hash) DO NOTHING
        RETURNING id, received_seq`,
  )
  const revision: Row | undefined =
    inserted[0] ??
    (
      await tx.execute(
        sql`SELECT id, received_seq FROM job_source_record_revisions
             WHERE source_record_id = ${record.id}::uuid AND normalizer_version = ${p.normalizerVersion}
               AND content_hash = ${p.contentHash}`,
      )
    ).rows[0]
  // The record row is locked by this transaction, so its revision cannot vanish in between.
  const revisionId = String((revision as Row)['id'])
  const receivedSeq = Number((revision as Row)['received_seq'])

  // 5. Advance the pointer only to a later arrival: a late or repeated older revision is
  //    stored (above) and never regresses `latest_revision_id`.
  const advanced = latestSeq === null || latestSeq === undefined || receivedSeq > Number(latestSeq)
  await tx.execute(
    advanced
      ? sql`UPDATE job_source_records
               SET latest_revision_id = ${revisionId}::uuid, source_url = ${p.sourceUrl},
                   application_url = ${p.applicationUrl},
                   last_observed_at = clock_timestamp(), updated_at = clock_timestamp()
             WHERE id = ${record.id}::uuid`
      : sql`UPDATE job_source_records SET last_observed_at = clock_timestamp(), updated_at = clock_timestamp()
             WHERE id = ${record.id}::uuid`,
  )

  // 6. Run membership, once per (run, record).
  await tx.execute(
    sql`INSERT INTO job_run_records (run_id, source_record_id, revision_id)
        VALUES (${owned.runId}::uuid, ${record.id}::uuid, ${revisionId}::uuid)
        ON CONFLICT (run_id, source_record_id) DO NOTHING`,
  )

  // 7. Dirty work in the producer's transaction; the target version is the revision's arrival.
  if (advanced) {
    await tx.execute(
      sql`INSERT INTO job_dirty_work (entity_kind, entity_id, target_version, reason, cycle_id)
          VALUES ('SOURCE_RECORD', ${record.id}::uuid, ${receivedSeq}, ${SOURCE_REVISION_REASON},
                  (SELECT cycle_id FROM job_collection_runs WHERE id = ${owned.runId}::uuid))
          ON CONFLICT (entity_kind, entity_id, target_version, reason) DO NOTHING`,
    )
  }
  return {
    recordId: record.id,
    revisionId,
    receivedSeq,
    createdRecord: record.created,
    createdRevision: inserted[0] !== undefined,
    advanced,
  }
}

/** One observation, inside the caller's transaction: `assertOwned` first, then steps 2–7. */
export async function saveObservation(
  tx: SqlExecutor,
  h: RunHandle,
  o: SourceObservation,
): Promise<SavedObservation> {
  const owned = await assertOwned(tx, h)
  if (o.identity.provider !== (await sourceTypeOf(tx, owned)))
    throw new RangeError('saveObservation: an observation of another source type')
  return writeObservation(tx, owned, o)
}

/**
 * A page of observations inside the caller's transaction (Task 4.6 calls this from `savePage`):
 * `assertOwned` once, then the records in ascending (namespace, identity key), repeats dropped.
 */
export async function saveObservations(
  tx: SqlExecutor,
  h: RunHandle,
  observations: readonly SourceObservation[],
): Promise<SavedObservation[]> {
  const owned = await assertOwned(tx, h)
  const type = await sourceTypeOf(tx, owned)
  const ordered = byNaturalKey(observations)
  if (ordered.some((o) => o.identity.provider !== type))
    throw new RangeError('saveObservations: an observation of another source type')
  const saved: SavedObservation[] = []
  for (const o of ordered) saved.push(await writeObservation(tx, owned, o))
  return saved
}

/** The page's checkpoint and counters on the run row, as `savePage` writes them. */
export async function writePageCheckpoint(
  tx: SqlExecutor,
  h: RunHandle,
  page: SavedPage,
  saved: readonly SavedObservation[],
): Promise<void> {
  const checkpoint = validatedCheckpointSchema.parse(page.checkpoint)
  const created = saved.filter((s) => s.createdRecord).length
  const received = page.observations.length
  await tx.execute(
    sql`UPDATE job_collection_runs
           SET checkpoint = ${JSON.stringify(checkpoint)}::jsonb,
               received = received + ${received},
               created = created + ${created},
               unchanged = unchanged + ${saved.length - created},
               duplicates = duplicates + ${received - saved.length},
               updated_at = clock_timestamp()
         WHERE id = ${h.runId}::uuid`,
  )
}

/**
 * A whole page in ONE transaction: the observations and the checkpoint commit or roll back
 * together, so a crash re-pays at most the page in flight (ADR "Crash resume"). Retried as a
 * whole on deadlock / serialization / lock timeout; a fenced run is never retried.
 */
export async function saveObservationPage(
  db: MeterDb,
  h: RunHandle,
  page: SavedPage,
): Promise<SavedObservation[]> {
  validatedCheckpointSchema.parse(page.checkpoint)
  return withLockRetry(() =>
    db.transaction(async (tx) => {
      const saved = await saveObservations(tx, h, page.observations)
      await writePageCheckpoint(tx, h, page, saved)
      return saved
    }, READ_COMMITTED),
  )
}
