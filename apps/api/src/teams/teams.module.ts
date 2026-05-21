import { Module, forwardRef } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { DatabaseModule } from '../database/database.module'
import { UsersModule } from '../users/users.module'
import { TeamAuditLogService } from './team-audit-log.service'
import { TeamsController } from './teams.controller'
import { TeamsService } from './teams.service'

@Module({
  imports: [DatabaseModule, forwardRef(() => AuthModule), forwardRef(() => UsersModule)],
  controllers: [TeamsController],
  providers: [TeamsService, TeamAuditLogService],
  exports: [TeamsService, TeamAuditLogService],
})
export class TeamsModule {}
