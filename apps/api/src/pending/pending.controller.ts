import { Controller, Get, UseGuards } from '@nestjs/common'
import type { PendingResponse, SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { PendingService } from './pending.service'

/**
 * task-pending-screen (position 7c). One read-only endpoint — no `@Roles`
 * decorator, open to any authenticated user (`RolesGuard` passes when
 * `ROLES_KEY` is empty, same convention `ProjectsController`'s own header
 * comment documents): every role has at least a chance of an
 * employee-contract item, and the per-role shape difference (which
 * `approvals` rows exist for that role, `proposedByMe` ADMIN-only) is a
 * DATA decision made inside `PendingService`, not a route-level access
 * decision.
 */
@Controller('pending')
@UseGuards(RolesGuard)
export class PendingController {
  constructor(private readonly pendingService: PendingService) {}

  @Get()
  getPending(@CurrentUser() user: SessionUser): Promise<PendingResponse> {
    return this.pendingService.getPending(user)
  }
}
