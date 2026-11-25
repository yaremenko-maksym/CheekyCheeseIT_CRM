import type { JobAvailability } from '@crm/shared'
import { type SQL, sql } from 'drizzle-orm'
import { deriveOpportunityAvailability } from '../availability/derive-availability'
import type { MeterDb } from '../metering/account-meter.store'
import { VACANCY_RETENTION_DAYS } from '../retention'
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
 *     cascade away) is TOMBSTONED: its text is cleared, its links, identity tokens and derived rows
 *     go, the row and the log stay;
 *   - a member record the log names is RETIRED: its revisions (the text) go and its natural key
 *     moves out of the way (`namespace = 'retired:<id>'`), so the uniqueness triple, the
 *     held-keys pre-check and the dirty-work key no longer see it;
 *   - everything else is DELETED (cascades: revisions, heads, run membership, inventory misses,
 *     tokens, matches, triage, assignments, dismissals, generation entries, relevance; interviews
 *     keep their copied fields and lose only the link, `ON DELETE SET NULL`).
 * A later collection of the same posting therefore finds no record and no token owner, inserts a
 * fresh record and the resolver creates a NEW opportunity: it re-enters the queue as new.
 *
 * WHY A TOMBSTONE IS INVISIBLE WITHOUT A MARKER COLUMN. A sourced opportunity is a queue row only
 * through an ACTIVE linked record (`queueRowJoins`, the `d` join), for every scope including
 * STUDIO, list and card alike; a tombstone has no link at all, and no match or grant either. The
 * sweep recognises a tombstone the same way (no link row, not manual), so it never re-selects one.
 *
 * Manual cards (`manual_team_id`, typed by HR) are out of scope: they have no record to close, and
 * the sweep skips them (owner question raised in the PR).
 */

/** Gone for the queue: what a closer or the re-derive turns into a purge. */
export const isGoneAvailability = (a: JobAvailability): boolean => a === 'CLOSED' || a === 'EXPIRED'

export type PurgeOutcome = 'DELETED' | 'TOMBSTONED' | 'MISSING'

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
 * inside the caller's transaction. Lock order is the canonical path's: member records by id, then
 * the opportunity. A caller already holding the opportunity lock (the re-derive) inverts it; a
 * deadlock there aborts that transaction and its dirty row is retried.
 */
export async function purgeOpportunity(
  tx: SqlExecutor,
  opportunityId: string,
): Promise<PurgeOutcome> {
  const id = sql`${opportunityId}::uuid`
  const { rows: memberRows } = await tx.execute(
    sql`SELECT r.id FROM job_source_records r
         WHERE r.id IN (SELECT source_record_id FROM job_opportunity_sources WHERE opportunity_id = ${id})
         ORDER BY r.id FOR UPDATE`,
  )
  const { rows: found } = await tx.execute(
    sql`SELECT id FROM job_opportunities WHERE id = ${id} FOR UPDATE`,
  )
  if (found.length === 0) return 'MISSING'
  const members = memberRows.map((r) => String(r['id']))

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

/** Member records no other opportunity links to: deleted, or retired when the log names them. */
async function purgeRecords(tx: SqlExecutor, members: readonly string[]): Promise<void> {
  const orphan = sql`r.id IN (${inUuids(members)})
    AND NOT EXISTS (SELECT 1 FROM job_opportunity_sources s WHERE s.source_record_id = r.id)`
  const logged = sql`EXISTS (SELECT 1 FROM job_queue_actions a WHERE a.source_record_id = r.id)`
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

/** Clear the text and every derived row; the row stays for the action log's RESTRICT FK. */
async function tombstone(tx: SqlExecutor, id: SQL): Promise<void> {
  for (const table of [
    'job_opportunity_identity_tokens',
    'job_opportunity_matches',
    'job_opportunity_team_triage',
    'job_queue_generation_entries',
    'job_opportunity_relevance',
  ])
    await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE opportunity_id = ${id}`)
  await tx.execute(
    sql`UPDATE job_opportunities
           SET title = '', title_key = '', employer_name = NULL, employer_key = NULL,
               employer_verified = false, location = NULL, stack_keywords = '{}',
               application_url = NULL, application_url_key = NULL, description_sha256 = NULL,
               field_revisions = '{}'::jsonb,
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

/**
 * Inline removal at detection: after a record turned CLOSED/EXPIRED in this transaction, every
 * opportunity it is an ACTIVE member of is re-derived (most-open over its active records) and
 * purged when the result is CLOSED/EXPIRED. One with another open member stays; the caller's
 * owner enqueue then re-derives it as before. Returns how many were purged.
 */
export async function purgeClosedOwners(tx: SqlExecutor, recordId: string): Promise<number> {
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
    if ((await purgeOpportunity(tx, opportunityId)) !== 'MISSING') purged += 1
  }
  return purged
}

/**
 * The sweep's predicate: a sourced opportunity (a link row exists, so never a tombstone and never
 * a manual card) past the retention limit by publication date, or left CLOSED/EXPIRED.
 */
export const retiredOpportunityPredicate = sql`o.manual_team_id IS NULL
  AND EXISTS (SELECT 1 FROM job_opportunity_sources s WHERE s.opportunity_id = o.id)
  AND (COALESCE(o.published_at, o.first_seen_at)
         < clock_timestamp() - make_interval(days => ${VACANCY_RETENTION_DAYS})
       OR o.availability IN ('CLOSED', 'EXPIRED'))`

export interface SweepOptions {
  /** Opportunities per batch; each one is its own short transaction. */
  readonly batchSize?: number
  /** Batches per call, so one tick stays bounded. */
  readonly maxBatches?: number
}

export interface SweepResult {
  readonly deleted: number
  readonly tombstoned: number
}

const READ_COMMITTED = { isolationLevel: 'read committed' } as const

/** The daily sweep: purge up to `batchSize * maxBatches` opportunities, one transaction each. */
export async function purgeRetiredOpportunities(
  db: MeterDb,
  { batchSize = 200, maxBatches = 50 }: SweepOptions = {},
): Promise<SweepResult> {
  let deleted = 0
  let tombstoned = 0
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const { rows } = await db.execute(
      sql`SELECT o.id FROM job_opportunities o WHERE ${retiredOpportunityPredicate}
           ORDER BY o.id LIMIT ${batchSize}`,
    )
    for (const row of rows) {
      const outcome = await db.transaction(
        (tx) => purgeOpportunity(tx, String(row['id'])),
        READ_COMMITTED,
      )
      if (outcome === 'DELETED') deleted += 1
      else if (outcome === 'TOMBSTONED') tombstoned += 1
    }
    if (rows.length < batchSize) break
  }
  return { deleted, tombstoned }
}
