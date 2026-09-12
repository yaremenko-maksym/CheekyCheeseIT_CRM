/**
 * NotificationsModule — in-app notifications API.
 *
 * Exports `NotificationsService` so every emitter can inject it directly
 * without re-importing DatabaseModule. С позиции 6 таких эмиттеров пять:
 * finance/transactions, teams, projects, users, approvals и contracts.
 *
 * AuthModule ЗДЕСЬ НЕ ИМПОРТИРУЕТСЯ — и это правка позиции 6, а не упущение.
 * Он стоял тут «ради JwtAuthGuard», но guard глобальный (`APP_GUARD` в
 * `AppModule`), а контроллер не объявляет ни одного `@UseGuards`: из
 * AuthModule ему нужен только декоратор `@CurrentUser`, а декоратор — не
 * провайдер и импорта модуля не требует. Ровно так же устроен, например,
 * `LegendsModule` — тоже JWT-защищённый контроллер без импорта AuthModule.
 *
 * Пока модуль был листом графа, лишний импорт ничего не стоил. Как только
 * пять модулей стали импортировать НАС, он замкнул кольцо
 * users → notifications → auth → users, и `app.module.container.spec.ts`
 * поймал это немедленно («The module at index [1] of the UsersModule
 * "imports" array is undefined»). Снять ненужное ребро честнее, чем
 * обвешивать пять импортов `forwardRef`, скрывая цикл вместо его удаления.
 */
import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { MailerModule } from '../contact/mailer.module'
import { DatabaseModule } from '../database/database.module'
import { TelemetryModule } from '../telemetry/telemetry.module'
import { NotificationPreferencesService } from './notification-preferences.service'
import { NotificationEmailCronService, OUTBOX_GATEWAY } from './notification-email.cron'
import { OutboxRepository } from './notification-email.repository'
import { NotificationsController } from './notifications.controller'
import { NotificationsService } from './notifications.service'

@Module({
  // TelemetryModule — канал, в который уходит пропущенное уведомление
  // (SR-H-1): разбор данных больше не бросает, а значит отказ обязан быть
  // виден снаружи процесса, иначе он становится тихой потерей. Кольца это не
  // заводит: TelemetryModule зависит только от `ScheduleModule`, про
  // уведомления он не знает.
  //
  // Позиция 7a добавила два импорта:
  //   - `MailerModule` — тот же `ResendMailerService`, что у формы контакта и
  //     приглашений. Импортировать ради него `ContactModule` нельзя: получилось
  //     бы кольцо notifications → contact → vacancies → notifications (см.
  //     `mailer.module.ts`).
  //   - `ScheduleModule.forRoot()` — для `@Cron` отправщика, тот же приём, что
  //     в `TelemetryModule` и `VacanciesModule`.
  imports: [DatabaseModule, TelemetryModule, MailerModule, ScheduleModule.forRoot()],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationPreferencesService,
    NotificationEmailCronService,
    // Шов отправщика: крон знает `OutboxGateway`, а не drizzle (см.
    // `notification-email.cron.ts`). Токен нужен потому, что интерфейс
    // TypeScript не переживает компиляцию и внедряться по типу не может.
    { provide: OUTBOX_GATEWAY, useClass: OutboxRepository },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
