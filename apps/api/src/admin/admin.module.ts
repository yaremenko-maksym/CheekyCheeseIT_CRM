import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module'
import { AdminController } from './admin.controller'
import { AdminSummaryService } from './admin-summary.service'

/**
 * ADMIN dashboard module — backs the «центр действий» admin dashboard.
 * Read-only aggregate over projects / users / transactions / interviews; no
 * write paths, so it only needs DatabaseModule.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [AdminController],
  providers: [AdminSummaryService],
  exports: [AdminSummaryService],
})
export class AdminModule {}
