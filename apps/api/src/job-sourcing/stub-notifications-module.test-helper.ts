import { Module } from '@nestjs/common'
import { NotificationsService } from '../notifications/notifications.service'

/**
 * Stands in for `NotificationsModule` in specs that boot the REAL `JobSourcingModule` (U5a made it
 * import the notifications module for the ADMIN alerts). The real one pulls telemetry, the mailer
 * and the scheduler, none of which these container specs are about.
 *
 *   .overrideModule(NotificationsModule).useModule(StubNotificationsModule)
 */
@Module({
  providers: [{ provide: NotificationsService, useValue: {} }],
  exports: [NotificationsService],
})
export class StubNotificationsModule {}
