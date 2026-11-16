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
/** The dirty-work drain: every 2 minutes (even minutes, so never on the sweep's :17). UTC. */
export const MATCH_DRAIN_CRON = '*/2 * * * *'
/**
 * A drain tick starts no new batch after this long; the batch in flight finishes. Bounded by time,
 * not by a batch count, so a backlog of thousands clears within a few ticks.
 */
export const MATCH_DRAIN_BUDGET_MS = 60_000

/**
 * Match reconciliation (r5 Task 4.6 S4b) in two crons, one service:
 *
 *   DRAIN (`MATCH_DRAIN_CRON`, every 2 min): run the S4a recompute worker until a batch comes back
 *     short or `MATCH_DRAIN_BUDGET_MS` has passed. This is what turns collected records into
 *     opportunities and matches within minutes of a collection run.
 *   SWEEP (`MATCH_RECONCILIATION_CRON`, every RECONCILE_PERIOD_HOURS): the safety net. Recover expired
 *     leases (`recoverExpiredDirty`, SR-M-1: a crashed worker's rows are retried, not stuck), scan for
 *     stale opportunities (`reconcileOnce`), then drain at most RECONCILE_MAX_DRAIN_BATCHES batches.
 *
 * FLAG: `JOB_MATCH_RECONCILIATION_ENABLED`, default OFF (see `config/env.ts`), gates both crons.
 * STALENESS (SR-M-2, CR-M-1, SPEC-L-1): a sweep scans at most 100,000 opportunities per tick (the
 * cursor carries the rest), so a stale opportunity is found within P x ceil(N / 100,000) with
 * P = RECONCILE_PERIOD_HOURS (6 h); once enqueued, the drain recomputes it within minutes, at the
 * worker's throughput. An opportunity that fails every recompute never converges by design: after
 * RECONCILE_MAX_FAILED_PERIODS failed rows the sweep gives up and logs one warn line. Full
 * derivation: `runtime/reconciliation.ts`.
 * NO OVERLAP: one worker, never two drainers. A drain tick is skipped while a sweep or another drain
 * runs; a sweep tick WAITS for an in-flight drain (bounded by the budget plus one batch) instead of
 * being skipped, so the 6-hourly safety net is never lost to the drain. A sweep tick during a sweep
 * is skipped. The cursor lives in memory: a restart rescans from the start, which is cheap because
 * enqueueing is idempotent and a sweep is bounded pages.
 * Never rethrows (C-23): an unhandled rejection in a `@Cron` handler kills the scheduler.
 */
@Injectable()
export class JobMatchReconciliationCronService {
  private readonly logger = new Logger(JobMatchReconciliationCronService.name)
  private running = false
  private cursor: string | null = null
  /** The in-flight drain tick; it never rejects. */
  private drainTick: Promise<void> | null = null

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(RecomputeWorker) private readonly worker: RecomputeWorker,
    @Optional() @Inject(ConfigService) private readonly config?: ConfigService<Env, true>,
  ) {}

  private enabled(): boolean {
    return this.config?.get('JOB_MATCH_RECONCILIATION_ENABLED', { infer: true }) === true
  }

  @Cron(MATCH_DRAIN_CRON)
  async handleDrain(): Promise<void> {
    if (!this.enabled() || this.running || this.drainTick !== null) return
    const tick = this.runDrainTick()
    this.drainTick = tick
    try {
      await tick
    } finally {
      this.drainTick = null
    }
  }

  private async runDrainTick(): Promise<void> {
    const startedAt = performance.now()
    try {
      const { claimed, batches } = await this.drain({ budgetMs: MATCH_DRAIN_BUDGET_MS })
      // Counts only, no personal data; an idle tick (nothing claimed) stays silent.
      if (claimed > 0)
        this.logger.log(
          `Match drain: recomputed=${claimed} batches=${batches} ` +
            `durationMs=${Math.round(performance.now() - startedAt)}`,
        )
    } catch (err: unknown) {
      this.logger.error(
        `Match drain failed; will retry next tick${dbErrorLogSuffix(err)}`,
        safeErrorStack(err),
      )
    }
  }

  @Cron(MATCH_RECONCILIATION_CRON)
  async handleReconciliation(): Promise<void> {
    if (!this.enabled()) return
    if (this.running) {
      this.logger.warn('Match reconciliation: previous sweep still running, tick skipped')
      return
    }
    this.running = true
    const startedAt = performance.now()
    try {
      // Wait for (never skip over) an in-flight drain: one drainer at a time. It never rejects.
      await this.drainTick
      const recovered = await recoverExpiredDirty(this.db.db, {
        batchSize: RECONCILE_RECOVER_BATCH,
      })
      const report = await reconcileOnce(this.db.db, { cursor: this.cursor })
      this.cursor = report.cursor
      const { claimed: drained } = await this.drain({ maxBatches: RECONCILE_MAX_DRAIN_BATCHES })
      // Counts only, no personal data.
      if (report.gaveUp > 0)
        this.logger.warn(
          `Match reconciliation: gave up on ${report.gaveUp} opportunity(ies) after repeated failed ` +
            `recomputes (ids: ${report.gaveUpIds.join(',')})`,
        )
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

  /**
   * Run the recompute worker until a batch comes back short (fewer than a full batch), or the batch
   * cap is reached, or the time budget has passed (checked before each new batch; the first always runs).
   */
  private async drain(limit: {
    maxBatches?: number
    budgetMs?: number
  }): Promise<{ claimed: number; batches: number }> {
    const { maxBatches = Number.POSITIVE_INFINITY, budgetMs = Number.POSITIVE_INFINITY } = limit
    const startedAt = performance.now()
    let claimed = 0
    let batches = 0
    do {
      const r = await this.worker.runOnce()
      batches += 1
      claimed += r.claimed
      if (r.claimed < DIRTY_BATCH_DEFAULT) break
    } while (batches < maxBatches && performance.now() - startedAt < budgetMs)
    return { claimed, batches }
  }
}
