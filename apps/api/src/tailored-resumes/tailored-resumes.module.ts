import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { DocumentsModule } from '../documents/documents.module'
import { TailoredSweepCron } from './tailored-sweep.cron'

/** Tailored resumes per job opportunity (tailored-resume spec). Inert: only the sweep runs. */
@Module({
  imports: [ScheduleModule.forRoot(), DocumentsModule],
  providers: [TailoredSweepCron],
})
export class TailoredResumesModule {}
