import type { JobAvailability } from '@crm/shared'
import { sql } from 'drizzle-orm'
import { updateInventoryMissCounter } from '../availability/inventory-counter-updater'
import { deriveOpportunityAvailability } from '../availability/derive-availability'
import { reopenObservedRecord } from '../availability/record-reopen-updater'
import { expireWindowRecord, readLatestWindowRun } from '../availability/window-expiry-updater'
import type { MeterDb } from '../metering/account-meter.store'
import {
  type ClaimedDirtyWork,
  type CompleteOutcome,
  claimDirtyBatch,
  completeDirty,
  failDirty,
} from '../ownership/dirty-work.store'
import type { SqlExecutor } from '../scheduling/host-state'
import type { RecomputeSteps } from './recompute-worker'

/**
 * The availability reconciliation consumer (r5 Task 4.6 S8d; ADR
 * `docs/architecture/2026-11-01-availability-reconciliation.md`, Decision 6, S8d). It is the
 * consumer S8c's close-path `enqueueDirty` feeds, and the thing that applies the S8b/S8c machinery
 * to the dirty-work queue. Ships DARK behind `JOB_AVAILABILITY_RECONCILE_ENABLED` (default OFF).
 *
 * It reuses the generic `RecomputeWorker` claim/batch/fence/retry loop (S4a) — the same bounded
 * batch, SOURCE_RECORD-first ordering, per-row failure isolation and classify/retry policy — and
 * supplies only an availability PORT:
 *
 *   SOURCE_RECORD  resolve the record onto its `(sourceId, board, configVersion)` and invoke the S8c
 *                  inventory-counter updater (which runs the D4 transition, persists, and on a net
 *                  close marks the record CLOSED + enqueues its opportunities). The updater runs in
 *                  its OWN transaction and is idempotent (S8b replay watermark + `ON CONFLICT`
 *                  dedup), so the two-step "update then complete" survives a crash in between: the
 *                  row is re-claimed after its lease expires and the updater re-runs as a no-op.
 *   OPPORTUNITY    re-derive availability with `deriveOpportunityAvailability` over the ACTIVE
 *                  `job_opportunity_sources` records' availability, and when it changed write it and
 *                  bump `revision` in ONE transaction. Existing matches / suggestion decisions are
 *                  NOT touched (S8f proves a close -> reopen cycle preserves them).
 *                  Unchanged availability writes nothing (idempotent — AC6).
 *
 * COEXISTENCE (documented, not enforced). The S4a match worker claims the same SOURCE_RECORD /
 * OPPORTUNITY kinds for DIFFERENT work (canonical resolution / match recompute), and the claim
 * cannot filter by `reason` without touching the store. So this worker must NOT run against the
 * same queue at the same time as `JOB_MATCH_RECONCILIATION_ENABLED`; a reason-partitioned claim is
 * a follow-up. Both ship dark behind separate flags, so no production path is affected today.
 */

const READ_COMMITTED = { isolationLevel: 'read committed' } as const

/** The DI token for the availability worker instance (distinct from the S4a `RecomputeWorker`). */
export const AVAILABILITY_RECONCILE_WORKER = Symbol('AVAILABILITY_RECONCILE_WORKER')

/**
 * The kinds this worker claims: only the two availability grains. SENIOR / EXCLUSION /
 * PROJECT_CLIENT fan-out rows are the match worker's and are left untouched.
 */
export const AVAILABILITY_CLAIM_KINDS = ['SOURCE_RECORD', 'OPPORTUNITY'] as const

/** What the S8c updater needs, resolved from a bare SOURCE_RECORD dirty row. */
export interface ResolvedInventoryInput {
  readonly sourceRecordId: string
  readonly sourceId: string
  readonly board: string
  readonly configVersion: number
}

/**
 * Map a source record to its inventory-counter key. The record↔source tie is `(source_type,
 * namespace)` (the same tie `updateInventoryMissCounter` verifies), so the board key is
 * `${source_type}:${namespace}` and the configVersion is the source's current `config_version` —
 * the convention the S8c integration spec established, and the one this first caller fixes. Returns
 * `null` when the record has no matching source (orphan / not yet linked): there is nothing to
 * reconcile, so the dirty row is simply completed.
 */
export async function resolveInventoryInput(
  db: SqlExecutor,
  sourceRecordId: string,
): Promise<ResolvedInventoryInput | null> {
  const { rows } = await db.execute(
    sql`SELECT s.id AS source_id, s.type::text AS source_type, s.namespace, s.config_version
          FROM job_source_records r
          JOIN job_sources s ON s.type = r.source_type AND s.namespace = r.namespace
         WHERE r.id = ${sourceRecordId}::uuid
         ORDER BY s.id
         LIMIT 1`,
  )
  const row = rows[0]
  if (row === undefined) return null
  return {
    sourceRecordId,
    sourceId: String(row['source_id']),
    board: `${String(row['source_type'])}:${String(row['namespace'])}`,
    configVersion: Number(row['config_version']),
  }
}

/**
 * SOURCE_RECORD: reopen a re-listed CLOSED/EXPIRED record (S8f), then route by the source's latest valid run coverage, then complete the row. A WINDOW
 * source goes through the S8e window-drop derivation (EXPIRED, never the miss counter); anything
 * else runs the S8c inventory-counter updater. Two transactions (the updater owns its own), safe
 * because both paths are idempotent on replay.
 */
export async function reconcileSourceRecordAvailability(
  db: MeterDb,
  work: ClaimedDirtyWork,
): Promise<CompleteOutcome> {
  const input = await resolveInventoryInput(db, work.entityId)
  if (input !== null) {
    // S8f: a CLOSED/EXPIRED record listed again reopens FIRST (own tx, idempotent), so the counter
    // and window paths below see an OPEN record and never re-close it from stale history.
    await reopenObservedRecord(db, input)
    const windowRun = await readLatestWindowRun(db, input)
    if (windowRun !== null) await expireWindowRecord(db, input, windowRun)
    else await updateInventoryMissCounter(db, input)
  }
  return completeDirty(db, work)
}

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
 * OPPORTUNITY: lock the opportunity, re-derive availability from its active records, complete the
 * row (DONE while its revision is still current), then — only when the derived availability
 * CHANGED — write it and bump `revision`, all in one transaction. The row is completed BEFORE the
 * bump so a real change still reports DONE rather than DEFERRED; the bump is the Decision-4 signal
 * for downstream (matches/funnel) to re-read. Matches and suggestion decisions are never touched.
 */
export function reconcileOpportunityAvailability(
  db: MeterDb,
  work: ClaimedDirtyWork,
): Promise<CompleteOutcome> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute(
      sql`SELECT revision, availability FROM job_opportunities
           WHERE id = ${work.entityId}::uuid FOR NO KEY UPDATE`,
    )
    const row = rows[0]
    // Missing or moved on: nothing to derive; the store records ENTITY_MISSING / VERSION_STALE.
    if (row === undefined || Number(row['revision']) !== work.targetVersion)
      return completeDirty(tx, work)
    const current = String(row['availability']) as JobAvailability
    const next = deriveOpportunityAvailability(await readActiveRecordStates(tx, work.entityId))
    const outcome = await completeDirty(tx, work)
    if (next !== current)
      await tx.execute(
        sql`UPDATE job_opportunities SET availability = ${next}, revision = revision + 1
             WHERE id = ${work.entityId}::uuid`,
      )
    return outcome
  }, READ_COMMITTED)
}

/** The availability port: claim only the two availability kinds, dispatch by grain. */
export function createAvailabilityReconcileSteps(db: MeterDb): RecomputeSteps {
  return {
    claim: (owner, batchSize) =>
      claimDirtyBatch(db, { owner, batchSize, kinds: AVAILABILITY_CLAIM_KINDS }),
    process: (work) => {
      if (work.entityKind === 'SOURCE_RECORD') return reconcileSourceRecordAvailability(db, work)
      if (work.entityKind === 'OPPORTUNITY') return reconcileOpportunityAvailability(db, work)
      // The claim only hands out the two availability kinds; any other is completed untouched.
      return completeDirty(db, work)
    },
    fail: (work, code, opts) => failDirty(db, work, code, opts),
  }
}
