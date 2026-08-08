import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { DatabaseModule } from '../database/database.module'
import { DouRssProvider } from './dou.provider'
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
 */
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [JobSourcingController],
  providers: [JobSourcingService, JobSourcingCronService, DouRssProvider],
  exports: [JobSourcingService],
})
export class JobSourcingModule {}
