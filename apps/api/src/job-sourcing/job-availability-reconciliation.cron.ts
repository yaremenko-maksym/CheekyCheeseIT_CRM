import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Cron } from '@nestjs/schedule'
import type { Env } from '../config/env'
import { DatabaseService } from '../database/database.service'
import { dbErrorLogSuffix, safeErrorStack } from '../database/pg-errors'
import { AVAILABILITY_RECONCILE_WORKER } from './runtime/availability-reconcile-worker'
import { DIRTY_BATCH_DEFAULT, recoverExpiredDirty } from './ownership/dirty-work.store'
import type { RecomputeWorker } from './runtime/recompute-worker'

/** Every 6h at :37, a minute no other job-sourcing cron holds. */
export const AVAILABILITY_RECONCILIATION_CRON = '37 */6 * * *'
/** Expired leases returned to the queue per tick (the store's own ceiling). */
export const AVAILABILITY_RECONCILE_RECOVER_BATCH = 1000
/** Batches one tick drains before yielding to the next tick (bounded tick, AC4). */
export const AVAILABILITY_MAX_DRAIN_BATCHES = 10

/**
 * Periodic availability reconciliation (r5 Task 4.6 S8d): recover expired leases, then drain the
 * availability dirty-work consumer.
 *
 * FLAG: `JOB_AVAILABILITY_RECONCILE_ENABLED`, default OFF (see `config/env.ts`), distinct from
 * `JOB_MATCH_RECONCILIATION_ENABLED`. When off, the tick is a no-op: the worker never runs, so the
 * S8c close-path's enqueued rows are consumed by nothing until the owner flips the flag — AND the
 * flag must not be on against the same queue as the match reconciliation (see the worker's
 * COEXISTENCE note).
 *
 * BOUNDED / RESUMABLE / NO-OVERLAP (AC4). The queue IS the cursor: there is no in-memory scan
 * position, so a restart mid-sweep simply re-claims the PENDING rows that are left (claiming is
 * resumable and lease recovery returns a crashed worker's rows). A tick is bounded by the batch cap
 * x `AVAILABILITY_MAX_DRAIN_BATCHES`; the backlog carries to the next tick. A tick while a sweep is
 * still running is skipped (`running`). Never rethrows (an unhandled rejection in a `@Cron` handler
 * kills the scheduler).
 */
@Injectable()
export class JobAvailabilityReconciliationCronService {
  private readonly logger = new Logger(JobAvailabilityReconciliationCronService.name)
  private running = false

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AVAILABILITY_RECONCILE_WORKER) private readonly worker: RecomputeWorker,
    @Optional() @Inject(ConfigService) private readonly config?: ConfigService<Env, true>,
  ) {}

  @Cron(AVAILABILITY_RECONCILIATION_CRON)
  async handleReconciliation(): Promise<void> {
    if (this.config?.get('JOB_AVAILABILITY_RECONCILE_ENABLED', { infer: true }) !== true) return
    if (this.running) {
      this.logger.warn('Availability reconciliation: previous sweep still running, tick skipped')
      return
    }
    this.running = true
    const startedAt = performance.now()
    try {
      const recovered = await recoverExpiredDirty(this.db.db, {
        batchSize: AVAILABILITY_RECONCILE_RECOVER_BATCH,
      })
      const drained = await this.drain()
      // Counts only, no personal data.
      this.logger.log(
        `Availability reconciliation: claimed=${drained.claimed} done=${drained.done} ` +
          `deferred=${drained.deferred} retried=${drained.retried} failed=${drained.failed} ` +
          `fenced=${drained.fenced} batches=${drained.batches} ` +
          `recoveredRequeued=${recovered.requeued} recoveredFailed=${recovered.failed} ` +
          `durationMs=${Math.round(performance.now() - startedAt)}`,
      )
    } catch (err: unknown) {
      this.logger.error(
        `Availability reconciliation failed; will retry next tick${dbErrorLogSuffix(err)}`,
        safeErrorStack(err),
      )
    } finally {
      this.running = false
    }
  }

  /** Run the worker until a batch comes back short (fewer than a full batch), at most the drain cap. */
  private async drain(): Promise<{
    claimed: number
    done: number
    deferred: number
    retried: number
    failed: number
    fenced: number
    batches: number
  }> {
    const total = { claimed: 0, done: 0, deferred: 0, retried: 0, failed: 0, fenced: 0, batches: 0 }
    for (let i = 0; i < AVAILABILITY_MAX_DRAIN_BATCHES; i += 1) {
      const r = await this.worker.runOnce()
      total.claimed += r.claimed
      total.done += r.done
      total.deferred += r.deferred
      total.retried += r.retried
      total.failed += r.failed
      total.fenced += r.fenced
      total.batches += 1
      if (r.claimed < DIRTY_BATCH_DEFAULT) break
    }
    return total
  }
}
