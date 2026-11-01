/**
 * The record REOPEN DB adapter (r5 Task 4.6 S8f; ADR
 * `docs/architecture/2026-11-01-availability-reconciliation.md`, Decision 6, S8f).
 *
 * A CLOSED or EXPIRED record that a successful run lists AGAIN (after the instant it was closed or
 * expired) is OBSERVED OPEN: `deriveRecordAvailability` says `open` with `OBSERVED_OPEN` evidence,
 * `reopenRecord` writes it, and the owning opportunities are enqueued so the S8d opportunity path
 * re-derives toward OPEN and bumps the opportunity `revision`. Everything runs in ONE transaction
 * under the record lock, so a rollback undoes the flip and the enqueue together.
 *
 * It never touches `job_opportunity_matches` or suggestion decisions: a reopened opportunity
 * re-surfaces the decisions it already had. Ships DARK: reached only from the availability worker
 * behind `JOB_AVAILABILITY_RECONCILE_ENABLED`.
 */
import { Logger } from '@nestjs/common'
import { type JobCollectionCoverage, availabilityEvidenceSchema } from '@crm/shared'
import { sql } from 'drizzle-orm'
import type { MeterDb } from '../metering/account-meter.store'
import { reopenRecord } from '../store/source-record.store'
import { deriveRecordAvailability } from './derive-availability'
import {
  type InventoryUpdateInput,
  enqueueOwners,
  lockAndVerifyRecord,
} from './inventory-counter-updater'

// Stryker disable next-line StringLiteral: the logger context is a cosmetic label in log output only; no behaviour depends on it, so there is nothing to assert
const logger = new Logger('RecordReopenUpdater')
const READ_COMMITTED = { isolationLevel: 'read committed' } as const

/** `job_dirty_work.reason` of the opportunity recompute a record reopen enqueues (<= 100 chars). */
// Stryker disable next-line StringLiteral: the persisted reason string is observed by the integration spec (dirtyCount filters on 'RECORD_REOPENED' spelled out); the unit mutation run does not execute that spec
export const RECORD_REOPEN_REASON = 'RECORD_REOPENED'

export interface RecordReopenResult {
  /** The record was flipped back to OPEN and its opportunities enqueued. */
  readonly reopened: boolean
}

/**
 * Reopen the record when a SUCCEEDED run of its source listed it after it was closed/expired. The
 * run's coverage does not matter: being listed is the observation (`present`), whatever the
 * coverage. The newest such run supplies the evidence and the cycle.
 */
export async function reopenObservedRecord(
  db: MeterDb,
  input: InventoryUpdateInput,
): Promise<RecordReopenResult> {
  return db.transaction(async (tx) => {
    await lockAndVerifyRecord(tx, input)
    const { rows } = await tx.execute(
      sql`SELECT cr.id, cr.cycle_id, cr.coverage::text AS coverage,
                 coalesce(cr.ended_at, cr.started_at) AS observed_at
            FROM job_source_records rec
            JOIN job_run_records jr ON jr.source_record_id = rec.id
            JOIN job_collection_runs cr ON cr.id = jr.run_id
           WHERE rec.id = ${input.sourceRecordId}::uuid
             AND rec.availability IN ('CLOSED'::job_availability, 'EXPIRED'::job_availability)
             AND cr.source_id = ${input.sourceId}::uuid
             AND cr.config_version = ${input.configVersion}
             AND cr.outcome = 'SUCCEEDED'::job_collection_outcome
             AND coalesce(cr.ended_at, cr.started_at)
                 > coalesce(rec.availability_checked_at, '-infinity'::timestamptz)
           ORDER BY coalesce(cr.ended_at, cr.started_at) DESC, cr.id DESC
           LIMIT 1`,
    )
    const run = rows[0]
    if (run === undefined) return { reopened: false }

    const decision = deriveRecordAvailability({
      present: true,
      coverage: String(run['coverage']) as JobCollectionCoverage,
      runId: String(run['id']),
      board: input.board,
      configVersion: input.configVersion,
      observedAt: new Date(run['observed_at'] as string | number | Date).toISOString(),
    })
    // `present: true` always derives `open`; the narrowing is for the type, not a reachable branch.
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable with present=true
    if (decision.kind !== 'open') return { reopened: false }

    const evidence = availabilityEvidenceSchema.parse(decision.evidence)
    const reopened = await reopenRecord(tx, input.sourceRecordId, evidence)
    if (reopened) {
      const cycleId = run['cycle_id'] == null ? null : String(run['cycle_id'])
      await enqueueOwners(tx, input.sourceRecordId, cycleId, RECORD_REOPEN_REASON)
    }
    // Structured trace, no PII (board/config only).
    logger.log(
      // Stryker disable next-line StringLiteral: log text only; no behaviour depends on it, so there is nothing to assert
      `record-reopen reopened=${reopened}: board=${input.board} configVersion=${input.configVersion}`,
    )
    return { reopened }
  }, READ_COMMITTED)
}
