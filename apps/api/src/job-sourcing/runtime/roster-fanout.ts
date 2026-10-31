import { sql } from 'drizzle-orm'
import {
  type ClaimedDirtyWork,
  type CompleteOutcome,
  completeDirty,
  currentDerivedVersion,
  enqueueDirty,
} from '../ownership/dirty-work.store'
import type { SqlExecutor } from '../scheduling/host-state'

/**
 * Fan-out of roster-side dirty work (r5 Task 4.6 S5). A SENIOR / EXCLUSION / PROJECT_CLIENT row
 * says "who may see a vacancy changed"; which vacancies that touches is not knowable without
 * evaluating them (a senior who JOINS the roster can match an opportunity that has rows only for
 * others), so the row enqueues an OPPORTUNITY recompute for every opportunity — no date window,
 * the same superset of "active and claimed" the reconciliation sweeps — and the S4a path does
 * the rest.
 *
 * BOUNDED AND RESUMABLE. One pass enqueues at most `FANOUT_PAGE_SIZE` opportunities in id order.
 * When the page is full, the pass also enqueues a CONTINUATION row of the same kind and entity
 * whose reason carries the root row's id and the last opportunity id (the cursor), then completes.
 * The continuation keeps the root's version (the reason alone makes it a new key): bumping it
 * would mark a concurrent producer's newer row stale and skip that row's full fan-out, while at
 * the same version a newer write simply makes the continuation stale, and the newer row starts
 * over from the first opportunity.
 *
 * IDEMPOTENT. Every OPPORTUNITY row is enqueued at the opportunity's current revision under the
 * reason `fanout:<root id>`, so re-running a pass (a crash, a lost lease) inserts nothing twice,
 * and two different roster changes are two different reasons (both recompute; neither is
 * swallowed by the other's DONE row).
 *
 * STALE. A row that is no longer the entity's newest is completed without work: the newer row
 * (a later write, or this row's own continuation) fans out from the start or from its cursor.
 *
 * ONE BAD OPPORTUNITY. An opportunity whose revision cannot be a version is skipped and counted;
 * its own recompute, not the pass, is where bad data fails.
 */

/** MP-05: the initial page size. */
export const FANOUT_PAGE_SIZE = 200

const ROOT = 'fanout:'
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/** Where a pass starts: the root row's id and the cursor (NIL before the first page). */
export function fanoutCursor(work: Pick<ClaimedDirtyWork, 'id' | 'reason'>): {
  root: string
  after: string
} {
  const parts = work.reason.split(':')
  if (parts.length === 3 && `${parts[0]}:` === ROOT)
    return { root: `${parts[1]}`, after: `${parts[2]}` }
  return { root: work.id, after: NIL_UUID }
}

export interface FanoutOptions {
  readonly pageSize?: number
  /** Fan out only to these opportunities (a scoped run; tests use it so they touch nothing else). */
  readonly onlyIds?: readonly string[]
}

export interface FanoutResult {
  readonly outcome: CompleteOutcome
  readonly enqueued: number
  readonly skipped: number
  readonly continued: boolean
}

/** One pass of one roster-side row, inside the caller's transaction (which then commits). */
export async function fanOutDirty(
  tx: SqlExecutor,
  work: ClaimedDirtyWork,
  opts: FanoutOptions = {},
): Promise<FanoutResult> {
  const pageSize = opts.pageSize ?? FANOUT_PAGE_SIZE
  const current = await currentDerivedVersion(tx, work.entityKind, work.entityId)
  if (current !== work.targetVersion)
    return { outcome: await completeDirty(tx, work), enqueued: 0, skipped: 0, continued: false }
  const { root, after } = fanoutCursor(work)
  const { rows } = await tx.execute(
    sql`SELECT id::text AS id, revision FROM job_opportunities
         WHERE id > ${after}::uuid
           ${opts.onlyIds === undefined ? sql`` : sql`AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(opts.onlyIds)}::jsonb)::uuid)`}
         ORDER BY id LIMIT ${pageSize}`,
  )
  let enqueued = 0
  let skipped = 0
  let last = after
  for (const r of rows) {
    last = String(r['id'])
    try {
      const { inserted } = await enqueueDirty(
        tx,
        'OPPORTUNITY',
        last,
        Number(r['revision']),
        `${ROOT}${root}`,
      )
      if (inserted) enqueued += 1
    } catch (err) {
      // Only the store's own validation (a revision that is no version) is this row's fault.
      if (!(err instanceof RangeError)) throw err
      skipped += 1
    }
  }
  const continued = rows.length === pageSize
  if (continued) {
    await enqueueDirty(
      tx,
      work.entityKind,
      work.entityId,
      work.targetVersion,
      `${ROOT}${root}:${last}`,
    )
  }
  return { outcome: await completeDirty(tx, work), enqueued, skipped, continued }
}
