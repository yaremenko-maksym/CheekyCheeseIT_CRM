import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { JobSourcingService } from './job-sourcing.service'

/**
 * Scheduled collection — task-job-sourcing-slice1 §2 ("Периодичность — по
 * существующему механизму заданий, не изобретать свой").
 *
 * Uses the SAME `@nestjs/schedule` `@Cron` mechanism as SalaryCronService /
 * VacanciesRetentionCronService / TelemetryRetentionCronService, including
 * their hard-won error-handling shape: the handler body is wrapped in
 * try/catch and NEVER rethrows, because an unhandled rejection inside a
 * `@Cron` handler silently kills the scheduler for every OTHER cron in the
 * process.
 *
 * Slot: 05:00 daily — after the 03:00 / 03:30 / 04:00 retention jobs, so an
 * external HTTP fetch never contends with them for DB connections, and still
 * comfortably before the working day (a senior opening the modal in the
 * morning sees the night's postings).
 */
@Injectable()
export class JobSourcingCronService {
  private readonly logger = new Logger(JobSourcingCronService.name)

  constructor(private readonly service: JobSourcingService) {}

  @Cron('0 5 * * *')
  async handleDailyCollection(): Promise<void> {
    try {
      const results = await this.service.collectAll()
      for (const result of results) {
        this.logger.log(
          `Job sourcing [${result.sourceType}]: fetched=${result.fetched}, new=${result.created}, ` +
            `duplicates=${result.duplicates}, suggestions=${result.suggestionsCreated}`,
        )
      }
      if (results.length === 0) {
        this.logger.warn('Job sourcing: no enabled sources configured — nothing collected')
      }

      const purged = await this.service.purgeStalePostings()
      if (purged > 0) this.logger.log(`Job sourcing retention: purged ${purged} stale posting(s)`)
    } catch (err: unknown) {
      this.logger.error(
        'Job sourcing cron failed — will retry next cycle',
        err instanceof Error ? err.stack : String(err),
      )
      // Do NOT rethrow — see the class doc comment.
    }
  }
}
