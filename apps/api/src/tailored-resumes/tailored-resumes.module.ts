import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { DocumentsModule } from '../documents/documents.module'
import { SeniorResumesModule } from '../resumes/resumes.module'
import { TailorWriterClient } from './tailor-writer.client'
import { TailoredDecisionClient } from './tailored-decision.client'
import { TailoredRunner } from './tailored-runner'
import { TailoredSweepCron } from './tailored-sweep.cron'

/**
 * Tailored resumes per job opportunity (tailored-resume spec). Inert until the API starts runs:
 * only the sweep is scheduled.
 */
@Module({
  imports: [ScheduleModule.forRoot(), DocumentsModule, SeniorResumesModule],
  providers: [TailoredSweepCron, TailoredRunner, TailorWriterClient, TailoredDecisionClient],
})
export class TailoredResumesModule {}
