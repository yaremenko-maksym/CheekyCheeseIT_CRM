/**
 * SeniorResumesModule — task-resume-base.
 *
 * Reuses (does not duplicate):
 *   - `S3Service` from DocumentsModule — private storage of the original file,
 *     with the RESUME category's existing short-TTL / no-store policy.
 *   - `PdfModule` — the Roboto assets and the font loader. The Typst renderer
 *     points the child process at the SAME `assets/fonts` directory, so the
 *     resume and every invoice/contract share one set of embedded faces (and
 *     one answer to "which glyphs exist" — see resume-glyphs.ts).
 *   - `ScheduleModule.forRoot()` for the stuck-extraction sweep and the daily
 *     `senior-resumes/` orphan sweep, exactly like
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
import { ResumeAiDailyBudget } from './resume-ai-daily-budget'
import { ResumeAiService } from './resume-ai.service'
import { ResumeExtractionCronService } from './resume-extraction.cron'
import { ResumeOrphanSweepCron } from './resume-orphan-sweep.cron'
import { ResumeTypstService } from './resume-typst.service'
import { ResumeTextExtractionService } from './resume-text-extraction.service'
import { SeniorResumesController } from './resumes.controller'
import { SeniorResumesService } from './resumes.service'
import { ResumeVerificationService } from './verification/resume-verification.service'
import { VerificationRunner } from './verification/verification-runner'
import {
  ResumeEntailmentClient,
  ResumeWriterClient,
  VisualCheckClient,
} from './verification/inference-clients'

@Module({
  imports: [ScheduleModule.forRoot(), DocumentsModule, PdfModule],
  controllers: [SeniorResumesController],
  providers: [
    SeniorResumesService,
    ResumeVerificationService,
    VerificationRunner,
    ResumeAiService,
    ResumeAiDailyBudget,
    ResumeTextExtractionService,
    ResumeTypstService,
    ResumeExtractionCronService,
    ResumeOrphanSweepCron,
    ResumeWriterClient,
    VisualCheckClient,
    ResumeEntailmentClient,
  ],
  exports: [SeniorResumesService],
})
export class SeniorResumesModule {}
