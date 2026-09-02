import { Module, forwardRef } from '@nestjs/common'
import { ApprovalsModule } from '../approvals/approvals.module'
import { AuthModule } from '../auth/auth.module'
import { DatabaseModule } from '../database/database.module'
import { UsersModule } from '../users/users.module'
import { ProjectAuditLogService } from './project-audit-log.service'
import { ProjectsController } from './projects.controller'
import { ProjectsService } from './projects.service'

@Module({
  imports: [
    DatabaseModule,
    ApprovalsModule,
    forwardRef(() => AuthModule),
    forwardRef(() => UsersModule),
  ],
  controllers: [ProjectsController],
  providers: [ProjectsService, ProjectAuditLogService],
  exports: [ProjectsService, ProjectAuditLogService],
})
export class ProjectsModule {}
