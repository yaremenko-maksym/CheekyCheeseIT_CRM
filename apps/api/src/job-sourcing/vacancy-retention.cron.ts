import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { DatabaseService } from '../database/database.service'
import { dbErrorLogSuffix, safeErrorStack } from '../database/pg-errors'
import { vacancyRetentionEnabled } from './retention'
import {
  type SweepResult,
  VACANCY_RETENTION_FAILURE_MARKER,
  purgeRetiredOpportunities,
} from './store/opportunity-purge'

/**
 * 04:43 daily (CR-M-6). 43 is prime, so no `*\/N` schedule (the 5- and 10-minute crons, the
 * `5-59/10` relevance pass) lands on it, and no fixed-minute job uses it (04:15 action log, 04:25
 * generations, 04:30 media reconciliation, :17 and :37 hourly).
 */
export const VACANCY_RETENTION_CRON = '43 4 * * *'

export { VACANCY_RETENTION_FAILURE_MARKER }

/**
 * The daily vacancy sweep (owner 2026-11-25): removes every sourced opportunity past
 * `VACANCY_RETENTION_DAYS` by publication date, and any CLOSED/EXPIRED one a closer left behind
 * (closures purge inline; this is the safety net). Bounded per tick by the sweep's own batch
 * limits. Never rethrows: a failure is logged with a grep-able marker and retried next night.
 * Off while `VACANCY_RETENTION_ENABLED` is false (SR-M-3).
 */
@Injectable()
export class VacancyRetentionCronService {
  private readonly logger = new Logger(VacancyRetentionCronService.name)

  constructor(private readonly db: DatabaseService) {}

  @Cron(VACANCY_RETENTION_CRON)
  async handleRetention(): Promise<void> {
    if (!vacancyRetentionEnabled()) {
      this.logger.log('Vacancy retention: VACANCY_RETENTION_ENABLED is false; nothing removed')
      return
    }
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
