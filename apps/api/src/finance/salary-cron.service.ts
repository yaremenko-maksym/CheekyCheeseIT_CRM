import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { TransactionsService } from './transactions.service'
import { previousSalaryMonthKey } from './salary-month.util'

@Injectable()
export class SalaryCronService {
  private readonly logger = new Logger(SalaryCronService.name)

  constructor(private readonly txService: TransactionsService) {}

  /**
   * Runs at 00:00 on the 1st of every month — creates salaries for the PREVIOUS month.
   *
   * SEC-01 hardening (2026-07-03):
   *   - The entire body is wrapped in try/catch so that any unexpected error
   *     (e.g. DB connection drop, partial failure inside createMonthlySalaries)
   *     is caught, logged with context, and does NOT propagate as an unhandled
   *     rejection. An unhandled rejection in a @Cron handler silently aborts the
   *     job scheduler without any observable signal in prod.
   *   - Per-row resilience (individual employee failures not aborting the whole
   *     cycle) is handled inside createMonthlySalaries via ON CONFLICT DO NOTHING
   *     + the indexed partial-unique constraint. This outer catch is the last-resort
   *     safety net for errors we didn't anticipate.
   */
  @Cron('0 0 1 * *')
  async handleMonthlySalaries(): Promise<void> {
    // task-salary-month-gap-and-status (HIGH-2): shared with
    // TransactionsService.getSalaryMonthGapReport's default — see
    // salary-month.util.ts for why this must be the ONE place this
    // computation lives.
    const month = previousSalaryMonthKey()
    this.logger.log(`Creating monthly salary transactions for ${month}`)
    try {
      await this.txService.createMonthlySalaries(month)
      this.logger.log(`Monthly salary transactions done for ${month}`)
    } catch (err: unknown) {
      this.logger.error(
        `createMonthlySalaries failed for month ${month} — cron will retry next cycle`,
        err instanceof Error ? err.stack : String(err),
      )
      // Do NOT rethrow: an unhandled rejection in a @Cron handler terminates the
      // job silently. The error is already logged above for observability.
    }
  }
}
