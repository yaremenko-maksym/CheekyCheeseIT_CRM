import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { DatabaseService } from '../database/database.service'
import { dbErrorLogSuffix, safeErrorStack } from '../database/pg-errors'
import { type SweepResult, purgeRetiredOpportunities } from './store/opportunity-purge'

/** 04:40 daily: a free minute after the action-log (04:15), generation (04:25) and 04:30 jobs. */
export const VACANCY_RETENTION_CRON = '40 4 * * *'

export const VACANCY_RETENTION_FAILURE_MARKER = 'vacancy_retention_purge_failed'

/**
 * The daily vacancy sweep (owner 2026-11-25): removes every sourced opportunity past
 * `VACANCY_RETENTION_DAYS` by publication date, and any CLOSED/EXPIRED one a closer left behind
 * (closures purge inline; this is the safety net). Bounded per tick by the sweep's own batch
 * limits. Never rethrows: a failure is logged with a grep-able marker and retried next night.
 */
@Injectable()
export class VacancyRetentionCronService {
  private readonly logger = new Logger(VacancyRetentionCronService.name)

  constructor(private readonly db: DatabaseService) {}

  @Cron(VACANCY_RETENTION_CRON)
  async handleRetention(): Promise<void> {
    try {
      const r = await this.purge()
      // Logged including zero, so a silent success is not mistaken for a job that never ran.
      this.logger.log(
        `Vacancy retention: deleted ${r.deleted}, tombstoned ${r.tombstoned}, skipped ${r.skipped}, ` +
          `failed ${r.failed} opportunity(ies); ${r.records} unlinked record(s), ${r.blobs} text blob(s)`,
      )
    } catch (error: unknown) {
      this.logger.error(
        `${VACANCY_RETENTION_FAILURE_MARKER} Vacancy retention cron failed; will retry next cycle${dbErrorLogSuffix(error)}`,
        safeErrorStack(error),
      )
    }
  }

  purge(): Promise<SweepResult> {
    return purgeRetiredOpportunities(this.db.db, {
      // One row's failure: the sweep goes on; the row is retried next night.
      onError: (kind, id, error) =>
        this.logger.error(
          `${VACANCY_RETENTION_FAILURE_MARKER} Vacancy retention skipped ${kind} ${id}; will retry next cycle${dbErrorLogSuffix(error)}`,
          safeErrorStack(error),
        ),
    })
  }
}
