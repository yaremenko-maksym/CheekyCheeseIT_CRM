import { Module, forwardRef } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { DatabaseModule } from '../database/database.module'
import { FinanceModule } from '../finance/finance.module'
import { AuditInterceptor } from '../common/interceptors/audit.interceptor'
import { UsersController } from './users.controller'
import { UsersAccessService } from './users-access.service'
import { AuditLogService } from './audit-log.service'
import { UsersService } from './users.service'

@Module({
  imports: [DatabaseModule, forwardRef(() => AuthModule), forwardRef(() => FinanceModule)],
  controllers: [UsersController],
  providers: [UsersService, UsersAccessService, AuditLogService, AuditInterceptor],
  exports: [UsersService, UsersAccessService, AuditLogService],
})
export class UsersModule {}
