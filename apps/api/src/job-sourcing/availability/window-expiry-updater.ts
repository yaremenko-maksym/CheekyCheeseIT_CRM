/**
 * The WINDOW-coverage expiry DB adapter (r5 Task 4.6 S8e; ADR
 * `docs/architecture/2026-11-01-availability-reconciliation.md`, Decision 6, S8e).
 *
 * Counterpart of `updateInventoryMissCounter` for sources whose latest valid run is WINDOW: a record
 * not seen within the source's freshness allowance (`freshnessMaxAgeMsFor`, the STALE_FEED signal)
 * is marked EXPIRED with `WINDOW_DROPPED` evidence — never CLOSED, and it never touches the D4 miss
 * counter (so it needs no `job_source_record_inventory_misses` table). EXPIRED is reversible; the
 * reopen is S8f. Matches and suggestion decisions are not touched.
 *
 * Ships DARK: reached only from the worker behind `JOB_AVAILABILITY_RECONCILE_ENABLED`.
 */
import { Logger } from '@nestjs/common'
import { type JobSourceType, availabilityEvidenceSchema } from '@crm/shared'
import { sql } from 'drizzle-orm'
import { freshnessMaxAgeMsFor } from '../health/provider-facts'
import type { MeterDb } from '../metering/account-meter.store'
import type { SqlExecutor } from '../scheduling/host-state'
import { expireRecordByWindow } from '../store/source-record.store'
import { deriveRecordAvailability } from './derive-availability'
import {
  type InventoryUpdateInput,
  enqueueOwners,
  lockAndVerifyRecord,
} from './inventory-counter-updater'

// Stryker disable next-line StringLiteral: the logger context is a cosmetic label in log output only; no behaviour depends on it, so there is nothing to assert
const logger = new Logger('WindowExpiryUpdater')
const READ_COMMITTED = { isolationLevel: 'read committed' } as const

/** `job_dirty_work.reason` of the opportunity recompute a record expiry enqueues (<= 100 chars). */
// Stryker disable next-line StringLiteral: the persisted reason string is observed by the integration spec (dirtyCount filters on it), which the unit mutation run does not execute
export const WINDOW_EXPIRE_REASON = 'RECORD_WINDOW_EXPIRED'

export interface WindowRun {
  readonly runId: string
  readonly cycleId: string | null
  /** ISO datetime of the run's observation. */
  readonly observedAt: string
}

/**
 * The source's latest SUCCEEDED run at its current config version, when (and only when) it is
 * WINDOW coverage — the signal that routes a record to this path instead of the FULL_INVENTORY
 * counter. `null` for any other coverage or no run.
 */
export async function readLatestWindowRun(
  db: SqlExecutor,
  input: Pick<InventoryUpdateInput, 'sourceId' | 'configVersion'>,
): Promise<WindowRun | null> {
  const { rows } = await db.execute(
    sql`SELECT id, cycle_id, coverage::text AS coverage,
               coalesce(ended_at, started_at) AS observed_at
          FROM job_collection_runs
         WHERE source_id = ${input.sourceId}::uuid AND config_version = ${input.configVersion}
           AND outcome = 'SUCCEEDED'::job_collection_outcome
         ORDER BY coalesce(ended_at, started_at) DESC, id DESC
         LIMIT 1`,
  )
  const r = rows[0]
  if (r === undefined || r['coverage'] !== 'WINDOW') return null
  return {
    runId: String(r['id']),
    cycleId: r['cycle_id'] == null ? null : String(r['cycle_id']),
    observedAt: new Date(r['observed_at'] as string | number | Date).toISOString(),
  }
}

export interface WindowExpiryResult {
  /** The record was marked EXPIRED and its opportunities enqueued. */
  readonly expired: boolean
}

/**
 * Expire the record when it is outside its source's freshness window, in ONE transaction: lock the
 * record (`FOR UPDATE`, serialises with the observation writer), read its last-seen and whether the
 * window run listed it, derive, and on `expired` write EXPIRED + enqueue the owning opportunities.
 */
export async function expireWindowRecord(
  db: MeterDb,
  input: InventoryUpdateInput,
  run: WindowRun,
): Promise<WindowExpiryResult> {
  return db.transaction(async (tx) => {
    await lockAndVerifyRecord(tx, input)
    const { rows } = await tx.execute(
      sql`SELECT s.type::text AS source_type, r.last_observed_at,
                 EXISTS (SELECT 1 FROM job_run_records jr
                          WHERE jr.run_id = ${run.runId}::uuid AND jr.source_record_id = r.id)
                   AS present
            FROM job_source_records r
            JOIN job_sources s ON s.id = ${input.sourceId}::uuid
           WHERE r.id = ${input.sourceRecordId}::uuid`,
    )
    const row = rows[0]
    if (row === undefined) return { expired: false }
    const lastSeen = row['last_observed_at']
    const decision = deriveRecordAvailability({
      present: row['present'] === true,
      coverage: 'WINDOW',
      runId: run.runId,
      board: input.board,
      configVersion: input.configVersion,
      observedAt: run.observedAt,
      lastSeenAt:
        lastSeen == null ? null : new Date(lastSeen as string | number | Date).toISOString(),
      freshnessMaxAgeMs: freshnessMaxAgeMsFor(String(row['source_type']) as JobSourceType),
    })
    if (decision.kind !== 'expired') return { expired: false }

    const evidence = availabilityEvidenceSchema.parse(decision.evidence)
    const expired = await expireRecordByWindow(tx, input.sourceRecordId, evidence)
    if (expired) await enqueueOwners(tx, input.sourceRecordId, run.cycleId, WINDOW_EXPIRE_REASON)
    // Structured trace, no PII (board/config only).
    logger.log(
      `window-expire${expired ? '' : ' (no-op, already expired or closed)'}: board=${input.board} configVersion=${input.configVersion}`,
    )
    return { expired }
  }, READ_COMMITTED)
}
