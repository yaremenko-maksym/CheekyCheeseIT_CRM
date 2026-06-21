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
 *                                                   — close a COMPANY debt by
 *                                                     obligation id; body {}.
 *   POST /api/pending-settlements/by-source-transaction/:sourceTransactionId/settle-company
 *                                                   — close a COMPANY debt by
 *                                                     its source (SENIOR_PENDING_PAYOUT)
 *                                                     transaction id; body {}.
 *                                                     Used by the finance-page
 *                                                     transactions list «Выплатить»
 *                                                     button (task-senior-settle-in-tx-row).
 *
 * Removed in this refactor: `GET /api/pending-settlements/drop` and
 * `POST /api/pending-settlements/:id/settle-drop`. The DROP role no longer
 * holds debts to seniors — the senior share is owed by the company itself
 * and closed by ADMIN/ACCOUNTANT only.
 */
import { Body, Controller, Get, Param, Post } from '@nestjs/common'
import { settleObligationParamSchema, settleBySourceTransactionParamSchema } from '@crm/shared'
import type { SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { PendingSettlementService } from './pending-settlement.service'

// Auth enforced by global JwtAuthGuard (see AppModule APP_GUARD).
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

  // task-senior-settle-in-tx-row: settle from the finance-page transactions
  // list, where the row carries the SENIOR_PENDING_PAYOUT transaction id (not
  // the obligation id). 3-segment path → no overlap with the 2-segment
  // `:id/settle-company` route above. RBAC + money gate enforced in the service.
  @Post('by-source-transaction/:sourceTransactionId/settle-company')
  settleCompanyBySourceTransaction(
    @Param('sourceTransactionId') sourceTransactionId: string,
    @Body() _body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const data = settleBySourceTransactionParamSchema.parse({ sourceTransactionId })
    return this.svc.settleByCompanySourceTransaction(data.sourceTransactionId, user)
  }
}
