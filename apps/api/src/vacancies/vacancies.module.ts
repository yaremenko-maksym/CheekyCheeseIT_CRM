/**
 * VacanciesModule — task-vacancies-api.
 *
 * Reuses (does not duplicate):
 *   - `S3Service` + `CompressionService` from DocumentsModule (upload/delete/
 *     presign + PDF compression pipeline).
 *   - `NotificationsService` from NotificationsModule (ADMIN/HR alerts).
 *
 * `ScheduleModule.forRoot()` is imported here for `VacanciesRetentionCronService`'s
 * `@Cron` — same pattern as FinanceModule (SalaryCronService); NestJS's
 * schedule module is safe to `forRoot()` from multiple feature modules.
 */
import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { DocumentsModule } from '../documents/documents.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { ApplicationsService } from './applications.service'
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
    VacanciesRetentionCronService,
  ],
  exports: [VacanciesService, ApplicationsService],
})
export class VacanciesModule {}
