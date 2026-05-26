/**
 * NotificationsModule — in-app notifications API.
 *
 * Exports `NotificationsService` so InvoicesModule (and any future emitter)
 * can inject it directly without re-importing DatabaseModule. AuthModule is
 * forwardRef'd for JwtAuthGuard (the controller is JWT-guarded but the
 * service surface is open for other modules to call without guards).
 */
import { Module, forwardRef } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { DatabaseModule } from '../database/database.module'
import { NotificationsController } from './notifications.controller'
import { NotificationsService } from './notifications.service'

@Module({
  imports: [DatabaseModule, forwardRef(() => AuthModule)],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
