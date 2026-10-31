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
 * others), so the row enqueues an OPPORTUNITY recompute for every opportunity in SCOPE, and the
 * S4a path does the rest.
 *
 * SCOPE (SR-M-2, SPEC-L-2). ACTIVE (availability OPEN or UNKNOWN) or CLAIMED (a TAKEN queue
 * assignment) opportunities, no date window. A CLOSED / EXPIRED, unclaimed opportunity cannot be
 * offered to anyone, so a roster change cannot change what it shows; the S4b sweep still covers
 * every opportunity.
 *
 * BOUNDED AND RESUMABLE. One pass handles at most `FANOUT_PAGE_SIZE` opportunities in id order, in
 * ONE statement (CR-M-4). When the page is full, the pass also enqueues a CONTINUATION row of the
 * same kind and entity whose reason carries the root row's id and the last opportunity id (the
 * cursor), then completes. The continuation keeps the root's version (the reason alone makes it a
 * new key): bumping it would mark a concurrent producer's newer row stale and skip that row's full
 * fan-out, while at the same version a newer write simply makes the continuation stale, and the
 * newer row starts over from the first opportunity.
 *
 * IDEMPOTENT AND COALESCED. Every OPPORTUNITY row is enqueued at the opportunity's current revision
 * under the reason `fanout:<root id>`, so re-running a pass inserts nothing twice. An opportunity
 * that already has a PENDING (unclaimed) row at its current revision is skipped (SR-M-2): that row
 * has not read the roster yet, so it already covers this change. N roster writes between two
 * worker runs therefore leave at most one pending recompute per opportunity.
 *
 * STALE. A row that is no longer the entity's newest is completed without work: the newer row
 * (a later write, or this row's own continuation) fans out from the start or from its cursor.
 *
 * FAILURES (AC 5). An opportunity whose revision cannot be a version (< 1) is skipped and counted
 * inside the statement; its own recompute, not the pass, is where bad data fails. Any database
 * error aborts the whole pass: the transaction rolls back, the worker fails the row, and the retry
 * redoes the same page (nothing of it was committed).
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
  const only =
    opts.onlyIds === undefined
      ? sql``
      : sql`AND o.id IN (SELECT jsonb_array_elements_text(${JSON.stringify(opts.onlyIds)}::jsonb)::uuid)`
  const { rows } = await tx.execute(sql`
    WITH page AS (
      SELECT o.id, o.revision FROM job_opportunities o
       WHERE o.id > ${after}::uuid
         AND (o.availability IN ('OPEN', 'UNKNOWN')
              OR EXISTS (SELECT 1 FROM job_queue_assignments a
                          WHERE a.opportunity_id = o.id AND a.state = 'TAKEN'))
         ${only}
       ORDER BY o.id LIMIT ${pageSize}),
    ins AS (
      INSERT INTO job_dirty_work (entity_kind, entity_id, target_version, reason)
      SELECT 'OPPORTUNITY', p.id, p.revision, ${`${ROOT}${root}`} FROM page p
       WHERE p.revision >= 1
         AND NOT EXISTS (SELECT 1 FROM job_dirty_work d
                          WHERE d.entity_kind = 'OPPORTUNITY' AND d.entity_id = p.id
                            AND d.target_version = p.revision AND d.status = 'PENDING')
      ON CONFLICT (entity_kind, entity_id, target_version, reason) DO NOTHING
      RETURNING 1)
    SELECT (SELECT count(*) FROM page)::int AS paged,
           (SELECT count(*) FROM page WHERE revision < 1)::int AS invalid,
           (SELECT count(*) FROM ins)::int AS enqueued,
           (SELECT id::text FROM page ORDER BY id DESC LIMIT 1) AS last`)
  const r = rows[0] ?? {}
  const enqueued = Number(r['enqueued'] ?? 0)
  const skipped = Number(r['invalid'] ?? 0)
  const continued = Number(r['paged'] ?? 0) === pageSize
  if (continued) {
    await enqueueDirty(
      tx,
      work.entityKind,
      work.entityId,
      work.targetVersion,
      `${ROOT}${root}:${String(r['last'])}`,
    )
  }
  return { outcome: await completeDirty(tx, work), enqueued, skipped, continued }
}
