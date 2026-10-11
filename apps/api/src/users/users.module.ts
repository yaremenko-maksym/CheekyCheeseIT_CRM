import { Module, forwardRef } from '@nestjs/common'
import { ApprovalsModule } from '../approvals/approvals.module'
import { AuthModule } from '../auth/auth.module'
import { ContactModule } from '../contact/contact.module'
import { DatabaseModule } from '../database/database.module'
import { FinanceModule } from '../finance/finance.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { TeamsModule } from '../teams/teams.module'
import { ProjectsModule } from '../projects/projects.module'
import { TelemetryModule } from '../telemetry/telemetry.module'
import { TosModule } from '../tos/tos.module'
import { AuditInterceptor } from '../common/interceptors/audit.interceptor'
import { UsersController } from './users.controller'
import { UsersAccessService } from './users-access.service'
import { AuditLogService } from './audit-log.service'
import { PersonalEmailInviteMailerService } from './personal-email-invite-mailer.service'
import { UsersService } from './users.service'

@Module({
  imports: [
    DatabaseModule,
    // task-pending-share (position 5): ApprovalsService is the foundation
    // both the base-share propose/approve/reject flow and its DTO-mapping
    // (`buildProfileView`'s `getStatus` lookup) depend on. Plain import (no
    // forwardRef) — ApprovalsModule only depends on DatabaseModule, so there
    // is no cycle to break.
    ApprovalsModule,
    // task-notification-types-producers (позиция 6): производитель «ждёт
    // решения: новая доля» для базовой доли. Обычный импорт, как и
    // ApprovalsModule выше и по той же причине: NotificationsModule — лист
    // графа, он зависит только от DatabaseModule (см. его собственный
    // комментарий о том, почему из него убран AuthModule).
    NotificationsModule,
    forwardRef(() => AuthModule),
    forwardRef(() => FinanceModule),
    forwardRef(() => TeamsModule),
    forwardRef(() => ProjectsModule),
    TosModule,
    // task-user-emails-invite: ContactModule exports ResendMailerService
    // (the Resend HTTP wrapper) — reused for the personal-email invite
    // send instead of a second client. TelemetryModule exports
    // TelemetryErrorsService, used to log a delivery failure.
    ContactModule,
    TelemetryModule,
  ],
  controllers: [UsersController],
  providers: [
    UsersService,
    UsersAccessService,
    AuditLogService,
    AuditInterceptor,
    PersonalEmailInviteMailerService,
  ],
  exports: [UsersService, UsersAccessService, AuditLogService],
})
export class UsersModule {}
