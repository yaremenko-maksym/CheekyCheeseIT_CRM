import { Module } from '@nestjs/common'
import { ApprovalsModule } from '../approvals/approvals.module'
import { DatabaseModule } from '../database/database.module'
import { PendingController } from './pending.controller'
import { PendingService } from './pending.service'

/**
 * task-pending-screen (position 7c) — `GET /pending`. Imports
 * `ApprovalsModule` directly (same pattern `ProjectsModule`/`UsersModule`
 * already use to reach `ApprovalsService` — Nest module imports are not
 * transitive) rather than reaching into `approvals/**` itself: this module
 * OWNS the cross-subject aggregation, `ApprovalsModule` stays the
 * subject-agnostic foundation it documents itself as.
 */
@Module({
  imports: [DatabaseModule, ApprovalsModule],
  controllers: [PendingController],
  providers: [PendingService],
})
export class PendingModule {}
