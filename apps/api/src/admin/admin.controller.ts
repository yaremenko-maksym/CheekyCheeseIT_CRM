import { Controller, Get, Inject, UseGuards } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { AdminSummaryService } from './admin-summary.service'

/**
 * ADMIN dashboard endpoints. Auth is enforced by the global JwtAuthGuard (see
 * AppModule APP_GUARD); RBAC is enforced by the class-level RolesGuard combined
 * with the per-method @Roles('ADMIN') metadata — so a non-ADMIN caller gets 403
 * at the guard layer BEFORE the handler runs, IN ADDITION to the service-side
 * ForbiddenException (defense-in-depth — the company-wide aggregate must never
 * leak to a non-ADMIN, recurring «front-only / service-only gating» gap).
 *
 * Explicit @Inject so the controller can be instantiated by Nest's DI in the
 * vitest/esbuild env (which omits `design:paramtypes`) — required by the
 * admin-summary RBAC integration spec. Mirrors TransactionsController.
 */
@Controller('admin')
@UseGuards(RolesGuard)
export class AdminController {
  constructor(@Inject(AdminSummaryService) private readonly svc: AdminSummaryService) {}

  // GET /api/admin/summary — ADMIN ONLY. KPI counters + actionable transaction
  // pipeline behind the «центр действий» dashboard. Returns `adminSummarySchema`.
  @Get('summary')
  @Roles('ADMIN')
  getSummary(@CurrentUser() user: SessionUser) {
    return this.svc.getSummary(user)
  }
}
