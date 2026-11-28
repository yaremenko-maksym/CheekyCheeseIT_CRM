import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { DocumentsModule } from '../documents/documents.module'
import { JobSourcingModule } from '../job-sourcing/job-sourcing.module'
import { SeniorResumesModule } from '../resumes/resumes.module'
import { UsersModule } from '../users/users.module'
import { TailorWriterClient } from './tailor-writer.client'
import { TailoredDecisionClient } from './tailored-decision.client'
import { TailoredResumesController } from './tailored-resumes.controller'
import { TailoredResumesService } from './tailored-resumes.service'
import { TailoredRunner } from './tailored-runner'
import { TailoredSweepCron } from './tailored-sweep.cron'

/**
 * Tailored resumes per job opportunity (tailored-resume spec). Inert while
 * `TAILORED_RESUME_ENABLED` is false: every route answers 404 and only the sweep is scheduled.
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    DocumentsModule,
    SeniorResumesModule,
    JobSourcingModule,
    UsersModule,
  ],
  controllers: [TailoredResumesController],
  providers: [
    TailoredResumesService,
    TailoredSweepCron,
    TailoredRunner,
    TailorWriterClient,
    TailoredDecisionClient,
  ],
})
export class TailoredResumesModule {}
