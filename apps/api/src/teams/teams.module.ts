import { Module, forwardRef } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { DatabaseModule } from '../database/database.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { UsersModule } from '../users/users.module'
import { TeamAuditLogService } from './team-audit-log.service'
import { TeamsController } from './teams.controller'
import { TeamsService } from './teams.service'

@Module({
  imports: [
    DatabaseModule,
    forwardRef(() => AuthModule),
    forwardRef(() => UsersModule),
    // task-notification-types-producers (позиция 6) — производитель «вас
    // добавили в команду» / «в команде новый участник».
    NotificationsModule,
  ],
  controllers: [TeamsController],
  providers: [TeamsService, TeamAuditLogService],
  exports: [TeamsService, TeamAuditLogService],
})
export class TeamsModule {}
