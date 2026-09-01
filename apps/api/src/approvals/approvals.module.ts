import { Module } from '@nestjs/common'
import { DatabaseModule } from '../database/database.module'
import { ApprovalsService } from './approvals.service'

/**
 * Foundation module (task 3 of the notifications-and-confirmations plan) —
 * no controller yet. Future modules (positions 4/5: project creation, share
 * change) import this module and call `ApprovalsService` directly; the "что
 * от меня ждут" screen and any HTTP surface are position 7.
 */
@Module({
  imports: [DatabaseModule],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
