import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { DatabaseModule } from '../database/database.module'
import { AuditController } from './audit.controller'
import { AuditService } from './audit.service'

/**
 * Phase 6 polish PR3 — compliance audit trail module.
 *
 * Provides read-only access to signed_contracts + tos_acceptances for
 * self-service data portability and ACCOUNTANT / ADMIN compliance review.
 *
 * No writes — AuditService is a pure query layer.
 */
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [AuditController],
  providers: [AuditService],
})
export class AuditModule {}
