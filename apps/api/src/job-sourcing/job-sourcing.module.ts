import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { DatabaseModule } from '../database/database.module'
import { JobSourceAdminController } from './admin/job-source-admin.controller'
import { JobSourceAdminService } from './admin/job-source-admin.service'
import { DouRssProvider } from './dou.provider'
import { JobQueueActionRetentionCronService } from './job-queue-action-retention.cron'
import { JobSourcingController } from './job-sourcing.controller'
import { JobSourcingCronService } from './job-sourcing.cron'
import { JobSourcingService } from './job-sourcing.service'
import { JobSourceRegistry } from './registry/job-source-registry'
import { createProductionRegistry } from './registry/production-registry'

/**
 * Job sourcing (task-job-sourcing-slice1).
 *
 * `HrAccessService` is NOT imported here: it is provided by the @Global
 * CommonModule (same as legends / projects / credentials consume it), so this
 * module injects the one shared instance instead of a second copy of the
 * "does this HR share a team with this user" rule.
 *
 * There is ONE adapter registry (`JobSourceRegistry`), built by `createProductionRegistry`; it
 * rejects a duplicate type while this module initialises. Adding a source = provide its class here
 * and add it to that factory. `JobSourcingService` keeps no map of its own.
 *
 * `JobQueueActionRetentionCronService` is a SECOND cron, deliberately separate from
 * `JobSourcingCronService`: it discharges the statutory two-year retention of
 * `job_queue_actions`, and every other retention duty in this process is likewise its
 * own service with its own slot. (It is NOT separate because a failing feed could
 * skip it — `collectAll` catches per source and carries on; see its class doc, which
 * records that correction.) It needs no `ScheduleModule.forRoot()` here for the same
 * reason `JobSourcingCronService` does not — the scheduler is rooted once elsewhere
 * and discovers every `@Cron` in the application.
 */
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [JobSourcingController, JobSourceAdminController],
  providers: [
    JobSourcingService,
    JobSourceAdminService,
    JobSourcingCronService,
    JobQueueActionRetentionCronService,
    DouRssProvider,
    {
      provide: JobSourceRegistry,
      useFactory: createProductionRegistry,
      inject: [DouRssProvider],
    },
  ],
  exports: [JobSourcingService],
})
export class JobSourcingModule {}
