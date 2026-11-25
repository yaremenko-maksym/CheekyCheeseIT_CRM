import type { JobAvailability } from '@crm/shared'
import { Logger } from '@nestjs/common'
import { type SQL, sql } from 'drizzle-orm'
import { dbErrorLogSuffix, safeErrorStack } from '../../database/pg-errors'
import { deriveOpportunityAvailability } from '../availability/derive-availability'
import type { MeterDb } from '../metering/account-meter.store'
import { VACANCY_RETENTION_DAYS, vacancyRetentionEnabled } from '../retention'
import type { SqlExecutor } from '../scheduling/host-state'

/**
 * Vacancy retention on the new store (owner decisions 2026-11-25): a vacancy lives at most
 * `VACANCY_RETENTION_DAYS` from its publication date (`published_at`, else `first_seen_at`), and a
 * vacancy that becomes CLOSED or EXPIRED is removed AT THE MOMENT OF DETECTION, inside the
 * transaction that closed it (`purgeClosedOwners`, called by every record closer, and the
 * opportunity re-derive). The daily sweep (`purgeRetiredOpportunities`) is the 60-day rule plus a
 * safety net for anything a closer left behind.
 *
 * DELETE OR TOMBSTONE. `job_queue_actions` is append-only with RESTRICT parent FKs (two-year legal
 * retention, `docs/legal/2026-10-17-job-queue-actions-erasure.md`), so an opportunity or a record
 * the log names is never deleted, and the log is never written here:
 *   - an opportunity with logged actions (or a senior's tailored resume, which would otherwise
 *     cascade away) is TOMBSTONED: its description and derived fields are cleared, its links,
 *     identity tokens, matches, triage, relevance and dismissals go; the row, the log and the
 *     senior submissions (`job_queue_assignments`) stay, and so do the title, the employer and
 *     their keys, so the "already submitted" duplicate guard still sees the submission (SR-M-2);
 *   - an ACTIVE member record the log names is RETIRED: its revisions (the text) go and its
 *     natural key moves out of the way (`namespace = 'retired:<id>'`), so the uniqueness triple,
 *     the held-keys pre-check and the dirty-work key no longer see it. A historical (unlinked)
 *     member is left to the record pass (CR-M-3);
 *   - everything else is DELETED (cascades: revisions, heads, run membership, inventory misses,
 *     tokens, matches, triage, assignments, dismissals, generation entries, relevance; interviews
 *     keep their copied fields and lose only the link, `ON DELETE SET NULL`).
 * A later collection of the same posting therefore finds no record and no token owner, inserts a
 * fresh record and the resolver creates a NEW opportunity: it re-enters the queue as new.
 *
 * THE TOMBSTONE MARKER (SR-M-1). A tombstone carries `field_revisions = {"retention":"TOMBSTONE"}`
 * (`retentionTombstone`). The builder writes one key per canonical field there, so a built
 * opportunity never holds it. A sourced opportunity is a queue row only through an ACTIVE linked
 * record (`queueRowJoins`, the `d` join), for every scope, list and card alike, so a tombstone is
 * never listed; the marker is what the sweep, the duplicate readers and the roster fan-out test.
 * An opportunity that lost its last link row (a member deleted by another opportunity's purge) is
 * NOT a tombstone, so the sweep still removes it once it qualifies.
 *
 * ADMIN SUPPRESSION (SR-M-2). An opportunity an ADMIN has SUPPRESSED is never purged: the
 * takedown lives only in the action log against this row, so a re-listing must map back to it.
 *
 * KILL SWITCH (SR-M-3). `VACANCY_RETENTION_ENABLED` (default on, `vacancyRetentionEnabled`) gates
 * the sweep, the removal at detection and the legacy `job_postings` purge; off, a closer writes
 * CLOSED/EXPIRED as before this module existed.
 *
 * Manual cards (`manual_team_id`, typed by HR) are out of scope: they have no record to close, and
 * the sweep skips them (owner question raised in the PR).
 */

/** The grep-able prefix of every retention failure log line (the cron and the inline purge). */
export const VACANCY_RETENTION_FAILURE_MARKER = 'vacancy_retention_purge_failed'

const logger = new Logger('VacancyRetention')

/** Is `alias` (a `job_opportunities` row) a retention tombstone? Binds no parameter. */
export const retentionTombstone = (alias: SQL): SQL =>
  sql`(${alias}.field_revisions @> '{"retention":"TOMBSTONE"}'::jsonb)`

/** An ADMIN's SUPPRESSED action names the opportunity `alias`. Binds no parameter. */
const suppressed = (alias: SQL): SQL =>
  sql`EXISTS (SELECT 1 FROM job_queue_actions sup
               WHERE sup.opportunity_id = ${alias}.id AND sup.kind = 'SUPPRESSED')`

/** Gone for the queue: what a closer or the re-derive turns into a purge. */
export const isGoneAvailability = (a: JobAvailability): boolean => a === 'CLOSED' || a === 'EXPIRED'

export type PurgeOutcome = 'DELETED' | 'TOMBSTONED' | 'MISSING' | 'SKIPPED'

const RETIRED_NAMESPACE_PREFIX = 'retired:'

const inUuids = (ids: readonly string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )

/** The ACTIVE source records' availability for an opportunity (most-open input to S8b). */
export async function readActiveRecordStates(
  tx: SqlExecutor,
  opportunityId: string,
): Promise<JobAvailability[]> {
  const { rows } = await tx.execute(
    sql`SELECT r.availability
          FROM job_opportunity_sources os
          JOIN job_source_records r ON r.id = os.source_record_id
         WHERE os.opportunity_id = ${opportunityId}::uuid AND os.unlinked_at IS NULL`,
  )
  // Our own enum column: every value is a valid JobAvailability.
  return rows.map((r) => String(r['availability']) as JobAvailability)
}

/**
 * Remove one opportunity (delete or tombstone, see the module comment) with its member records,
 * inside the caller's transaction — only if it STILL qualifies once its rows are locked: never a
 * manual card; past retention by publication date; otherwise only when its active members derive
 * CLOSED/EXPIRED (its own availability when it has no active member). A member that reopened, or
 * one linked in between, leaves it alone: SKIPPED. Nothing is written before every check passed.
 *
 * NO WAIT. Every lock here is SKIP LOCKED, so the purge never waits on a row another transaction
 * holds and adds no edge to a lock cycle with the observation writers (records by natural key,
 * then the opportunity), the re-derive (opportunity first) or another closer; a busy row is
 * SKIPPED (a closer's owner enqueue re-derives it, the sweep retries it next night). The
 * opportunity's FOR UPDATE conflicts with the FOR KEY SHARE every link insert takes, so once it is
 * held the member set cannot grow; it is re-read then and must be the locked one.
 *
 * `beforeWrite` runs once every check has passed and before the first write (the re-derive
 * completes its dirty row there, while the opportunity still exists).
 */
export async function purgeOpportunity(
  tx: SqlExecutor,
  opportunityId: string,
  beforeWrite?: () => Promise<void>,
): Promise<PurgeOutcome> {
  const id = sql`${opportunityId}::uuid`
  const { rows: lockedRows } = await tx.execute(
    sql`SELECT r.id FROM job_source_records r
         WHERE r.id IN (SELECT source_record_id FROM job_opportunity_sources WHERE opportunity_id = ${id})
         ORDER BY r.id FOR UPDATE SKIP LOCKED`,
  )
  const { rows: found } = await tx.execute(
    sql`SELECT o.manual_team_id IS NOT NULL AS manual, o.availability,
               ${retentionTombstone(sql`o`)} AS tombstone, ${suppressed(sql`o`)} AS suppressed,
               COALESCE(o.published_at, o.first_seen_at)
                 < clock_timestamp() - make_interval(days => ${VACANCY_RETENTION_DAYS}) AS old
          FROM job_opportunities o WHERE o.id = ${id} FOR UPDATE OF o SKIP LOCKED`,
  )
  const opp = found[0]
  if (opp === undefined) {
    const { rows } = await tx.execute(sql`SELECT 1 FROM job_opportunities WHERE id = ${id}`)
    return rows.length === 0 ? 'MISSING' : 'SKIPPED'
  }
  // A manual card, a tombstone (done already) and an ADMIN takedown are never purged.
  if (opp['manual'] === true || opp['tombstone'] === true || opp['suppressed'] === true)
    return 'SKIPPED'
  const locked = new Set(lockedRows.map((r) => String(r['id'])))
  const { rows: memberRows } = await tx.execute(
    sql`SELECT source_record_id AS id, bool_or(unlinked_at IS NULL) AS active
          FROM job_opportunity_sources WHERE opportunity_id = ${id} GROUP BY source_record_id`,
  )
  if (memberRows.some((r) => !locked.has(String(r['id'])))) return 'SKIPPED'
  // CR-M-3: only an ACTIVE member goes with the opportunity; a historical one is the record pass's.
  const members = memberRows.filter((r) => r['active'] === true).map((r) => String(r['id']))
  if (opp['old'] !== true) {
    const states = await readActiveRecordStates(tx, opportunityId)
    // Our own enum column: a valid JobAvailability.
    const own = String(opp['availability']) as JobAvailability
    if (!isGoneAvailability(states.length > 0 ? deriveOpportunityAvailability(states) : own))
      return 'SKIPPED'
  }
  await beforeWrite?.()

  // Links first: RESTRICT on both sides.
  await tx.execute(sql`DELETE FROM job_opportunity_sources WHERE opportunity_id = ${id}`)
  if (members.length > 0) await purgeRecords(tx, members)

  const { rows: keep } = await tx.execute(
    sql`SELECT (EXISTS (SELECT 1 FROM job_queue_actions WHERE opportunity_id = ${id})
             OR EXISTS (SELECT 1 FROM tailored_resumes WHERE job_opportunity_id = ${id})) AS kept`,
  )
  if (keep[0]?.['kept'] !== true) {
    await tx.execute(sql`DELETE FROM job_opportunities WHERE id = ${id}`)
    return 'DELETED'
  }
  await tombstone(tx, id)
  return 'TOMBSTONED'
}

/**
 * Member records no other opportunity ACTIVELY links to: deleted, or retired when the log names
 * them. A historical (unlinked) link row does not keep a record alive, but its FK is RESTRICT, so a
 * record about to be deleted loses those rows first.
 */
async function purgeRecords(tx: SqlExecutor, members: readonly string[]): Promise<void> {
  const orphan = sql`r.id IN (${inUuids(members)})
    AND NOT EXISTS (SELECT 1 FROM job_opportunity_sources s
                     WHERE s.source_record_id = r.id AND s.unlinked_at IS NULL)`
  const logged = sql`EXISTS (SELECT 1 FROM job_queue_actions a WHERE a.source_record_id = r.id)`
  await tx.execute(
    sql`DELETE FROM job_opportunity_sources h
         WHERE h.source_record_id IN (SELECT r.id FROM job_source_records r
                                       WHERE ${orphan} AND NOT ${logged})`,
  )
  await tx.execute(sql`DELETE FROM job_source_records r WHERE ${orphan} AND NOT ${logged}`)
  const { rows } = await tx.execute(
    sql`UPDATE job_source_records r
           SET namespace = ${RETIRED_NAMESPACE_PREFIX} || r.id::text, source_id = NULL,
               original_url = NULL, display_url = NULL, source_url = NULL, application_url = NULL,
               latest_revision_id = NULL, updated_at = clock_timestamp()
         WHERE ${orphan} AND ${logged} AND r.namespace NOT LIKE ${`${RETIRED_NAMESPACE_PREFIX}%`}
     RETURNING r.id`,
  )
  const retired = rows.map((r) => String(r['id']))
  if (retired.length === 0) return
  // The text goes with the revisions (cascade: heads, run membership); tokens and the miss counter
  // would otherwise keep pointing at a posting that no longer exists.
  const list = inUuids(retired)
  await tx.execute(sql`DELETE FROM job_source_record_revisions WHERE source_record_id IN (${list})`)
  await tx.execute(
    sql`DELETE FROM job_source_record_inventory_misses WHERE source_record_id IN (${list})`,
  )
  await tx.execute(
    sql`DELETE FROM job_opportunity_identity_tokens WHERE source_record_id IN (${list})`,
  )
}

/**
 * Clear the description and every derived row, mark the row (`retentionTombstone`) and keep it for
 * the action log's RESTRICT FK; the log itself is never touched. The title, the employer, their
 * keys and the senior submissions stay (SR-M-2): `assertNoClaimedDuplicate` finds a TAKEN
 * submission on a tombstoned copy through them, so a re-listing cannot be submitted twice for the
 * same senior unconfirmed. The roster fan-out and the duplicate list skip a tombstone by its
 * marker. Dismissals go (owner: losing them is accepted). Generation entries stay: they are
 * immutable (`job_queue_generation_entries_immutable` refuses a direct DELETE while both parents
 * exist) and leave with their generation; every page reaches a row only through an ACTIVE linked
 * record, which a tombstone no longer has.
 */
async function tombstone(tx: SqlExecutor, id: SQL): Promise<void> {
  for (const table of [
    'job_opportunity_identity_tokens',
    'job_opportunity_matches',
    'job_opportunity_team_triage',
    'job_opportunity_relevance',
    'job_queue_dismissals',
  ])
    await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE opportunity_id = ${id}`)
  await tx.execute(
    sql`UPDATE job_opportunities
           SET location = NULL, stack_keywords = '{}',
               application_url = NULL, application_url_key = NULL, description_sha256 = NULL,
               field_revisions = '{"retention":"TOMBSTONE"}'::jsonb,
               availability = CASE WHEN availability IN ('CLOSED', 'EXPIRED') THEN availability
                                   ELSE 'EXPIRED'::job_availability END,
               revision = revision + 1, evaluated_revision = NULL, evaluation_verdict = NULL,
               evaluated_inputs_version = NULL, role_family = NULL, technical_roles = '{}',
               role_status = NULL, role_classifier_version = NULL, salary_min = NULL,
               salary_max = NULL, salary_currency = NULL, salary_period = NULL,
               salary_monthly_top = NULL, updated_at = clock_timestamp()
         WHERE id = ${id}`,
  )
}

export type InlinePurgeOutcome = PurgeOutcome | 'FAILED'

/**
 * `purgeOpportunity` inside a SAVEPOINT of the caller's transaction (CR-M-2): a purge that throws
 * is rolled back to the savepoint, logged with `VACANCY_RETENTION_FAILURE_MARKER` and reported as
 * FAILED, so the closure the caller wrote stays committed (the record CLOSED/EXPIRED, the
 * opportunity hidden by the queue) and the sweep retries the removal. A failure of the rollback
 * itself (the connection is gone) still throws.
 */
export async function purgeOpportunityInline(
  tx: SqlExecutor,
  opportunityId: string,
  beforeWrite?: () => Promise<void>,
): Promise<InlinePurgeOutcome> {
  await tx.execute(sql`SAVEPOINT vacancy_retention_purge`)
  try {
    const outcome = await purgeOpportunity(tx, opportunityId, beforeWrite)
    await tx.execute(sql`RELEASE SAVEPOINT vacancy_retention_purge`)
    return outcome
  } catch (error: unknown) {
    await tx.execute(sql`ROLLBACK TO SAVEPOINT vacancy_retention_purge`)
    await tx.execute(sql`RELEASE SAVEPOINT vacancy_retention_purge`)
    logger.error(
      `${VACANCY_RETENTION_FAILURE_MARKER} Vacancy retention could not remove opportunity ${opportunityId} at detection; the closure stands and the sweep retries${dbErrorLogSuffix(error)}`,
      safeErrorStack(error),
    )
    return 'FAILED'
  }
}

/**
 * Inline removal at detection: after a record turned CLOSED/EXPIRED in this transaction, every
 * opportunity it is an ACTIVE member of is re-derived (most-open over its active records) and
 * purged when the result is CLOSED/EXPIRED. One with another open member stays; the caller's
 * owner enqueue then re-derives it as before. Each purge is its own savepoint
 * (`purgeOpportunityInline`), so a failing one never undoes the close. Does nothing while
 * `VACANCY_RETENTION_ENABLED` is off. Returns how many were purged.
 */
export async function purgeClosedOwners(tx: SqlExecutor, recordId: string): Promise<number> {
  if (!vacancyRetentionEnabled()) return 0
  const { rows } = await tx.execute(
    sql`SELECT DISTINCT opportunity_id FROM job_opportunity_sources
         WHERE source_record_id = ${recordId}::uuid AND unlinked_at IS NULL
         ORDER BY opportunity_id`,
  )
  let purged = 0
  for (const row of rows) {
    const opportunityId = String(row['opportunity_id'])
    const next = deriveOpportunityAvailability(await readActiveRecordStates(tx, opportunityId))
    if (!isGoneAvailability(next)) continue
    const outcome = await purgeOpportunityInline(tx, opportunityId)
    if (isRemoved(outcome)) purged += 1
  }
  return purged
}

/** The purge removed the opportunity (deleted or tombstoned). */
export const isRemoved = (outcome: InlinePurgeOutcome): boolean =>
  outcome === 'DELETED' || outcome === 'TOMBSTONED'

/**
 * The sweep's predicate: a sourced opportunity (not a manual card, not a tombstone, not ADMIN
 * suppressed; with or without link rows left, SR-M-1) past the retention limit by publication
 * date, or left CLOSED/EXPIRED.
 */
export const retiredOpportunityPredicate = sql`o.manual_team_id IS NULL
  AND NOT ${retentionTombstone(sql`o`)} AND NOT ${suppressed(sql`o`)}
  AND (COALESCE(o.published_at, o.first_seen_at)
         < clock_timestamp() - make_interval(days => ${VACANCY_RETENTION_DAYS})
       OR o.availability IN ('CLOSED', 'EXPIRED'))`

/**
 * A source record no opportunity links to (collected but not yet resolved, closed before linking,
 * or left behind by an unlink) past the retention limit by its latest revision's publication date
 * (else `first_seen_at`), or CLOSED/EXPIRED. The opportunity sweep never reaches it. Retired
 * records are done already.
 */
export const retiredRecordPredicate = sql`r.namespace NOT LIKE ${`${RETIRED_NAMESPACE_PREFIX}%`}
  AND NOT EXISTS (SELECT 1 FROM job_opportunity_sources s
                   WHERE s.source_record_id = r.id AND s.unlinked_at IS NULL)
  AND (r.availability IN ('CLOSED', 'EXPIRED')
       OR COALESCE((SELECT v.published_at FROM job_source_record_revisions v
                     WHERE v.id = r.latest_revision_id), r.first_seen_at)
            < clock_timestamp() - make_interval(days => ${VACANCY_RETENTION_DAYS}))`

/** One unlinked record, re-tested under its lock (SKIP LOCKED: a busy one waits for next night). */
async function purgeUnlinkedRecord(tx: SqlExecutor, recordId: string): Promise<boolean> {
  const { rows } = await tx.execute(
    sql`SELECT r.id FROM job_source_records r
         WHERE r.id = ${recordId}::uuid AND ${retiredRecordPredicate} FOR UPDATE SKIP LOCKED`,
  )
  if (rows.length === 0) return false
  await purgeRecords(tx, [recordId])
  return true
}

const BLOB_BATCH = 1000

/**
 * Description text no revision and no opportunity points at any more (both FKs are RESTRICT, so a
 * referenced blob is never deleted). shortcut: an observation writer inserts its blob with
 * `ON CONFLICT DO NOTHING` (no lock) and the revision right after, so a re-listing of the very same
 * text in the instant this statement runs fails that one page write (FK); the page is re-collected
 * on the next run. Upgrade to a locking upsert if it ever shows in the run errors.
 *
 * KEYSET (CR-M-7). Each batch walks the primary key from where the last one stopped
 * (`sha256 > last`, in key order), so a batch never re-scans the referenced blobs an earlier batch
 * already passed over; `last` is the highest key the batch deleted (RETURNING has no order).
 */
async function collectTextBlobs(db: MeterDb, maxBatches: number): Promise<number> {
  let collected = 0
  let last: string | null = null
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const from: SQL = last === null ? sql`TRUE` : sql`x.sha256 > ${last}`
    const { rows } = await db.execute(
      sql`DELETE FROM job_text_blobs b WHERE b.sha256 IN (
            SELECT x.sha256 FROM job_text_blobs x
             WHERE ${from}
               AND NOT EXISTS (SELECT 1 FROM job_source_record_revisions v
                                WHERE v.description_sha256 = x.sha256)
               AND NOT EXISTS (SELECT 1 FROM job_opportunities o
                                WHERE o.description_sha256 = x.sha256)
             ORDER BY x.sha256 LIMIT ${BLOB_BATCH})
          RETURNING b.sha256`,
    )
    collected += rows.length
    if (rows.length < BLOB_BATCH) break
    // Stryker disable next-line EqualityOperator: equivalent — `>=` differs only when b === a, and then both branches return the same string.
    last = rows.map((r) => String(r['sha256'])).reduce((a, b) => (b > a ? b : a))
  }
  return collected
}

export type SweepFailureKind = 'OPPORTUNITY' | 'RECORD' | 'BLOBS'

export interface SweepOptions {
  /** Ids per batch; each one is its own short transaction. */
  readonly batchSize?: number
  /** Batches per step and call, so one tick stays bounded. */
  readonly maxBatches?: number
  /** One row's failure: reported, then the sweep goes on with the next id. */
  readonly onError?: (kind: SweepFailureKind, id: string, error: unknown) => void
}

export interface SweepResult {
  readonly deleted: number
  readonly tombstoned: number
  /** Busy (locked elsewhere) or no longer qualifying once locked. */
  readonly skipped: number
  readonly failed: number
  /** Unlinked source records deleted or retired. */
  readonly records: number
  readonly blobs: number
}

const READ_COMMITTED = { isolationLevel: 'read committed' } as const

const afterId = (column: SQL, after: string | null): SQL =>
  after === null ? sql`TRUE` : sql`${column} > ${after}::uuid`

/**
 * Ids in id order, keyset-paged (`id > last`), at most `batchSize * maxBatches`: a row that keeps
 * failing or stays busy is passed over instead of being re-read at the head of every batch.
 */
async function* keysetIds(
  db: MeterDb,
  page: (after: string | null, limit: number) => SQL,
  batchSize: number,
  maxBatches: number,
): AsyncGenerator<string> {
  let after: string | null = null
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const query: SQL = page(after, batchSize)
    const { rows } = await db.execute(query)
    for (const row of rows) {
      after = String(row['id'])
      yield after
    }
    if (rows.length < batchSize) return
  }
}

/**
 * The daily sweep: retired opportunities, then unlinked retired records, then orphaned description
 * text. Each opportunity and record is its own transaction; one that throws is counted, reported
 * and passed over, so it cannot hold back the rest.
 */
export async function purgeRetiredOpportunities(
  db: MeterDb,
  { batchSize = 200, maxBatches = 50, onError }: SweepOptions = {},
): Promise<SweepResult> {
  let deleted = 0
  let tombstoned = 0
  let skipped = 0
  let failed = 0
  let records = 0
  let blobs = 0
  const opportunities = keysetIds(
    db,
    (after, limit) =>
      sql`SELECT o.id FROM job_opportunities o
           WHERE ${retiredOpportunityPredicate} AND ${afterId(sql`o.id`, after)}
           ORDER BY o.id LIMIT ${limit}`,
    batchSize,
    maxBatches,
  )
  for await (const id of opportunities) {
    try {
      const outcome = await db.transaction((tx) => purgeOpportunity(tx, id), READ_COMMITTED)
      if (outcome === 'DELETED') deleted += 1
      else if (outcome === 'TOMBSTONED') tombstoned += 1
      else if (outcome === 'SKIPPED') skipped += 1
    } catch (error: unknown) {
      failed += 1
      onError?.('OPPORTUNITY', id, error)
    }
  }
  const unlinked = keysetIds(
    db,
    (after, limit) =>
      sql`SELECT r.id FROM job_source_records r
           WHERE ${retiredRecordPredicate} AND ${afterId(sql`r.id`, after)}
           ORDER BY r.id LIMIT ${limit}`,
    batchSize,
    maxBatches,
  )
  for await (const id of unlinked) {
    try {
      if (await db.transaction((tx) => purgeUnlinkedRecord(tx, id), READ_COMMITTED)) records += 1
      else skipped += 1
    } catch (error: unknown) {
      failed += 1
      onError?.('RECORD', id, error)
    }
  }
  try {
    blobs = await collectTextBlobs(db, maxBatches)
  } catch (error: unknown) {
    failed += 1
    onError?.('BLOBS', 'job_text_blobs', error)
  }
  return { deleted, tombstoned, skipped, failed, records, blobs }
}
