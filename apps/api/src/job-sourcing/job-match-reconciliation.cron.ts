import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Cron } from '@nestjs/schedule'
import type { Env } from '../config/env'
import { DatabaseService } from '../database/database.service'
import { dbErrorLogSuffix, safeErrorStack } from '../database/pg-errors'
import { DIRTY_BATCH_DEFAULT, recoverExpiredDirty } from './ownership/dirty-work.store'
import {
  RECONCILE_MAX_DRAIN_BATCHES,
  RECONCILE_PERIOD_HOURS,
  reconcileOnce,
} from './runtime/reconciliation'
import { RecomputeWorker } from './runtime/recompute-worker'

/** Every RECONCILE_PERIOD_HOURS at :17, a minute no other cron holds. */
export const MATCH_RECONCILIATION_CRON = `17 */${RECONCILE_PERIOD_HOURS} * * *`
/** Expired leases returned to the queue per tick (the store's own ceiling). */
export const RECONCILE_RECOVER_BATCH = 1000

/**
 * Periodic match reconciliation (r5 Task 4.6 S4b): sweep, then drain the S4a recompute worker.
 *
 * FLAG: `JOB_MATCH_RECONCILIATION_ENABLED`, default OFF (see `config/env.ts`). The collection crons
 * have no flag; this one differs because it activates writes nothing reads yet.
 * STALENESS (SR-M-2, CR-M-1, SPEC-L-1): not "one period". A tick sweeps at most 100,000 opportunities
 * and drains at most RECONCILE_MAX_DRAIN_BATCHES x 200 = 2,000 dirty rows; both carry over to the
 * next tick. The bound is P x (ceil(N / 100,000) + ceil(S / 2,000)) with P = RECONCILE_PERIOD_HOURS
 * (6 h): one period for up to 2,000 stale rows, up to 50 more periods (300 h) when 100,000 are
 * stale at once. The drain cap is documented rather than raised (it is 200 transactions per batch
 * on a database every other cron shares). Full derivation: `runtime/reconciliation.ts`.
 * RECOVERY (SR-M-1): each tick first returns expired CLAIMED leases to the queue
 * (`recoverExpiredDirty`), so a crashed worker's rows are retried, not stuck.
 * NO OVERLAP: a tick while a sweep runs is skipped. The cursor lives in memory: a restart rescans
 * from the start, which is cheap because enqueueing is idempotent and a sweep is bounded pages.
 * Never rethrows (C-23): an unhandled rejection in a `@Cron` handler kills the scheduler.
 */
@Injectable()
export class JobMatchReconciliationCronService {
  private readonly logger = new Logger(JobMatchReconciliationCronService.name)
  private running = false
  private cursor: string | null = null

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(RecomputeWorker) private readonly worker: RecomputeWorker,
    @Optional() @Inject(ConfigService) private readonly config?: ConfigService<Env, true>,
  ) {}

  @Cron(MATCH_RECONCILIATION_CRON)
  async handleReconciliation(): Promise<void> {
    if (this.config?.get('JOB_MATCH_RECONCILIATION_ENABLED', { infer: true }) !== true) return
    if (this.running) {
      this.logger.warn('Match reconciliation: previous sweep still running, tick skipped')
      return
    }
    this.running = true
    const startedAt = performance.now()
    try {
      const recovered = await recoverExpiredDirty(this.db.db, {
        batchSize: RECONCILE_RECOVER_BATCH,
      })
      const report = await reconcileOnce(this.db.db, { cursor: this.cursor })
      this.cursor = report.cursor
      const drained = await this.drain()
      // Counts only, no personal data.
      this.logger.log(
        `Match reconciliation: scanned=${report.scanned} stale=${report.stale} ` +
          `enqueued=${report.enqueued} skipped=${report.skipped} failed=${report.failed} pages=${report.pages} ` +
          `resumeCursor=${report.cursor === null ? 'none' : 'set'} recomputed=${drained} ` +
          `recoveredRequeued=${recovered.requeued} recoveredFailed=${recovered.failed} ` +
          `durationMs=${Math.round(performance.now() - startedAt)}`,
      )
    } catch (err: unknown) {
      this.logger.error(
        `Match reconciliation failed; will retry next tick${dbErrorLogSuffix(err)}`,
        safeErrorStack(err),
      )
    } finally {
      this.running = false
    }
  }

  /** Run the recompute worker until a batch comes back short (fewer than a full batch), at most the drain limit. */
  private async drain(): Promise<number> {
    let claimed = 0
    for (let i = 0; i < RECONCILE_MAX_DRAIN_BATCHES; i += 1) {
      const r = await this.worker.runOnce()
      claimed += r.claimed
      if (r.claimed < DIRTY_BATCH_DEFAULT) break
    }
    return claimed
  }
}
