import { randomUUID } from 'node:crypto'
import { ForbiddenException, Inject, Injectable } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { sql } from 'drizzle-orm'
import { DatabaseService } from '../../database/database.service'
import { dirtyConsumerPredicate } from '../ownership/dirty-work.store'
import type { SqlExecutor } from '../scheduling/host-state'

/** The `trigger_key` prefix of a MANUAL cycle that is a recompute run, not a collection. */
export const RECOMPUTE_TRIGGER_PREFIX = 'RECOMPUTE:'
/** The dirty-row reason prefix; the run id makes each run a fresh key (MATCH partition). */
export const RECOMPUTE_REASON_PREFIX = 'ADMIN_RECOMPUTE:'
/** Serializes two ADMINs pressing the button at once: one run, never two. */
const RECOMPUTE_LOCK_KEY = 'job_queue:recompute'

/**
 * r5 Task 6.4 — `POST /job-queue/recompute`: ENQUEUE a match recompute, never run it inline.
 *
 * THE RUN reuses the Task 4.6 seams, no new table: the run is a MANUAL `job_collection_cycles` row
 * (`trigger_key = RECOMPUTE:<uuid>`, `requested_by` = the ADMIN: the durable audit of who asked),
 * and its work is one `job_dirty_work` row per OPEN or UNKNOWN opportunity at its current revision,
 * tied to the run by `cycle_id`. The recompute worker drains them as any MATCH-partition row (the
 * match reconciliation cron, behind `JOB_MATCH_RECONCILIATION_ENABLED`). The run id is the cycle id.
 *
 * REPEAT: while a run still has PENDING or CLAIMED rows, a new request answers with THAT run's id
 * and enqueues nothing. A run whose rows are all terminal is closed here (the cycle's obligation:
 * CLOSED only once every work item is terminal) and a new one opened. An opportunity with a MATCH
 * row already in flight at its revision is skipped: that row recomputes it anyway.
 */
@Injectable()
export class JobQueueRecomputeService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /**
   * Answers the id of the live run, or of a newly opened one.
   *
   * ZERO WORK: when no opportunity is eligible (none OPEN/UNKNOWN, or every one already has a MATCH
   * row in flight), the new run is CLOSED in the same transaction and its id is STILL returned. A
   * client polling that id therefore sees a CLOSED cycle with no work items: the run is complete,
   * not failed.
   */
  async enqueue(user: SessionUser): Promise<{ runId: string }> {
    // Defense in depth behind the controller's RolesGuard.
    if (user.role !== 'ADMIN') throw new ForbiddenException()
    return this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${RECOMPUTE_LOCK_KEY}, 0))`,
      )
      const pending = await this.pendingRun(tx)
      if (pending !== null) return { runId: pending }
      const runId = await this.openRun(tx, user.id)
      const { rows } = await tx.execute(
        sql`INSERT INTO job_dirty_work (entity_kind, entity_id, target_version, reason, cycle_id)
            SELECT 'OPPORTUNITY'::job_dirty_work_entity_kind, o.id, o.revision,
                   ${`${RECOMPUTE_REASON_PREFIX}${runId}`}, ${runId}::uuid
              FROM job_opportunities o
             WHERE o.availability IN ('OPEN', 'UNKNOWN')
               -- A manual card is never match-evaluated (r5 Phase 6, SR-M-1).
               AND o.manual_team_id IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM job_dirty_work w
                  WHERE w.entity_kind = 'OPPORTUNITY' AND w.entity_id = o.id
                    AND w.target_version = o.revision AND w.status IN ('PENDING', 'CLAIMED')
                    AND ${dirtyConsumerPredicate('MATCH', sql`w.reason`)})
            ON CONFLICT (entity_kind, entity_id, target_version, reason) DO NOTHING
            RETURNING id`,
      )
      // Nothing to do: the run is complete the moment it opens.
      if (rows.length === 0) await this.closeRuns(tx, [runId])
      return { runId }
    })
  }

  /** The oldest open run with work in flight; open runs with none are closed on the way. */
  private async pendingRun(tx: SqlExecutor): Promise<string | null> {
    const { rows } = await tx.execute(
      sql`SELECT c.id,
                 EXISTS (SELECT 1 FROM job_dirty_work w
                          WHERE w.cycle_id = c.id AND w.status IN ('PENDING', 'CLAIMED')) AS in_flight
            FROM job_collection_cycles c
           WHERE c.trigger = 'MANUAL' AND c.status = 'OPEN'
             AND starts_with(c.trigger_key, ${RECOMPUTE_TRIGGER_PREFIX})
           ORDER BY c.started_at, c.id`,
    )
    const live = rows.find((r) => r['in_flight'] === true)
    const done = rows.filter((r) => r['in_flight'] !== true).map((r) => String(r['id']))
    if (done.length > 0) await this.closeRuns(tx, done)
    return live === undefined ? null : String(live['id'])
  }

  private async openRun(tx: SqlExecutor, actorId: string): Promise<string> {
    const { rows } = await tx.execute(
      sql`INSERT INTO job_collection_cycles (trigger, trigger_key, requested_by)
          VALUES ('MANUAL', ${`${RECOMPUTE_TRIGGER_PREFIX}${randomUUID()}`}, ${actorId}::uuid)
          RETURNING id`,
    )
    const id = rows[0]?.['id']
    if (typeof id !== 'string') throw new Error('recompute: no cycle row')
    return id
  }

  private async closeRuns(tx: SqlExecutor, ids: readonly string[]): Promise<void> {
    await tx.execute(
      sql`UPDATE job_collection_cycles SET status = 'CLOSED', closed_at = clock_timestamp()
           WHERE status = 'OPEN'
             AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)`,
    )
  }
}
