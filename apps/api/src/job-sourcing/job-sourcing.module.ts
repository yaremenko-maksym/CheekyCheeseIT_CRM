import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { DatabaseModule } from '../database/database.module'
import { DouRssProvider } from './dou.provider'
import { JobQueueActionRetentionCronService } from './job-queue-action-retention.cron'
import { JobSourcingController } from './job-sourcing.controller'
import { JobSourcingCronService } from './job-sourcing.cron'
import { JobSourcingService } from './job-sourcing.service'

/**
 * Job sourcing (task-job-sourcing-slice1).
 *
 * `HrAccessService` is NOT imported here: it is provided by the @Global
 * CommonModule (same as legends / projects / credentials consume it), so this
 * module injects the one shared instance instead of a second copy of the
 * "does this HR share a team with this user" rule.
 *
 * Adding a source in slice 2 = provide the new provider class here and register
 * it in `JobSourcingService`'s registry map. No other file changes.
 *
 * `JobQueueActionRetentionCronService` is a SECOND cron, deliberately separate from
 * `JobSourcingCronService`: it discharges the statutory two-year retention of
 * `job_queue_actions` and must not be skippable by an external feed being down. See
 * its class doc comment. It needs no `ScheduleModule.forRoot()` here for the same
 * reason `JobSourcingCronService` does not — the scheduler is rooted once elsewhere
 * and discovers every `@Cron` in the application.
 */
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [JobSourcingController],
  providers: [
    JobSourcingService,
    JobSourcingCronService,
    JobQueueActionRetentionCronService,
    DouRssProvider,
  ],
  exports: [JobSourcingService],
})
export class JobSourcingModule {}
