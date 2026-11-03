/**
 * NotificationsModule — in-app notifications API.
 *
 * Exports `NotificationsService` so every emitter can inject it directly
 * without re-importing DatabaseModule. Since position 6 there are five such emitters:
 * finance/transactions, teams, projects, users, approvals and contracts.
 *
 * AuthModule is NOT IMPORTED HERE — and this is a fix from position 6, not an oversight.
 * It stood here "for the sake of JwtAuthGuard", but the guard is global (`APP_GUARD` in
 * `AppModule`), and the controller declares no `@UseGuards` at all: from
 * AuthModule it needs only the `@CurrentUser` decorator, and a decorator is not
 * a provider and does not require a module import. The same holds, for example, for
 * `LegendsModule` — also a JWT-protected controller without importing AuthModule.
 *
 * While the module was a leaf of the graph, an extra import cost nothing. As soon as
 * five modules began importing US, it closed the ring
 * users → notifications → auth → users, and `app.module.container.spec.ts`
 * caught it immediately ("The module at index [1] of the UsersModule
 * "imports" array is undefined"). Removing the unneeded edge is more honest than
 * wrapping five imports in `forwardRef`, hiding the cycle instead of removing it.
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
  // TelemetryModule — the channel into which a skipped notification goes
  // (SR-H-1): data parsing no longer throws, so a refusal must be
  // visible outside the process, otherwise it becomes a silent loss. The import cycle does not
  // hooks up: TelemetryModule depends only on `ScheduleModule` and knows
  // nothing about notifications.
  //
  // Position 7a added two imports:
  //   - `MailerModule` — the same `ResendMailerService` as the contact form and
  //     invitations. Importing `ContactModule` for its sake is not possible: it would produce
  //     the ring notifications → contact → vacancies → notifications (see
  //     `mailer.module.ts`).
  //   - `ScheduleModule.forRoot()` — for the sender's `@Cron`, the same device as
  //     in `TelemetryModule` and `VacanciesModule`.
  imports: [DatabaseModule, TelemetryModule, MailerModule, ScheduleModule.forRoot()],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationPreferencesService,
    NotificationEmailCronService,
    // The sender's seam: the cron knows `OutboxGateway`, not drizzle (see
    // `notification-email.cron.ts`). The token is needed because the interface
    // does not survive TypeScript compilation and cannot be injected by type.
    { provide: OUTBOX_GATEWAY, useClass: OutboxRepository },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
