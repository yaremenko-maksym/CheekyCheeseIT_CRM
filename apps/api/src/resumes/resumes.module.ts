/**
 * SeniorResumesModule — task-resume-base.
 *
 * Reuses (does not duplicate):
 *   - `S3Service` from DocumentsModule — private storage of the original file,
 *     with the RESUME category's existing short-TTL / no-store policy.
 *   - `PdfGenerationService` from PdfModule — embedded Roboto fonts, i.e. the
 *     only reason Cyrillic renders at all (see ResumePdfService).
 *   - `ScheduleModule.forRoot()` for the stuck-extraction sweep, exactly like
 *     FinanceModule (SalaryCron) and VacanciesModule (retention cron).
 *
 * `SeniorResumesService` is exported for the follow-up task
 * (task-resume-tailoring), which builds vacancy-tailored variants on top of
 * this canonical resume and needs to read its content + version.
 */
import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { DocumentsModule } from '../documents/documents.module'
import { PdfModule } from '../common/pdf/pdf.module'
import { ResumeAiService } from './resume-ai.service'
import { ResumeExtractionCronService } from './resume-extraction.cron'
import { ResumePdfService } from './resume-pdf.service'
import { ResumeTextExtractionService } from './resume-text-extraction.service'
import { SeniorResumesController } from './resumes.controller'
import { SeniorResumesService } from './resumes.service'

@Module({
  imports: [ScheduleModule.forRoot(), DocumentsModule, PdfModule],
  controllers: [SeniorResumesController],
  providers: [
    SeniorResumesService,
    ResumeAiService,
    ResumeTextExtractionService,
    ResumePdfService,
    ResumeExtractionCronService,
  ],
  exports: [SeniorResumesService],
})
export class SeniorResumesModule {}
