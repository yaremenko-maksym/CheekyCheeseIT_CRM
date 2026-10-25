import { sql } from 'drizzle-orm'
import type { MeterDb } from '../metering/account-meter.store'
import type { SourceObservation } from '../normalize/observation'
import { type SavedPage, writePageProgress } from '../ownership/job-run-ledger'
import { type OwnedRun, type RunHandle, assertOwned } from '../ownership/run-ownership'
import type { SqlExecutor } from '../scheduling/host-state'
import { byNaturalKey, setLockTimeout, withLockRetry } from './lock-order'
import { revisionPayload, validateObservation } from './record-payload'

/**
 * The observation store (r5 Task 4.5): one source record per (provider, namespace, identity
 * key), its immutable revisions, run membership and the dirty work a new latest revision produces.
 *
 * Every write path starts with `assertOwned` (ADR 2026-10-24, "Operations"): a fenced executor
 * gets `RunFencedError` and its transaction writes nothing. Short READ COMMITTED transactions;
 * records are locked in ascending (namespace, identity key) — the page-write row of the ADR's
 * lock-acquisition table, which this store extends rather than changes.
 *
 * LATEST = MOST RECENTLY OBSERVED (CR-M-2). An observation's time is its run's `started_at` (the
 * fetch, as far as the store can know it). `job_source_record_heads` keeps the time of the
 * observation that set the pointer: a newer-or-equal observation moves the pointer to its
 * revision — content A -> B -> A ends on A — and a strictly older one (a slow run committing after
 * a later one) is stored as a revision and never regresses it. Every move bumps the record's
 * `observation_seq`, which is the dirty-work target version, so it is monotonic per record.
 *
 * `saveObservations` is the tx-level seam; `saveObservationPage` is THE page write (observations
 * + checkpoint, one tx) — since Task 4.6 the run worker's only one (the ledger's `savePage` is gone).
 */

const READ_COMMITTED = { isolationLevel: 'read committed' } as const
/** Attempts to find the record after `ON CONFLICT DO NOTHING` returned no row. */
const RECORD_ATTEMPTS = 3
/** `job_dirty_work.reason` of a moved latest pointer. */
export const SOURCE_REVISION_REASON = 'SOURCE_REVISION'
/**
 * The most observations one page may write (SR-M-4, CR-M-4): the page holds every record lock
 * until it commits and costs about eight statements per observation. Adapter pages may be larger
 * (an ATS board is one 2 000-item page): the run worker splits those into chunks of at most this
 * many (`chunkPage`, Task 4.6), so a larger page never reaches `saveObservations`.
 */
export const MAX_OBSERVATIONS_PER_PAGE = 500
/** Default `lock_timeout` of the store's own transactions (contention is retried, then typed). */
export const STORE_LOCK_TIMEOUT_MS = 5_000

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
  /** A later observation of the same record in the same page followed it (CR-M-3). */
  superseded: boolean
}

type Row = Record<string, unknown>

interface PageContext {
  owned: OwnedRun
  type: unknown
}

async function pageContext(tx: SqlExecutor, h: RunHandle): Promise<PageContext> {
  const owned = await assertOwned(tx, h)
  const { rows } = await tx.execute(
    sql`SELECT type FROM job_sources WHERE id = ${owned.sourceId}::uuid`,
  )
  return { owned, type: rows[0]?.['type'] }
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
  const run = sql`(SELECT started_at FROM job_collection_runs WHERE id = ${owned.runId}::uuid)`

  // 3. Lock the record, THEN read its head in a separate statement (R2-CR-M-1): under READ
  //    COMMITTED a statement that waited for the lock re-checks only the locked row, so a head
  //    joined into the locking statement would be the pre-wait snapshot, and a waiter would act
  //    on the head the lock holder just replaced. A new statement sees what the holder committed.
  await tx.execute(sql`SELECT 1 FROM job_source_records WHERE id = ${record.id}::uuid FOR UPDATE`)
  const readHead = async () =>
    (
      await tx.execute(
        sql`SELECT latest_revision_id, ${run} >= observed_at AS not_older
              FROM job_source_record_heads WHERE source_record_id = ${record.id}::uuid`,
      )
    ).rows[0]
  let head = await readHead()

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

  // 5. Move the pointer to the most recently observed content; never back to an older observation.
  //    The head is written only under the record lock, so a first-observation race is not
  //    expected; if one happens anyway (a writer outside this module), the claim of the heads
  //    primary key loses with no row, and the head is re-read and treated as existing.
  let targetVersion = 0
  if (head === undefined) {
    const { rows: first } = await tx.execute(
      sql`INSERT INTO job_source_record_heads (source_record_id, latest_revision_id, observed_at, observation_seq)
          VALUES (${record.id}::uuid, ${revisionId}::uuid, ${run}, 1)
          ON CONFLICT (source_record_id) DO NOTHING
          RETURNING observation_seq`,
    )
    if (first[0] !== undefined) targetVersion = 1
    else head = await readHead()
  }
  const latestRevision = head?.['latest_revision_id']
  const notOlder = head === undefined || head['not_older'] === true
  const advanced = notOlder && latestRevision !== revisionId
  if (head !== undefined && notOlder) {
    const { rows: moved } = await tx.execute(
      sql`UPDATE job_source_record_heads
             SET latest_revision_id = ${revisionId}::uuid, observed_at = ${run},
                 observation_seq = observation_seq + ${advanced ? 1 : 0}
           WHERE source_record_id = ${record.id}::uuid
       RETURNING observation_seq`,
    )
    targetVersion = Number(moved[0]?.['observation_seq'])
  }
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

  // 7. Dirty work in the producer's transaction, at the record's new observation sequence.
  if (advanced) {
    await tx.execute(
      sql`INSERT INTO job_dirty_work (entity_kind, entity_id, target_version, reason, cycle_id)
          VALUES ('SOURCE_RECORD', ${record.id}::uuid, ${targetVersion}, ${SOURCE_REVISION_REASON},
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
    superseded: false,
  }
}

/** The page cap, checked before any round trip (security LOW, round 2). */
function assertPageSize(observations: readonly SourceObservation[]): void {
  if (observations.length > MAX_OBSERVATIONS_PER_PAGE)
    throw new RangeError(
      `saveObservations: ${observations.length} observations, at most ${MAX_OBSERVATIONS_PER_PAGE}`,
    )
}

function assertPage(observations: readonly SourceObservation[], type: unknown): void {
  for (const o of observations) {
    validateObservation(o)
    if (o.identity.provider !== type)
      throw new RangeError('saveObservations: an observation of another source type')
  }
}

/** One observation, inside the caller's transaction: `assertOwned` first, then steps 2–7. */
export async function saveObservation(
  tx: SqlExecutor,
  h: RunHandle,
  o: SourceObservation,
): Promise<SavedObservation> {
  const { owned, type } = await pageContext(tx, h)
  assertPage([o], type)
  return writeObservation(tx, owned, o)
}

/**
 * A page of observations inside the caller's transaction (`saveObservationPage` calls it):
 * `assertOwned` once, then the records in ascending (namespace, identity key). Only a content that
 * immediately repeats the previous content of the same record is dropped (A, A -> A; A, B, A is
 * written as A, B, A and ends on A); every other content of one record is written, in arrival
 * order, and each but the last is marked `superseded`. shortcut: one round trip per statement (about eight per observation),
 * bounded by MAX_OBSERVATIONS_PER_PAGE; batching would have to keep the per-record lock order.
 */
export async function saveObservations(
  tx: SqlExecutor,
  h: RunHandle,
  observations: readonly SourceObservation[],
): Promise<SavedObservation[]> {
  assertPageSize(observations)
  const { owned, type } = await pageContext(tx, h)
  assertPage(observations, type)
  const saved: SavedObservation[] = []
  for (const o of byNaturalKey(observations)) saved.push(await writeObservation(tx, owned, o))
  return saved.map((s, i) => ({ ...s, superseded: saved[i + 1]?.recordId === s.recordId }))
}

/** A page, or a chunk of one: `checkpoint: null` adds the counters and keeps the checkpoint. */
export interface PageChunk {
  readonly observations: SavedPage['observations']
  readonly checkpoint: SavedPage['checkpoint'] | null
}

/**
 * Split a page into chunks of at most `max` observations for `saveObservationPage`, keeping every
 * observation of one identity in ONE chunk (so the per-chunk counters add up to the page's) and
 * moving the checkpoint with the LAST chunk only (a crash between chunks resumes from the page). A
 * page within the cap is one chunk, unchanged. shortcut: a single identity with more than `max`
 * observations stays one oversized chunk and is refused by the store's cap.
 */
export function chunkPage(page: SavedPage, max = MAX_OBSERVATIONS_PER_PAGE): PageChunk[] {
  if (page.observations.length <= max) return [page]
  const groups = new Map<string, SourceObservation[]>()
  for (const o of page.observations) {
    const key = `${o.identity.namespace}\u0000${o.identity.identityKey}`
    groups.set(key, [...(groups.get(key) ?? []), o])
  }
  const chunks: SourceObservation[][] = [[]]
  for (const group of groups.values()) {
    const last = chunks.at(-1) as SourceObservation[]
    if (last.length > 0 && last.length + group.length > max) chunks.push([...group])
    else last.push(...group)
  }
  return chunks.map((observations, i) => ({
    observations,
    checkpoint: i === chunks.length - 1 ? page.checkpoint : null,
  }))
}

/**
 * The page's checkpoint and counters, written by the ledger (the run row's one writer). Fences
 * itself (SR-M-1 / CR-M-1): `assertOwned` here, and the ledger's UPDATE repeats the ownership
 * predicate, so no caller can write a run it does not own.
 */
export async function writePageCheckpoint(
  tx: SqlExecutor,
  h: RunHandle,
  page: PageChunk,
  saved: readonly SavedObservation[],
): Promise<void> {
  const owned = await assertOwned(tx, h)
  const records = new Set(saved.map((s) => s.recordId))
  await writePageProgress(tx, h, owned, {
    checkpoint: page.checkpoint,
    received: page.observations.length,
    unique: records.size,
    created: saved.filter((s) => s.createdRecord).length,
  })
}

export interface PageWriteOptions {
  /** `lock_timeout` of each attempt when no `timeoutMs` budget is given. */
  readonly lockTimeoutMs?: number
  /**
   * The run worker's page-write budget `H` (T7 SR-L-9, "Lease, heartbeat and page writes"): each
   * attempt runs under `statement_timeout` AND `lock_timeout` of this many ms, so a heartbeat
   * queued behind it still lands before the lease expires.
   */
  readonly timeoutMs?: number
}

/** `SET LOCAL statement_timeout` and `lock_timeout` to one budget, bound as parameters. */
async function setPageBudget(tx: SqlExecutor, ms: number): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('statement_timeout', ${`${ms}ms`}, true), set_config('lock_timeout', ${`${ms}ms`}, true)`,
  )
}

/**
 * A whole page in ONE transaction: the observations and the checkpoint commit or roll back
 * together, so a crash re-pays at most the page in flight (ADR "Crash resume"). Retried as a
 * whole on deadlock / serialization / lock timeout (bounded, `withLockRetry`); a fenced run is
 * never retried. This is the production page write (Task 4.6): the worker's context calls it.
 */
export async function saveObservationPage(
  db: MeterDb,
  h: RunHandle,
  page: PageChunk,
  { lockTimeoutMs = STORE_LOCK_TIMEOUT_MS, timeoutMs }: PageWriteOptions = {},
): Promise<SavedObservation[]> {
  if (timeoutMs !== undefined && !(Number.isSafeInteger(timeoutMs) && timeoutMs > 0))
    throw new RangeError('saveObservationPage: invalid timeout')
  assertPageSize(page.observations)
  return withLockRetry(() =>
    db.transaction(async (tx) => {
      if (timeoutMs === undefined) await setLockTimeout(tx, lockTimeoutMs)
      else await setPageBudget(tx, timeoutMs)
      const saved = await saveObservations(tx, h, page.observations)
      await writePageCheckpoint(tx, h, page, saved)
      return saved
    }, READ_COMMITTED),
  )
}
