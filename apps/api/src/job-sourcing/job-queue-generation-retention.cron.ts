import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Cron } from '@nestjs/schedule'
import type { Env } from '../config/env'
import { DatabaseService } from '../database/database.service'
import { dbErrorLogSuffix, safeErrorStack } from '../database/pg-errors'
import { purgeExpiredGenerations } from './queue/queue-generation'

/** Daily, on a minute of the retention band no other cron holds. */
export const GENERATION_RETENTION_CRON = '25 4 * * *'

/**
 * Removes expired queue generations (r5 MP-13 generation retention, Task 6.2).
 *
 * FLAG: `JOB_QUEUE_GENERATION_PURGE_ENABLED`, default OFF: r5 Task 1.4 keeps new-store cleanup disabled
 * until the owner freezes the durations, and the 15-minute TTL this purge follows is one of them. When
 * off the tick is a no-op. Never rethrows: an unhandled rejection in a `@Cron` handler kills the
 * scheduler for every other cron in the process.
 */
@Injectable()
export class JobQueueGenerationRetentionCronService {
  private readonly logger = new Logger(JobQueueGenerationRetentionCronService.name)

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Optional() @Inject(ConfigService) private readonly config?: ConfigService<Env, true>,
  ) {}

  @Cron(GENERATION_RETENTION_CRON)
  async handleRetention(): Promise<void> {
    if (this.config?.get('JOB_QUEUE_GENERATION_PURGE_ENABLED', { infer: true }) !== true) return
    try {
      const purged = await purgeExpiredGenerations(this.db.db, new Date())
      // Logged including zero: a silent success looks like a job that never ran.
      this.logger.log(`Job queue generation retention: purged ${purged} generation(s)`)
    } catch (err: unknown) {
      this.logger.error(
        `Job queue generation retention failed; will retry next tick${dbErrorLogSuffix(err)}`,
        safeErrorStack(err),
      )
    }
  }
}
