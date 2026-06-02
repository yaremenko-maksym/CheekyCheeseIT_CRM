/**
 * Pending senior settlement endpoints.
 *
 * task-drop-company-debt-and-invoices:
 *
 *   GET  /api/pending-settlements/senior            — list pending senior
 *                                                     IOUs visible to the caller.
 *   GET  /api/pending-settlements/company           — pending COMPANY debts
 *                                                     (ADMIN / ACCOUNTANT only).
 *   POST /api/pending-settlements/:id/settle-company
 *                                                   — close a COMPANY debt;
 *                                                     body {}.
 *
 * Removed in this refactor: `GET /api/pending-settlements/drop` and
 * `POST /api/pending-settlements/:id/settle-drop`. The DROP role no longer
 * holds debts to seniors — the senior share is owed by the company itself
 * and closed by ADMIN/ACCOUNTANT only.
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

  @Get('company')
  listCompany(@CurrentUser() user: SessionUser) {
    return this.svc.listCompanyObligations(user)
  }

  @Post(':id/settle-company')
  settleCompany(@Param('id') id: string, @Body() _body: unknown, @CurrentUser() user: SessionUser) {
    const data = settleObligationParamSchema.parse({ id })
    return this.svc.settleByCompany(data.id, user)
  }
}
