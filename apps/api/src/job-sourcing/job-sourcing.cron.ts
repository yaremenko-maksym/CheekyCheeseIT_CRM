import { type JobSourceType, jobSourceTypeSchema } from '@crm/shared'
import { Injectable, Logger, Optional } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Cron } from '@nestjs/schedule'
import { DEFAULT_JOB_COLLECTION_WINDOW_MS, type Env } from '../config/env'
import { dbErrorLogSuffix, safeErrorStack } from '../database/pg-errors'
import { JobSourcingService } from './job-sourcing.service'
import { JobRunLedger } from './ownership/job-run-ledger'
import { runCollectionWindow } from './runtime/collection-window'
import { JobRunWorker } from './runtime/job-run-worker'

/** Both daily handlers run on the company's clock, not the server's (ADR T5, F7). */
export const CRON_TIME_ZONE = 'Europe/Kyiv'
export const API_COLLECTION_CRON = '0 5 * * *'
export const HTML_COLLECTION_CRON = '30 2 * * *'

/**
 * The type sets of the two schedules: HTML types at 02:30, every other reporting type at 05:00.
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
 * Two schedules, both in `Europe/Kyiv`:
 *  - 02:30 HTML types, 05:00 API types plus the legacy DOU collection. 05:00 stays after the
 *    03:00 / 03:30 / 04:00 retention jobs, so an external fetch never contends with them for DB
 *    connections, and comfortably before the working day.
 *  - each handler: `openCycle` -> `recoverExpired` -> `sweepOrphanReservations` -> (05:00 only)
 *    DOU -> the bounded collection window (`runCollectionWindow`), which closes the cycle.
 *
 * The ledger and the worker are optional constructor arguments: without them (a unit context) the
 * handler does the legacy DOU work only, as before T5.
 */
@Injectable()
export class JobSourcingCronService {
  private readonly logger = new Logger(JobSourcingCronService.name)

  /** Exposed for specs; production keeps the default. */
  readonly tuning: { intervalMs: number; onlyIds?: readonly string[] } = {
    intervalMs: DEFAULT_WINDOW_INTERVAL_MS,
  }

  constructor(
    private readonly service: JobSourcingService,
    @Optional() private readonly ledger?: JobRunLedger,
    @Optional() private readonly worker?: JobRunWorker,
    @Optional() private readonly config?: ConfigService<Env, true>,
  ) {}

  @Cron(API_COLLECTION_CRON, { timeZone: CRON_TIME_ZONE })
  async handleDailyCollection(): Promise<void> {
    await this.runHandler('daily-api', API_COLLECTION_TYPES, true)
  }

  @Cron(HTML_COLLECTION_CRON, { timeZone: CRON_TIME_ZONE })
  async handleHtmlCollection(): Promise<void> {
    await this.runHandler('daily-html', HTML_COLLECTION_TYPES, false)
  }

  private windowMs(): number {
    const value = this.config?.get('JOB_COLLECTION_WINDOW_MS', { infer: true })
    return typeof value === 'number' && Number.isFinite(value) && value > 0
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
    legacyDou: boolean,
  ): Promise<void> {
    const startedAt = performance.now()
    const ledger = this.ledger
    const worker = this.worker
    let cycleId: string | null = null
    if (ledger !== undefined) {
      const opened = await this.step(`${name}: openCycle`, () =>
        ledger.openCycle({ trigger: 'SCHEDULED', triggerKey: this.triggerKey(name) }),
      )
      cycleId = opened?.cycleId ?? null
      await this.step(`${name}: recoverExpired`, () => ledger.recoverExpired())
      await this.step(`${name}: sweepOrphanReservations`, () => ledger.sweepOrphanReservations())
    }
    if (legacyDou) await this.collectLegacyDou()
    if (ledger !== undefined && worker !== undefined && cycleId !== null) {
      const id = cycleId
      await this.step(`${name}: collection window`, () =>
        runCollectionWindow(
          { ledger, worker, logger: this.logger },
          {
            cycleId: id,
            types,
            windowMs: this.windowMs(),
            intervalMs: this.tuning.intervalMs,
            onlyIds: this.tuning.onlyIds,
            startedAt,
          },
        ),
      )
    }
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
