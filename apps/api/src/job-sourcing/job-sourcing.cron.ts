import { type JobSourceType, jobSourceTypeSchema } from '@crm/shared'
import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Cron } from '@nestjs/schedule'
import { DEFAULT_JOB_COLLECTION_WINDOW_MS, type Env } from '../config/env'
import { dbErrorLogSuffix, safeErrorStack } from '../database/pg-errors'
import { JobSourceHealthService } from './health/job-source-health.service'
import { JobSourcingService } from './job-sourcing.service'
import { JobRunLedger } from './ownership/job-run-ledger'
import { runCollectionWindow } from './runtime/collection-window'
import { JobRunWorker } from './runtime/job-run-worker'

/** Both daily handlers run on the company's clock, not the server's (ADR T5, F7). */
export const CRON_TIME_ZONE = 'Europe/Kyiv'
/** 05:00: the legacy DOU collection and retention only (source fetch strategy U3). */
export const API_COLLECTION_CRON = '0 5 * * *'
export const HTML_COLLECTION_CRON = '30 2 * * *'
/** Source fetch strategy ADR section 5: the 10-minute tick and the 08:00 sweep (owner, Q3). */
export const TICK_CRON = '*/10 * * * *'
export const SWEEP_CRON = '0 8 * * *'
/** A tick's window: under its 10-minute period, so two ticks of one replica never overlap. */
export const TICK_WINDOW_MS = 9 * 60_000

const KYIV_SLOT = new Intl.DateTimeFormat('en-CA', {
  timeZone: CRON_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/**
 * `tick:<Kyiv date>T<HH:MM>`, the minute floored to the tick's 10: two replicas firing one tick
 * share the key, and so the cycle (ADR section 5). The fall-back hour repeats its local slots: the
 * second tick of a slot finds its cycle closed and claims nothing.
 */
export function tickTriggerKey(at: Date): string {
  const p = Object.fromEntries(KYIV_SLOT.formatToParts(at).map((x) => [x.type, x.value]))
  const minute = String(Math.floor(Number(p['minute']) / 10) * 10).padStart(2, '0')
  return `tick:${p['year']}-${p['month']}-${p['day']}T${p['hour']}:${minute}`
}

/**
 * The type sets: HTML types at 02:30, every other reporting type to the tick and the sweep.
 * DOU is the legacy path (`collectAll`), never claimed through the ledger.
 */
export const HTML_COLLECTION_TYPES: readonly JobSourceType[] = jobSourceTypeSchema.options.filter(
  (t) => t.endsWith('_HTML'),
)
export const API_COLLECTION_TYPES: readonly JobSourceType[] = jobSourceTypeSchema.options.filter(
  (t) => !t.endsWith('_HTML') && t !== 'DOU_RSS',
)

/** The longest wait between two claims inside a window. */
export const DEFAULT_WINDOW_INTERVAL_MS = 30_000

/**
 * Scheduled collection — task-job-sourcing-slice1 §2 ("Периодичность — по
 * существующему механизму заданий, не изобретать свой"), r5 Task 2.5 T5.
 *
 * Uses the SAME `@nestjs/schedule` `@Cron` mechanism as SalaryCronService /
 * VacanciesRetentionCronService / TelemetryRetentionCronService, including
 * their hard-won error-handling shape: every step is wrapped in try/catch and
 * NEVER rethrows, because an unhandled rejection inside a `@Cron` handler
 * silently kills the scheduler for every OTHER cron in the process.
 *
 * Four schedules, all in `Europe/Kyiv` (source fetch strategy ADR section 5, unit U3):
 *  - 05:00: the legacy DOU collection and retention ONLY. The API types left it for the tick and
 *    the sweep; it opens no cycle and claims nothing.
 *  - 02:30: the HTML types (all blocked until phase 5), unchanged since T5.
 *  - every 10 minutes, the tick: the API types whose slot has come, in a cycle keyed by the
 *    10-minute Kyiv slot, for at most `TICK_WINDOW_MS` (9 minutes).
 *  - 08:00, the sweep: every enabled scheduled API-type source once in a cycle keyed by the Kyiv
 *    date, whatever its slot (the sweep predicate), within `JOB_COLLECTION_WINDOW_MS`. A source with
 *    a null profile or with fixed slots is not swept (`isSweepable`); the tick runs fixed slots.
 *  - each ledger handler: `openCycle` -> `recoverExpired` -> `sweepOrphanReservations` -> the
 *    bounded collection window (`runCollectionWindow`), which closes the cycle.
 *  !! The retention crons are UTC; collection now runs every 10 minutes, so the overlap with them
 *  is permanent (ADR "Consequences"); the worker's pool size bounds concurrent runs.
 *
 * The ledger and the worker are optional constructor arguments: without them (a unit context) the
 * ledger handlers do nothing, and 05:00 still does the legacy DOU work.
 */
@Injectable()
export class JobSourcingCronService {
  private readonly logger = new Logger(JobSourcingCronService.name)

  /** Exposed for specs; production keeps the default. */
  readonly tuning: {
    intervalMs: number
    onlyIds?: readonly string[]
    tickWindowMs: number
  } = {
    intervalMs: DEFAULT_WINDOW_INTERVAL_MS,
    tickWindowMs: TICK_WINDOW_MS,
  }

  constructor(
    @Inject(JobSourcingService) private readonly service: JobSourcingService,
    // Explicit tokens: the test transformer emits no `design:paramtypes`, and an `@Optional()` that
    // resolves to nothing would not fail at boot, it would quietly collect DOU only.
    @Optional() @Inject(JobRunLedger) private readonly ledger?: JobRunLedger,
    @Optional() @Inject(JobRunWorker) private readonly worker?: JobRunWorker,
    @Optional() @Inject(ConfigService) private readonly config?: ConfigService<Env, true>,
    // U4: the detector pass at the end of each tick window. Optional, like the ledger and worker:
    // a unit context without it simply runs no pass.
    @Optional() @Inject(JobSourceHealthService) private readonly health?: JobSourceHealthService,
  ) {}

  /** U3: the legacy DOU collection and retention only; the API types moved to the tick and the sweep. */
  @Cron(API_COLLECTION_CRON, { timeZone: CRON_TIME_ZONE })
  async handleDailyCollection(): Promise<void> {
    await this.collectLegacyDou()
  }

  @Cron(HTML_COLLECTION_CRON, { timeZone: CRON_TIME_ZONE })
  async handleHtmlCollection(): Promise<void> {
    await this.runHandler('daily-html', HTML_COLLECTION_TYPES, {
      triggerKey: () => this.triggerKey('daily-html'),
      windowMs: () => this.windowMs(),
    })
  }

  /** U3: claims the API-type sources whose slot has come, for at most `TICK_WINDOW_MS`. */
  @Cron(TICK_CRON, { timeZone: CRON_TIME_ZONE })
  async handleTick(): Promise<void> {
    await this.runHandler('tick', API_COLLECTION_TYPES, {
      triggerKey: () => tickTriggerKey(new Date()),
      windowMs: () => this.tuning.tickWindowMs,
    })
    // U4: the detector pass runs at the END of the tick window, once the runs of this tick are
    // finished. A failure is logged, never rethrown (see the class doc), so a pass error cannot
    // kill the scheduler or the next tick.
    if (this.health !== undefined) {
      // Stryker disable next-line StringLiteral: the step label is a diagnostic string surfaced only
      // in an error log; no behaviour depends on its value.
      await this.step('tick: health detector pass', () => this.health!.runDetectorPass())
    }
  }

  /**
   * U3: every enabled scheduled API-type source once in this cycle, whatever its slot (the sweep
   * predicate), within `JOB_COLLECTION_WINDOW_MS`. Fixed-slot sources are left to the tick (AC 7).
   */
  @Cron(SWEEP_CRON, { timeZone: CRON_TIME_ZONE })
  async handleSweep(): Promise<void> {
    await this.runHandler('sweep', API_COLLECTION_TYPES, {
      triggerKey: () => this.triggerKey('sweep'),
      windowMs: () => this.windowMs(),
      sweep: true,
    })
  }

  private windowMs(): number {
    const value = this.config?.get('JOB_COLLECTION_WINDOW_MS', { infer: true })
    return typeof value === 'number' && value > 0 && value < Number.POSITIVE_INFINITY
      ? value
      : DEFAULT_JOB_COLLECTION_WINDOW_MS
  }

  /** `<name>:<Kyiv calendar date>`: two replicas of one schedule share the key (SR-L-19). */
  private triggerKey(name: string): string {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: CRON_TIME_ZONE }).format(new Date())
    return `${name}:${day}`
  }

  private async runHandler(
    name: string,
    types: readonly JobSourceType[],
    // Thunks: computed inside the steps, so a throw is logged, never a rejected @Cron handler.
    run: { triggerKey: () => string; windowMs: () => number; sweep?: true },
  ): Promise<void> {
    const startedAt = performance.now()
    const ledger = this.ledger
    const worker = this.worker
    if (ledger === undefined) return
    const opened = await this.step(`${name}: openCycle`, () =>
      ledger.openCycle({ trigger: 'SCHEDULED', triggerKey: run.triggerKey() }),
    )
    await this.step(`${name}: recoverExpired`, () => ledger.recoverExpired())
    await this.step(`${name}: sweepOrphanReservations`, () => ledger.sweepOrphanReservations())
    if (opened === undefined || worker === undefined) return
    await this.step(`${name}: collection window`, () =>
      runCollectionWindow(
        { ledger, worker, logger: this.logger },
        {
          cycleId: opened.cycleId,
          types,
          windowMs: run.windowMs(),
          intervalMs: this.tuning.intervalMs,
          onlyIds: this.tuning.onlyIds,
          startedAt,
          ...(run.sweep === true ? { sweep: true } : {}),
        },
      ),
    )
  }

  /** One step; a failure is logged (class name only) and the next step still runs. */
  private async step<T>(label: string, work: () => Promise<T>): Promise<T | undefined> {
    try {
      return await work()
    } catch (err: unknown) {
      this.logger.error(
        `Job sourcing cron step failed [${label}]${dbErrorLogSuffix(err)}`,
        safeErrorStack(err),
      )
      return undefined
    }
  }

  /** The legacy DOU collection, exactly as it was before T5. */
  private async collectLegacyDou(): Promise<void> {
    try {
      const { results, failures } = await this.service.collectAll()
      for (const result of results) {
        this.logger.log(
          `Job sourcing [${result.sourceType}]: fetched=${result.fetched}, new=${result.created}, ` +
            `duplicates=${result.duplicates}, suggestions=${result.suggestionsCreated}`,
        )
      }
      for (const failure of failures) {
        this.logger.error(`Job sourcing [${failure.sourceType}] FAILED: ${failure.message}`)
      }
      if (results.length === 0 && failures.length === 0) {
        this.logger.warn('Job sourcing: no enabled sources configured — nothing collected')
      }

      const purged = await this.service.purgeStalePostings()
      if (purged > 0) this.logger.log(`Job sourcing retention: purged ${purged} stale posting(s)`)
    } catch (err: unknown) {
      this.logger.error(
        `Job sourcing cron failed — will retry next cycle${dbErrorLogSuffix(err)}`,
        safeErrorStack(err),
      )
      // Do NOT rethrow — see the class doc comment.
    }
  }
}
