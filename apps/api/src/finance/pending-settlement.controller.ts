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
import { Body, Controller, Get, Inject, Param, Post, UseGuards } from '@nestjs/common'
import {
  settleObligationParamSchema,
  settleBySourceTransactionParamSchema,
  settleSeniorPayoutSchema,
} from '@crm/shared'
import type { SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { PendingSettlementService } from './pending-settlement.service'

// Auth enforced by global JwtAuthGuard (see AppModule APP_GUARD). RBAC, however,
// is NOT global — RolesGuard must be attached explicitly per controller, else
// the @Roles metadata is inert. Audit 2026-06-27 (MED/LOW): the read endpoints
// (listSenior/listCompany) and the obligation-id settle endpoint previously had
// NO controller-level guard, so @Roles never ran and these money-adjacent routes
// relied SOLELY on the service-side check. Attaching @UseGuards(RolesGuard) at
// the class level enforces every @Roles-decorated method below at the guard
// layer (403 BEFORE the handler), in ADDITION to the service-side checks which
// are KEPT as defense-in-depth (never replaced).
@Controller('pending-settlements')
@UseGuards(RolesGuard)
export class PendingSettlementController {
  // Explicit @Inject so the REAL controller can be instantiated by Nest's DI in
  // the vitest/esbuild env (which omits `design:paramtypes`) — required by the
  // finance-controller-guards RBAC integration spec. Mirrors TransactionsController
  // / PayoutRequestsController.
  constructor(@Inject(PendingSettlementService) private readonly svc: PendingSettlementService) {}

  // Senior IOU list: SENIOR (own) + ADMIN/ACCOUNTANT (all). Matches
  // PendingSettlementService.listSeniorObligations.
  @Get('senior')
  @Roles('ADMIN', 'ACCOUNTANT', 'SENIOR')
  listSenior(@CurrentUser() user: SessionUser) {
    return this.svc.listSeniorObligations(user)
  }

  // Company-debt list: ADMIN/ACCOUNTANT only. Matches listCompanyObligations.
  @Get('company')
  @Roles('ADMIN', 'ACCOUNTANT')
  listCompany(@CurrentUser() user: SessionUser) {
    return this.svc.listCompanyObligations(user)
  }

  // Settle a COMPANY debt by obligation id: ADMIN/ACCOUNTANT only (this is a
  // money write). Matches settleByCompany's service-side check.
  @Post(':id/settle-company')
  @Roles('ADMIN', 'ACCOUNTANT')
  settleCompany(@Param('id') id: string, @Body() _body: unknown, @CurrentUser() user: SessionUser) {
    const data = settleObligationParamSchema.parse({ id })
    return this.svc.settleByCompany(data.id, user)
  }

  // task-senior-settle-in-tx-row / task-senior-settle-owner: settle from the
  // finance-page transactions list, where the row carries the
  // SENIOR_PENDING_PAYOUT transaction id (not the obligation id). 3-segment path
  // → no overlap with the 2-segment `:id/settle-company` route above.
  //
  // The body now mirrors the SALARY pay flow: the ADMIN/ACCOUNTANT selects the
  // funding source (shared company account vs an admin partner's personal
  // account), the paying admin (for ADMIN_PERSONAL) and the currency. RBAC is
  // enforced HERE (RolesGuard — @Roles is inert without it since RolesGuard is
  // NOT a global APP_GUARD) AND re-checked in the service (defense in depth); the
  // money gate / idempotency / company-account debit live in the service.
  // RolesGuard is now attached at the class level — the method-level
  // @UseGuards(RolesGuard) is redundant and was removed (the class guard already
  // enforces this @Roles). Audit 2026-06-27.
  @Post('by-source-transaction/:sourceTransactionId/settle-company')
  @Roles('ADMIN', 'ACCOUNTANT')
  settleCompanyBySourceTransaction(
    @Param('sourceTransactionId') sourceTransactionId: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    const { sourceTransactionId: id } = settleBySourceTransactionParamSchema.parse({
      sourceTransactionId,
    })
    const funding = settleSeniorPayoutSchema.parse(body)
    return this.svc.settleByCompanySourceTransaction(id, user, funding)
  }
}
