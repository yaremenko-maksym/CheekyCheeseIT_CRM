import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import {
  adminUpdateTransactionSchema,
  confirmPayoutSchema,
  createAdminIncomeSchema,
  createAdminTransferSchema,
  createDropIncomeSchema,
  createExpenseSchema,
  createPayoutRequestSchema,
  createSeniorIncomeSchema,
  createSalarySchema,
  dropIncomesQuerySchema,
  incomeComplianceQuerySchema,
  manualConfirmPayoutSchema,
  payPayoutRequestSchema,
  paySalarySchema,
  updateProjectFinanceSettingsSchema,
  updateSeniorIncomeSchema,
  validateTransactionSchema,
} from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { NbuCurrencyService } from './nbu-currency.service'
import { TransactionsService } from './transactions.service'

// Auth enforced by global JwtAuthGuard (see AppModule APP_GUARD) for all
// controllers in this file.
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly svc: TransactionsService) {}

  @Get()
  findAll(
    @CurrentUser() user: SessionUser,
    @Query('type') type: string | undefined,
    @Query('status') status: string | undefined,
    @Query('projectId') projectId: string | undefined,
    @Query('seniorId') seniorId: string | undefined,
    @Query('month') month: string | undefined,
  ) {
    return this.svc.findAll(user, {
      ...(type !== undefined && { type }),
      ...(status !== undefined && { status }),
      ...(projectId !== undefined && { projectId }),
      ...(seniorId !== undefined && { seniorId }),
      ...(month !== undefined && { month }),
    })
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.svc.findOne(id, user)
  }

  @Post('admin-income')
  createAdminIncome(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.createAdminIncome(
      createAdminIncomeSchema.parse(body) as Parameters<
        TransactionsService['createAdminIncome']
      >[0],
      user,
    )
  }

  @Post('senior-income')
  createSeniorIncome(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.createSeniorIncome(
      createSeniorIncomeSchema.parse(body) as Parameters<
        TransactionsService['createSeniorIncome']
      >[0],
      user,
    )
  }

  // Drop role - phase 2. Parallel endpoint for DROP role only — service
  // enforces RBAC (DROP role + project.dropId === caller.id). The frontend
  // can call the same shape as senior-income.
  @Post('drop-income')
  createDropIncome(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.createDropIncome(
      createDropIncomeSchema.parse(body) as Parameters<TransactionsService['createDropIncome']>[0],
      user,
    )
  }

  @Patch('senior-income/:id')
  updateSeniorIncome(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    return this.svc.updateSeniorIncome(
      id,
      updateSeniorIncomeSchema.parse(body) as Parameters<
        TransactionsService['updateSeniorIncome']
      >[1],
      user,
    )
  }

  @Post('expense')
  createExpense(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.createExpense(
      createExpenseSchema.parse(body) as Parameters<TransactionsService['createExpense']>[0],
      user,
    )
  }

  @Post('salary')
  createSalary(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.createSalary(
      createSalarySchema.parse(body) as Parameters<TransactionsService['createSalary']>[0],
      user,
    )
  }

  @Post('admin-transfer')
  createAdminTransfer(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.createAdminTransfer(
      createAdminTransferSchema.parse(body) as Parameters<
        TransactionsService['createAdminTransfer']
      >[0],
      user,
    )
  }

  @Patch(':id/validate')
  validate(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: SessionUser) {
    const data = validateTransactionSchema.parse(body)
    return this.svc.validateTransaction(id, data.action, data.rejectionReason, user)
  }

  // Drop role - phase 3 (manual payout confirmation, spec §8.4). ACCOUNTANT or
  // ADMIN selects which admin partner actually received the off-platform
  // PAYOUT and the backend records both halves in one transaction (PAYOUT →
  // PAID + new PAYOUT_CONFIRMED row crediting the chosen admin). See
  // `confirmPayout` in transactions.service.ts for the full contract.
  @Post(':id/confirm-payout')
  confirmPayout(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: SessionUser) {
    const data = confirmPayoutSchema.parse(body)
    return this.svc.confirmPayout(id, data.recipientAdminId, user, {
      method: data.method,
      ...(data.txHash !== undefined && data.txHash !== null ? { txHash: data.txHash } : {}),
    })
  }

  @Patch(':id/pay')
  paySalary(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.paySalary(id, paySalarySchema.parse(body), user)
  }

  @Patch(':id/admin-edit')
  adminEdit(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.adminUpdateTransaction(id, adminUpdateTransactionSchema.parse(body), user)
  }

  @Delete(':id')
  @HttpCode(200)
  adminDelete(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.svc.adminDeleteTransaction(id, user)
  }
}

@Controller('payout-requests')
export class PayoutRequestsController {
  // Explicit @Inject so this REAL controller can be instantiated by Nest's DI in
  // the vitest/esbuild env (which omits `design:paramtypes`) — required by the
  // real-controller RBAC integration spec (payout-manual-confirm.rbac.integration
  // .spec.ts, M2 green-wash fix). Mirrors CompanyAccountController. Dropping
  // @Roles/@UseGuards from the manual-confirm route turns THAT spec red.
  constructor(@Inject(TransactionsService) private readonly svc: TransactionsService) {}

  @Get()
  findAll(@CurrentUser() user: SessionUser) {
    return this.svc.findPayoutRequests(user)
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.svc.findPayoutRequest(id, user)
  }

  @Post()
  create(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.createPayoutRequest(createPayoutRequestSchema.parse(body).transactionIds, user)
  }

  @Patch(':id/pay')
  pay(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: SessionUser) {
    const data = payPayoutRequestSchema.parse(body)
    // simulateResult is a DEV-only escape hatch: forwarded only when the
    // client opted in, so production builds (which can't render the toggle)
    // call the original 3-arg overload. The service ignores it outside of
    // NODE_ENV !== 'production' regardless. txHash is optional in simulate
    // mode — service synthesizes a stub when absent.
    if (data.simulateResult !== undefined) {
      return this.svc.payPayoutRequest(id, data.txHash, user, data.simulateResult)
    }
    return this.svc.payPayoutRequest(id, data.txHash, user)
  }

  // Phase 8 v2 — manual payout confirmation. ADMIN/ACCOUNTANT mark a payout PAID
  // when it was settled OFF the on-chain happy path (COMPANY_ACCOUNT vouched,
  // ADMIN_USDT to a partner's personal wallet, or CASH). Only COMPANY_ACCOUNT
  // credits the company balance. RolesGuard enforces RBAC (the @Roles metadata
  // is inert without it — RolesGuard is NOT a global APP_GUARD); the service
  // re-checks the role for defense-in-depth.
  @Post(':id/manual-confirm')
  @UseGuards(RolesGuard)
  @Roles('ADMIN', 'ACCOUNTANT')
  manualConfirm(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: SessionUser) {
    const data = manualConfirmPayoutSchema.parse(body)
    return this.svc.manualConfirmPayout(id, data.method, user, {
      ...(data.note !== undefined && data.note !== null ? { note: data.note } : {}),
      ...(data.txHash !== undefined && data.txHash !== null ? { txHash: data.txHash } : {}),
    })
  }
}

// RolesGuard is NOT a global APP_GUARD (AppModule registers only JwtAuthGuard /
// OnboardingGuard / ThrottlerGuard) — so @Roles(...) is inert unless the guard
// is attached here. @UseGuards(RolesGuard) at the class level enforces every
// @Roles-decorated method below; methods WITHOUT @Roles stay open to any
// authenticated user (RolesGuard returns true when no metadata is present), so
// `summary` / `accountant-summary` / `drop/me/*` / `exchange-rate` keep their
// existing service-side RBAC untouched. This closes the recurring "front-only /
// service-only gating" gap flagged in the #234 review for the live
// senior-summary route (the service-side ForbiddenException is KEPT —
// defense-in-depth, never replaced).
@Controller('finance')
@UseGuards(RolesGuard)
export class FinanceSummaryController {
  constructor(
    private readonly svc: TransactionsService,
    private readonly nbu: NbuCurrencyService,
  ) {}

  @Get('summary')
  getSummary(@CurrentUser() user: SessionUser) {
    return this.svc.getSummary(user)
  }

  // ACCOUNTANT Sprint 1. KPI snapshot for the accountant финансовый хаб
  // (AccountantDashboard). GET /api/finance/accountant-summary — ACCOUNTANT +
  // ADMIN ONLY; the service throws ForbiddenException for every other role
  // (SENIOR / JUNIOR / HR / DROP), so company-wide validation KPI never leak.
  // Returns `accountantSummarySchema` shape ({ pendingValidation,
  // validatedThisMonth, paidThisMonth, recipientCount }).
  @Get('accountant-summary')
  getAccountantSummary(@CurrentUser() user: SessionUser) {
    return this.svc.getAccountantSummary(user)
  }

  // «Контроль приходов» (task-income-compliance). Company-wide overview of which
  // income receivers (SENIOR / ADMIN-as-senior / DROP) have / have NOT registered
  // a counted (VALIDATED|PAID) income per active project this month. GET
  // /api/finance/income-compliance?month=YYYY-MM — ADMIN + ACCOUNTANT ONLY.
  //
  // This is an AGGREGATE over MANY receivers (NOT self-scoped), so it must never
  // leak to a non-privileged caller. The @Roles('ADMIN','ACCOUNTANT') gate runs
  // BEFORE the handler (RolesGuard via the class-level @UseGuards), giving 403 to
  // every other role (SENIOR / JUNIOR / HR / DROP) at the guard layer, IN ADDITION
  // to the service-side ForbiddenException (defense-in-depth — kept intentionally,
  // never replaced). income-compliance.integration.spec.ts pins this against the
  // REAL route. `month` is validated/coerced via incomeComplianceQuerySchema.
  @Get('income-compliance')
  @Roles('ADMIN', 'ACCOUNTANT')
  getIncomeCompliance(@CurrentUser() user: SessionUser, @Query() query: unknown) {
    const { month } = incomeComplianceQuerySchema.parse(query ?? {})
    return this.svc.getIncomeComplianceOverview(user, month)
  }

  // SENIOR dashboard (task-senior-dashboard). Self-scoped KPI snapshot for the
  // senior ролевой дашборд (SeniorDashboard). GET /api/finance/senior-summary —
  // SENIOR + ADMIN ONLY; the service throws ForbiddenException for every other
  // role (JUNIOR / HR / ACCOUNTANT / DROP). STRICTLY scoped to currentUser.id —
  // there is NO target-user param, so one senior can NEVER read another senior's
  // projects / income / payouts. Returns `seniorSummarySchema` shape
  // ({ activeProjects, seniorShareIncome, pendingPayouts, mySalaryStatus }).
  //
  // #234 review MED (defense-in-depth): the @Roles('SENIOR','ADMIN') gate runs
  // BEFORE the handler, so every other role (JUNIOR / HR / ACCOUNTANT / DROP)
  // gets 403 at the guard layer in addition to the service-side
  // ForbiddenException (kept intentionally — never replaced).
  // senior-summary.integration.spec.ts pins this against the REAL route (the
  // production controller, not a sentinel mirror).
  @Get('senior-summary')
  @Roles('SENIOR', 'ADMIN')
  getSeniorSummary(@CurrentUser() user: SessionUser) {
    return this.svc.getSeniorSummary(user)
  }

  // Drop role - phase 1 (task-drop-1-backend). Self-only DROP summary.
  // GET /api/finance/drop/me/summary — DROP role ONLY; the service throws
  // ForbiddenException for every other role (SENIOR / JUNIOR / HR / ACCOUNTANT
  // / ADMIN), so this never leaks the full `dropBalances` aggregate nor any
  // other drop's figures. Returns `dropSelfSummarySchema` shape
  // ({ balance, dropSharePercent, pendingIncomesCount, debtToCompany }).
  // Declared BEFORE `:id`-style routes is not a concern here — this controller
  // has no param routes — but the explicit `drop/me/summary` literal segment
  // also keeps it unambiguous.
  @Get('drop/me/summary')
  getDropSelfSummary(@CurrentUser() user: SessionUser) {
    return this.svc.getDropSelfSummary(user)
  }

  // Drop role - phase 2 (task-drop-2-backend). Self-only DROP income feed.
  // GET /api/finance/drop/me/incomes — DROP role ONLY (service throws 403 for
  // every other role). Scoped to the caller's own DROP_INCOME rows, so no
  // other drop's incomes can leak. Query params (status/type/from/to/page/
  // limit) are validated + coerced through `dropIncomesQuerySchema` (page/limit
  // arrive as strings on the query string → z.coerce). Returns a paginated
  // envelope (`paginatedDropIncomesSchema`). This literal `drop/me/incomes`
  // segment is unambiguous — the controller has no `:id` param routes.
  @Get('drop/me/incomes')
  getDropSelfIncomes(@CurrentUser() user: SessionUser, @Query() query: unknown) {
    return this.svc.getDropSelfIncomes(user, dropIncomesQuerySchema.parse(query ?? {}))
  }

  // Drop role - phase 2 (task-drop-2-backend). Self-only DROP outgoing payments
  // (drop → company). GET /api/finance/drop/me/payments — DROP role ONLY.
  // Scoped to the caller's own PAYOUT rows (senderId = self), so no other
  // drop's payments can leak. Returns `dropPaymentDtoSchema[]`.
  @Get('drop/me/payments')
  getDropSelfPayments(@CurrentUser() user: SessionUser) {
    return this.svc.getDropSelfPayments(user)
  }

  // ?date=YYYYMMDD — optional, defaults to today
  @Get('exchange-rate')
  getExchangeRate(@Query('date') date: string | undefined) {
    return this.nbu.getRates(date)
  }
}

@Controller('projects/:projectId/finance-settings')
export class ProjectFinanceSettingsController {
  constructor(private readonly svc: TransactionsService) {}

  @Get()
  get(@Param('projectId') projectId: string, @CurrentUser() user: SessionUser) {
    return this.svc.getProjectFinanceSettings(projectId, user)
  }

  @Patch()
  upsert(
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    return this.svc.upsertProjectFinanceSettings(
      projectId,
      updateProjectFinanceSettingsSchema.parse(body),
      user,
    )
  }
}
