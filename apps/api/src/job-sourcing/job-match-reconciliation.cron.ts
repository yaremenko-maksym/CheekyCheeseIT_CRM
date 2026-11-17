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
import { invalidateGenerationsForNewJobs } from './queue/queue-generation'
import { RecomputeWorker } from './runtime/recompute-worker'

/** Every RECONCILE_PERIOD_HOURS at :17, a minute no other cron holds. */
export const MATCH_RECONCILIATION_CRON = `17 */${RECONCILE_PERIOD_HOURS} * * *`
/** Expired leases returned to the queue per tick (the store's own ceiling). */
export const RECONCILE_RECOVER_BATCH = 1000
/**
 * A post-run drain pass starts no new batch after this long; the batch in flight finishes. Bounded
 * by time, not by a batch count: it shares the database and the event loop with the collection
 * window, and whatever it leaves is drained by the next pass (a run ended meanwhile), after the next
 * run ends, or by the sweep.
 */
export const MATCH_DRAIN_BUDGET_MS = 60_000

/**
 * Match reconciliation (r5 Task 4.6 S4b): the post-run drain and the 6-hourly safety net, one service.
 *
 *   DRAIN (`requestDrain`, no cron): `JobRunWorker` calls it after every run ends. A pass runs the
 *     S4a recompute worker over FRESH rows only (never attempted, `freshOnly`) until it is idle (an
 *     empty batch, or a short one that completed nothing) or `MATCH_DRAIN_BUDGET_MS` has passed, so
 *     the records a run persisted are opportunities and matches within the same collection window,
 *     and retires the published queue snapshots when anything was recomputed. A run that ended
 *     during a pass (its drain, or its retire) buys one more pass with a fresh budget.
 *     RETRIES are the sweep's (CR-H-1): a failed row is back in PENDING at once with no backoff, so
 *     back-to-back drains would spend its attempts in minutes. The sweep retries it once per tick
 *     when its drain ends on a short batch; a sweep drain of full batches may re-claim it within
 *     the tick (the sweep's behaviour before the post-run drain existed).
 *   SWEEP (`MATCH_RECONCILIATION_CRON`, every RECONCILE_PERIOD_HOURS): the safety net. Recover expired
 *     leases (`recoverExpiredDirty`, SR-M-1: a crashed worker's rows are retried, not stuck), scan for
 *     stale opportunities (`reconcileOnce`), then drain at most RECONCILE_MAX_DRAIN_BATCHES batches
 *     (whatever the post-run drains left, retries included).
 *
 * FLAG: `JOB_MATCH_RECONCILIATION_ENABLED`, default OFF (see `config/env.ts`), gates both.
 * STALENESS (SR-M-2, CR-M-1, SPEC-L-1): a sweep scans at most 100,000 opportunities per tick (the
 * cursor carries the rest), so a stale opportunity is found within P x ceil(N / 100,000) with
 * P = RECONCILE_PERIOD_HOURS (6 h); once enqueued it is recomputed after the next run ends. An
 * opportunity that fails every recompute never converges by design: after
 * RECONCILE_MAX_FAILED_PERIODS failed rows the sweep gives up and logs one warn line. Full
 * derivation: `runtime/reconciliation.ts`.
 * NO OVERLAP: one worker, never two drainers. A drain request while a sweep runs is deferred to the
 * sweep's end (a run may end after the sweep's own drain). A sweep tick WAITS for an in-flight drain
 * instead of being skipped, so the 6-hourly safety net is never lost to a drain. The wait is the
 * current pass plus at most one more (a waiting sweep defers new requests): per pass the budget,
 * one batch, and the retire, whose every lock wait is cut at `STORE_LOCK_TIMEOUT_MS`. A sweep tick
 * during a sweep is skipped. The cursor lives in memory: a restart rescans from the start, which is cheap because enqueueing is
 * idempotent and a sweep is bounded pages.
 * Never rejects (C-23): an unhandled rejection in a `@Cron` handler kills the scheduler, and a
 * drain failure must never reach the run that triggered it.
 */
@Injectable()
export class JobMatchReconciliationCronService {
  private readonly logger = new Logger(JobMatchReconciliationCronService.name)
  private running = false
  private cursor: string | null = null
  /** The in-flight post-run drain; it never rejects. */
  private drainTick: Promise<void> | null = null
  /** A run ended during a pass (its drain or its retire): one more pass, with a fresh budget. */
  // Stryker disable next-line BooleanLiteral: equivalent, runDrainTick resets it to false before its first read
  private drainAgain = false
  /** A run ended while a sweep ran: a drain starts once the sweep ends. */
  private drainAfterSweep = false

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(RecomputeWorker) private readonly worker: RecomputeWorker,
    @Optional() @Inject(ConfigService) private readonly config?: ConfigService<Env, true>,
  ) {}

  private enabled(): boolean {
    return this.config?.get('JOB_MATCH_RECONCILIATION_ENABLED', { infer: true }) === true
  }

  /**
   * The post-run step (`JobRunWorker` calls it after every run ends, scheduled or manual): recompute
   * the MATCH dirty work the run produced (records, then the opportunity rows they enqueue), so its
   * records are opportunities and matches seconds later. Single-flight: a request while a drain runs
   * asks that drain for one more pass (with its own budget) and shares its promise; a request while
   * a sweep runs is deferred: a drain starts when the sweep ends (it may already be past its own
   * drain). The promise never rejects.
   */
  requestDrain(): Promise<void> {
    if (!this.enabled()) return Promise.resolve()
    if (this.running) {
      this.drainAfterSweep = true
      return Promise.resolve()
    }
    if (this.drainTick !== null) {
      this.drainAgain = true
      return this.drainTick
    }
    this.drainTick = this.runDrainTick()
    return this.drainTick
  }

  private async runDrainTick(): Promise<void> {
    try {
      do {
        this.drainAgain = false
        await this.drainPass()
      } while (this.drainAgain)
    } finally {
      // Synchronously after the last read of `drainAgain`: a request from now on starts a new drain.
      this.drainTick = null
    }
  }

  /** One pass: drain under its own budget, then retire the snapshots. Never throws. */
  private async drainPass(): Promise<void> {
    const startedAt = performance.now()
    const elapsed = () => performance.now() - startedAt
    // Filled batch by batch, so a failure still reports (and retires for) what was done before it.
    const tally: DrainTally = { claimed: 0, done: 0, batches: 0 }
    try {
      await this.drain(
        { deadline: startedAt + MATCH_DRAIN_BUDGET_MS, untilIdle: true, freshOnly: true },
        tally,
      )
    } catch (err: unknown) {
      this.logger.error(
        `Match drain failed after recomputed=${tally.claimed} batches=${tally.batches}; the rest stays pending ` +
          `for the next run or the sweep${dbErrorLogSuffix(err)}`,
        safeErrorStack(err),
      )
    }
    // Also for the work of a drain that failed later.
    const invalidated = await this.retireSnapshots(tally.done)
    // Counts only, no personal data; an idle drain (nothing claimed) stays silent.
    if (tally.claimed > 0)
      this.logger.log(
        `Match drain: recomputed=${tally.claimed} done=${tally.done} batches=${tally.batches} ` +
          `generationsInvalidated=${invalidated} durationMs=${Math.round(elapsed())}`,
      )
  }

  /**
   * New or recomputed opportunities (`done` rows DONE): retire every published queue snapshot, so the
   * next read lists them instead of serving a snapshot taken before them until its TTL. Never throws.
   */
  private async retireSnapshots(done: number): Promise<number> {
    if (done === 0) return 0
    try {
      return await invalidateGenerationsForNewJobs(this.db.db)
    } catch (err: unknown) {
      this.logger.error(
        `Match drain: queue snapshots not retired; fresh opportunities show when they expire` +
          dbErrorLogSuffix(err),
        safeErrorStack(err),
      )
      return 0
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
      if (this.drainTick !== null) await this.drainTick
      const recovered = await recoverExpiredDirty(this.db.db, {
        batchSize: RECONCILE_RECOVER_BATCH,
      })
      const report = await reconcileOnce(this.db.db, { cursor: this.cursor })
      this.cursor = report.cursor
      const drained = await this.drain({ maxBatches: RECONCILE_MAX_DRAIN_BATCHES })
      const invalidated = await this.retireSnapshots(drained.done)
      // Counts only, no personal data.
      if (report.gaveUp > 0)
        this.logger.warn(
          `Match reconciliation: gave up on ${report.gaveUp} opportunity(ies) after repeated failed ` +
            `recomputes (ids: ${report.gaveUpIds.join(',')})`,
        )
      this.logger.log(
        `Match reconciliation: scanned=${report.scanned} stale=${report.stale} ` +
          `enqueued=${report.enqueued} skipped=${report.skipped} failed=${report.failed} pages=${report.pages} ` +
          `resumeCursor=${report.cursor === null ? 'none' : 'set'} recomputed=${drained.claimed} ` +
          `generationsInvalidated=${invalidated} ` +
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
      // A run that ended during the sweep, perhaps after its drain: drained now (never rejects).
      if (this.drainAfterSweep) {
        this.drainAfterSweep = false
        void this.requestDrain()
      }
    }
  }

  /**
   * Run the recompute worker until a batch comes back short (fewer than a full batch), or the batch
   * cap is reached, or the deadline (a `performance.now()` value) has passed: checked before each new
   * batch, so the first always runs and the batch in flight finishes.
   * `untilIdle` (the post-run drain): a short batch that completed rows does not stop it, because a
   * resolved SOURCE_RECORD enqueues its OPPORTUNITY row as new PENDING work; only an empty batch, or
   * a short one that completed nothing (stale or failed only), does. `freshOnly` (the post-run
   * drain): a row that failed is not claimed again; it waits for the sweep (CR-H-1).
   */
  private async drain(
    limit: { maxBatches?: number; deadline?: number; untilIdle?: boolean; freshOnly?: boolean },
    tally: DrainTally = { claimed: 0, done: 0, batches: 0 },
  ): Promise<DrainTally> {
    const {
      maxBatches = Number.POSITIVE_INFINITY,
      deadline,
      untilIdle = false,
      freshOnly = false,
    } = limit
    let batches = 0
    do {
      const r = await this.worker.runOnce({ freshOnly })
      batches += 1
      tally.batches += 1
      tally.claimed += r.claimed
      tally.done += r.done
      if (r.claimed < DIRTY_BATCH_DEFAULT && (!untilIdle || r.done === 0)) break
    } while (batches < maxBatches && (deadline === undefined || performance.now() < deadline))
    return tally
  }
}

/** What a drain has processed so far: rows claimed, rows DONE, batches run. */
interface DrainTally {
  claimed: number
  done: number
  batches: number
}
