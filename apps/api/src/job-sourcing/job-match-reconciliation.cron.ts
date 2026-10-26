import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Cron } from '@nestjs/schedule'
import type { Env } from '../config/env'
import { DatabaseService } from '../database/database.service'
import { dbErrorLogSuffix, safeErrorStack } from '../database/pg-errors'
import { RECONCILE_PERIOD_HOURS, reconcileOnce } from './runtime/reconciliation'
import { RecomputeWorker } from './runtime/recompute-worker'

/** Every RECONCILE_PERIOD_HOURS at :17, a minute no other cron holds. */
export const MATCH_RECONCILIATION_CRON = `17 */${RECONCILE_PERIOD_HOURS} * * *`
/** Recompute batches drained after one sweep; the rest waits for the next tick. */
export const RECONCILE_MAX_DRAIN_BATCHES = 10

/**
 * Periodic match reconciliation (r5 Task 4.6 S4b): sweep, then drain the S4a recompute worker.
 *
 * FLAG: `JOB_MATCH_RECONCILIATION_ENABLED`, default OFF (see `config/env.ts`). The collection crons
 * have no flag; this one differs because it activates writes nothing reads yet.
 * STALENESS (SR-M-2): a stale match survives at most `RECONCILE_PERIOD_HOURS` plus sweep and drain.
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
      const report = await reconcileOnce(this.db.db, { cursor: this.cursor })
      this.cursor = report.cursor
      const drained = await this.drain()
      // Counts only, no personal data.
      this.logger.log(
        `Match reconciliation: scanned=${report.scanned} stale=${report.stale} ` +
          `enqueued=${report.enqueued} failed=${report.failed} pages=${report.pages} ` +
          `resumeCursor=${report.cursor === null ? 'none' : 'set'} recomputed=${drained} ` +
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

  /** Run the recompute worker until a batch comes back short, at most the drain limit. */
  private async drain(): Promise<number> {
    let claimed = 0
    for (let i = 0; i < RECONCILE_MAX_DRAIN_BATCHES; i += 1) {
      const r = await this.worker.runOnce()
      claimed += r.claimed
      if (r.claimed === 0) break
    }
    return claimed
  }
}
