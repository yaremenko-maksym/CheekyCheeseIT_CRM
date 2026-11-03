/**
 * The 404/410 detail-closure path (r5 Task 4.6 S8g; ADR
 * `docs/architecture/2026-11-01-availability-reconciliation.md`, Decision 2 and Decision 6 S8g;
 * SFS `2026-10-25-source-fetch-strategy.md` section 6a, change #5 "Failure").
 *
 * The U10 detail tail (bounded by `detailPerRun`, metered through the run's context, resumable via
 * the `DETAIL_FETCH` dirty rows) already maps a provider `GONE` to `recordGone`. This module is the
 * S8g version of that one step, swapped in through the run worker's `detailTailPortFactory` seam:
 *
 *   - only a board with a TESTED `GONE` contract closes (`DETAIL_GONE_CONTRACT_TYPES`, Greenhouse
 *     only on day one — ADR open question 4, A2). Any other board's `GONE` is treated as `FAILED`
 *     (poisoned, never closes), as Decision 2 requires for an adapter without the contract;
 *   - the close goes through the existing record writer (`closeRecordByInventory`, the S8c
 *     already-CLOSED guard) and the existing owner enqueue (`enqueueOwners`), so the opportunity
 *     grain is re-derived by the S8d availability consumer (most-open over active links, revision
 *     bump, match successor row). Matches and suggestion decisions are never touched here.
 *
 * DARK: `JOB_DETAIL_GONE_CLOSURE_ENABLED` (default false) selects this port; OFF is exactly U10.
 * UNREACHABLE until the ON_DEMAND flip (#10): the tail only runs for an adapter carrying
 * `collectDetail`, and the manifest keeps every source `IN_LIST`. Every detail tail runs inside a
 * ledger run that ends through `endRun` -> `account()`, which is NOT scope-aware yet (SR-M-1 of
 * #1232: a DETAIL_ONLY ending would rewrite the LIST run's failure/cooldown/validator state), and the
 * 14-day re-fetch lacks its freshness anchor (CR-M-3). Both ride with #10; do not enable this flag
 * before #10 lands.
 */
import {
  type AvailabilityEvidence,
  type JobSourceType,
  availabilityEvidenceSchema,
} from '@crm/shared'
import { sql } from 'drizzle-orm'
import { AVAILABILITY_REASON_PREFIX, completeDirty } from '../ownership/dirty-work.store'
import {
  type ClaimedDetail,
  type DetailTailPort,
  type DetailTailPortDeps,
  createDetailTailPort,
} from '../runtime/detail-tail'
import type { SqlExecutor } from '../scheduling/host-state'
import { closeRecordByInventory } from '../store/source-record.store'
import { enqueueOwners } from './inventory-counter-updater'

/** The opportunity recompute a detail-GONE closure enqueues: the AVAILABILITY partition. */
export const DETAIL_GONE_CLOSE_REASON = `${AVAILABILITY_REASON_PREFIX}DETAIL_GONE`

/** `last_error_code` of a GONE from a board without a tested contract (treated as FAILED). */
export const DETAIL_GONE_UNCONTRACTED = 'DETAIL_GONE_UNCONTRACTED'

/**
 * The boards whose detail adapter has PROVEN the Decision-2 contract (host-pinned request builder,
 * status-first parser, identity re-verification, named 404/5xx/drift/FOUND tests — Greenhouse:
 * `greenhouse.detail.spec.ts`). Add a type only together with its own contract tests.
 */
export const DETAIL_GONE_CONTRACT_TYPES: readonly JobSourceType[] = ['GREENHOUSE_ATS']

export function hasDetailGoneContract(type: JobSourceType): boolean {
  return DETAIL_GONE_CONTRACT_TYPES.includes(type)
}

/**
 * Close a source record on a tested-adapter GONE, inside the caller's transaction (the caller holds
 * the record lock). Returns whether it closed; an already-CLOSED record enqueues nothing.
 */
export async function closeRecordByDetailGone(
  tx: SqlExecutor,
  recordId: string,
  evidence: AvailabilityEvidence,
): Promise<boolean> {
  const parsed = availabilityEvidenceSchema.parse(evidence)
  if (parsed.kind !== 'DETAIL_GONE')
    throw new RangeError('closeRecordByDetailGone: only DETAIL_GONE evidence closes here')
  const closed = await closeRecordByInventory(tx, recordId, parsed)
  // shortcut: no cycle id — the detail port does not carry the run's cycle; add it with #10.
  if (closed) await enqueueOwners(tx, recordId, null, DETAIL_GONE_CLOSE_REASON)
  return closed
}

/** The U10 port with `recordGone` replaced by the contract-gated, owner-enqueuing S8g closure. */
export function createDetailGoneClosurePort(
  base: DetailTailPort,
  deps: DetailTailPortDeps,
): DetailTailPort {
  return {
    ...base,
    async recordGone(row: ClaimedDetail) {
      if (!hasDetailGoneContract(deps.source.type)) {
        await base.fail(row, DETAIL_GONE_UNCONTRACTED, true)
        return
      }
      await deps.db.transaction(async (tx) => {
        // Hold the record so a concurrent observation writer cannot re-list it between read and write.
        await tx.execute(
          sql`SELECT 1 FROM job_source_records WHERE id = ${row.recordId}::uuid FOR UPDATE`,
        )
        await closeRecordByDetailGone(tx, row.recordId, {
          kind: 'DETAIL_GONE',
          // Greenhouse maps only a 404 to GONE (`parseGreenhouseDetail`).
          httpStatus: 404,
          adapterVersion: deps.adapterVersion,
          // The S8 board key, the same `${type}:${namespace}` the inventory/window paths use.
          board: `${deps.source.type}:${deps.source.namespace}`,
          configVersion: deps.configVersion,
          runId: deps.runId,
          observedAt: deps.now().toISOString(),
        })
        await completeDirty(tx, row.handle)
      })
    },
  }
}

/** The run worker's `detailTailPortFactory` for the flag value: OFF is the U10 factory itself. */
export function detailTailPortFactory(
  enabled: boolean,
): (deps: DetailTailPortDeps) => DetailTailPort {
  if (!enabled) return createDetailTailPort
  return (deps) => createDetailGoneClosurePort(createDetailTailPort(deps), deps)
}
