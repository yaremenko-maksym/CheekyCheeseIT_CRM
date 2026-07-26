/**
 * VacanciesModule — task-vacancies-api (+ task-google-indexing-api).
 *
 * Reuses (does not duplicate):
 *   - `S3Service` + `CompressionService` from DocumentsModule (upload/delete/
 *     presign + PDF compression pipeline).
 *   - `NotificationsService` from NotificationsModule (ADMIN/HR alerts).
 *
 * `ScheduleModule.forRoot()` is imported here for `VacanciesRetentionCronService`'s
 * `@Cron` — same pattern as FinanceModule (SalaryCronService); NestJS's
 * schedule module is safe to `forRoot()` from multiple feature modules.
 *
 * `GoogleIndexingService` (task-google-indexing-api) is provided here and
 * consumed by both `VacanciesService` (publish/close/slug-change hooks) and
 * `VacanciesRetentionCronService` (weekly PUBLISHED refresh) — module-scoped
 * so both get the SAME instance (and its single boot warning fires once).
 *
 * `TurnstileService` is exported (task-landing-contact-and-hiring-strip) so
 * `ContactModule` can reuse the SAME Cloudflare Turnstile verification
 * service for the public contact-form endpoint instead of a second
 * copy-pasted implementation — it has zero vacancy-specific logic, this
 * module is just where it was first introduced (task-vacancies-api).
 */
import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { DocumentsModule } from '../documents/documents.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { ApplicationsService } from './applications.service'
import { GoogleIndexingService } from './google-indexing.service'
import { PublicVacanciesController } from './public-vacancies.controller'
import { TurnstileService } from './turnstile.service'
import { VacanciesController } from './vacancies.controller'
import { VacanciesRetentionCronService } from './vacancies-retention.cron'
import { VacanciesService } from './vacancies.service'

@Module({
  imports: [ScheduleModule.forRoot(), DocumentsModule, NotificationsModule],
  controllers: [VacanciesController, PublicVacanciesController],
  providers: [
    VacanciesService,
    ApplicationsService,
    TurnstileService,
    GoogleIndexingService,
    VacanciesRetentionCronService,
  ],
  exports: [VacanciesService, ApplicationsService, TurnstileService],
})
export class VacanciesModule {}
