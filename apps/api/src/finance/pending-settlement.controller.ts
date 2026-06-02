/**
 * Drop role - phase 4 (refactor — task-drop-phase4-refactor-remove-tov.md).
 * Pending senior settlement endpoints.
 *
 *   GET  /api/pending-settlements/senior          — list pending senior IOUs
 *                                                   visible to the caller.
 *   GET  /api/pending-settlements/drop            — DROP-debt obligations
 *                                                   (DROP / ACCOUNTANT / ADMIN).
 *   POST /api/pending-settlements/:id/settle-drop — close DROP debt; body {}.
 *
 * Removed in the refactor (AC3): GET /api/pending-settlements/tov and
 * POST /api/pending-settlements/:id/settle-tov. The TOV-debt lifecycle is
 * gone.
 *
 * RBAC is enforced inside `PendingSettlementService`. The controller stays
 * thin — it just validates the path parameter through the shared Zod schema
 * and delegates.
 */
import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common'
import { settleObligationParamSchema } from '@crm/shared'
import type { SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { JwtAuthGuard } from '../auth/jwt.guard'
import { PendingSettlementService } from './pending-settlement.service'

@UseGuards(JwtAuthGuard)
@Controller('pending-settlements')
export class PendingSettlementController {
  constructor(private readonly svc: PendingSettlementService) {}

  @Get('senior')
  listSenior(@CurrentUser() user: SessionUser) {
    return this.svc.listSeniorObligations(user)
  }

  @Get('drop')
  listDrop(@CurrentUser() user: SessionUser) {
    return this.svc.listDropObligations(user)
  }

  @Post(':id/settle-drop')
  settleDrop(@Param('id') id: string, @Body() _body: unknown, @CurrentUser() user: SessionUser) {
    const data = settleObligationParamSchema.parse({ id })
    return this.svc.settleByDrop(data.id, user)
  }
}
