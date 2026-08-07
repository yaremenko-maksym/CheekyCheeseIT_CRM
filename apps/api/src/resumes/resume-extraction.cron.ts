/**
 * ResumeExtractionCronService — keeps the extraction state machine honest
 * (task-resume-base §2 / AC3).
 *
 * Without this job a container restart mid-extraction would leave a row in
 * RUNNING forever: the detached worker that owned it is gone, nothing will ever
 * write a terminal state, and the UI would spin indefinitely. Every 5 minutes
 * this sweeps:
 *   - RUNNING older than STUCK_EXTRACTION_TIMEOUT_MS -> FAILED/STALLED,
 *   - QUEUED that nobody picked up -> re-driven from the stored source file
 *     (or failed, when there is no file to re-read).
 *
 * Uses `@nestjs/schedule` like SalaryCronService / VacanciesRetentionCron — no
 * new queue infrastructure, per the task's explicit instruction. The whole
 * handler is wrapped in try/catch for the same reason those are: an unhandled
 * rejection inside a scheduled task kills the scheduler silently.
 */
import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { SeniorResumesService } from './resumes.service'

@Injectable()
export class ResumeExtractionCronService {
  private readonly logger = new Logger(ResumeExtractionCronService.name)

  constructor(private readonly resumes: SeniorResumesService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleStuckExtractions(): Promise<void> {
    try {
      const swept = await this.resumes.sweepStuckExtractions()
      if (swept > 0) this.logger.warn(`Swept ${swept} stuck RUNNING resume extraction(s)`)

      const requeued = await this.resumes.requeueAbandoned()
      if (requeued > 0) this.logger.warn(`Re-drove ${requeued} abandoned QUEUED resume(s)`)
    } catch (err: unknown) {
      this.logger.error(
        `Resume extraction sweep failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      )
    }
  }
}
