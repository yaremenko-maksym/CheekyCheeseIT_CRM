import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import {
  adminUpdateTransactionSchema,
  attachReceiptSchema,
  confirmPayoutSchema,
  createAdminIncomeSchema,
  createAdminTransferSchema,
  createDropIncomeSchema,
  createExpenseSchema,
  createPayoutRequestSchema,
  createSeniorIncomeSchema,
  createUsdtIncomeSchema,
  createSalarySchema,
  deleteTransactionSchema,
  dropIncomesQuerySchema,
  incomeComplianceQuerySchema,
  manualConfirmPayoutSchema,
  releaseOnChainHashSchema,
  payPayoutRequestSchema,
  paySalarySchema,
  restoreTransactionSchema,
  updateProjectFinanceSettingsSchema,
  updateDropIncomeSchema,
  updateSeniorIncomeSchema,
  validateTransactionSchema,
} from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import {
  ONCHAIN_HASH_INSPECT_LIMIT,
  ONCHAIN_HASH_RELEASE_LIMIT,
  RelaxableThrottle,
} from '../config/throttle-decorators'
import { NbuCurrencyService } from './nbu-currency.service'
import { TransactionsService } from './transactions.service'

// Auth enforced by global JwtAuthGuard (see AppModule APP_GUARD) for all
// controllers in this file. RBAC is NOT global — RolesGuard must be attached
// explicitly. Audit 2026-06-27 (LOW): the financial write endpoints below
// previously had NO controller-level guard (only paySalary carried a method
// guard), so every @Roles was inert and these money endpoints relied solely on
// the service-side check. @UseGuards(RolesGuard) at the class level enforces
// every @Roles-decorated method at the guard layer (403 BEFORE the handler), in
// ADDITION to the service-side checks which are KEPT as defense-in-depth. Each
// per-method @Roles below matches its service-side `currentUser.role` check
// EXACTLY (verified against transactions.service.ts). Methods gated by OWNERSHIP
// rather than role (updateSeniorIncome: `tx.receiverId === currentUser.id`)
// carry NO @Roles — RolesGuard returns true when no metadata is present, leaving
// the service-side ownership check authoritative.
@Controller('transactions')
@UseGuards(RolesGuard)
export class TransactionsController {
  // Explicit @Inject so the REAL controller can be instantiated by Nest's DI
  // in the vitest/esbuild env (which omits `design:paramtypes`) — required by
  // the pay-salary RBAC integration spec. Mirrors PayoutRequestsController.
  constructor(@Inject(TransactionsService) private readonly svc: TransactionsService) {}

  @Get()
  findAll(
    @CurrentUser() user: SessionUser,
    @Query('type') type: string | undefined,
    @Query('status') status: string | undefined,
    @Query('projectId') projectId: string | undefined,
    @Query('seniorId') seniorId: string | undefined,
    @Query('month') month: string | undefined,
    // task-soft-delete-and-money-audit (AC3): «показать удалённые» — the
    // service enforces the RBAC gate (ADMIN/ACCOUNTANT only, and default
    // false for everyone) so a non-privileged caller passing this is a no-op.
    @Query('includeDeleted') includeDeleted: string | undefined,
  ) {
    return this.svc.findAll(user, {
      ...(type !== undefined && { type }),
      ...(status !== undefined && { status }),
      ...(projectId !== undefined && { projectId }),
      ...(seniorId !== undefined && { seniorId }),
      ...(month !== undefined && { month }),
      ...(includeDeleted !== undefined && { includeDeleted: includeDeleted === 'true' }),
    })
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.svc.findOne(id, user)
  }

  @Post('admin-income')
  @Roles('ADMIN', 'ACCOUNTANT')
  createAdminIncome(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.createAdminIncome(
      createAdminIncomeSchema.parse(body) as Parameters<
        TransactionsService['createAdminIncome']
      >[0],
      user,
    )
  }

  @Post('senior-income')
  @Roles('SENIOR')
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
  @Roles('DROP')
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

  // BIZ-17: DROP resubmit path for REJECTED DROP_INCOME. Service-side ownership
  // check (tx.receiverId === currentUser.id) is the gate — no @Roles needed;
  // RolesGuard passes when no metadata is present.
  @Patch('drop-income/:id')
  updateDropIncome(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    return this.svc.updateDropIncome(
      id,
      updateDropIncomeSchema.parse(body) as Parameters<TransactionsService['updateDropIncome']>[1],
      user,
    )
  }

  @Post('expense')
  @Roles('ADMIN', 'ACCOUNTANT')
  createExpense(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.createExpense(
      createExpenseSchema.parse(body) as Parameters<TransactionsService['createExpense']>[0],
      user,
    )
  }

  @Post('salary')
  @Roles('ADMIN', 'ACCOUNTANT')
  createSalary(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.createSalary(
      createSalarySchema.parse(body) as Parameters<TransactionsService['createSalary']>[0],
      user,
    )
  }

  @Post('admin-transfer')
  @Roles('ADMIN', 'ACCOUNTANT')
  createAdminTransfer(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.createAdminTransfer(
      createAdminTransferSchema.parse(body) as Parameters<
        TransactionsService['createAdminTransfer']
      >[0],
      user,
    )
  }

  @Patch(':id/validate')
  @Roles('ADMIN', 'ACCOUNTANT')
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
  @Roles('ADMIN', 'ACCOUNTANT')
  confirmPayout(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: SessionUser) {
    const data = confirmPayoutSchema.parse(body)
    return this.svc.confirmPayout(id, data.recipientAdminId, user, {
      method: data.method,
      ...(data.txHash !== undefined && data.txHash !== null ? { txHash: data.txHash } : {}),
    })
  }

  // Defense-in-depth: the service-side `if (currentUser.role !== 'ADMIN')` guard
  // is KEPT; the class-level RolesGuard now enforces this @Roles (the previous
  // method-level @UseGuards(RolesGuard) is redundant and was removed — audit
  // 2026-06-27).
  @Patch(':id/pay')
  @Roles('ADMIN')
  paySalary(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.paySalary(id, paySalarySchema.parse(body), user)
  }

  @Patch(':id/admin-edit')
  @Roles('ADMIN')
  adminEdit(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.adminUpdateTransaction(id, adminUpdateTransactionSchema.parse(body), user)
  }

  // task-receipts-backend (pm-brief §6): generic attach/replace of a receipt on
  // an existing transaction. NO @Roles — RBAC is ownership+role-based and lives
  // in the service (ADMIN/ACCOUNTANT → any; author → own; replace after PAID →
  // only ADMIN/ACCOUNTANT). Body validated via attachReceiptSchema (XOR, one of
  // doc/url mandatory); the USDT explorer-only rule is applied in the service
  // (the effective currency comes from the existing transaction).
  // LOW (review round 1): ParseUUIDPipe on `:id` — a malformed id (non-uuid)
  // now 400s at the pipe instead of reaching the service and blowing up as a
  // 500 on the underlying Postgres uuid-cast error.
  @Patch(':id/receipt')
  attachReceipt(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentUser() user: SessionUser,
  ) {
    return this.svc.attachOrReplaceReceipt(id, attachReceiptSchema.parse(body), user)
  }

  // MED-G (security-review PR #438): release a mis-claimed on-chain hash so the
  // transfer can be settled again. ADMIN only (RolesGuard + a service-side
  // re-check) and always journaled with a reason — the counterweight to a
  // registry whose claims are otherwise permanent. Deliberately NOT a route on
  // `:id`: the subject is the HASH, which may outlive every row referencing it.
  // MED-M (round 5): the most destructive handle in this module — it makes a
  // spent transfer spendable again. Rate-limited like its neighbours (wallet
  // update / dividends are 5/min, deposits 12), so a scripted mistake or an
  // abused session cannot walk the registry.
  @Post('onchain-hash/release')
  @Roles('ADMIN')
  @RelaxableThrottle(ONCHAIN_HASH_RELEASE_LIMIT)
  @HttpCode(200)
  releaseOnChainHash(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    const data = releaseOnChainHashSchema.parse(body)
    return this.svc.releaseOnChainHash(data.txHash, data.reason, user)
  }

  // MED-K (round 5): LOOK before you release. Without this the only way to
  // learn who owns a claim was to call the release — which destroyed it, so a
  // typo silently freed somebody else's legitimate claim. Read-only, and it
  // reports what releasing would mean for the referent.
  //
  // LOW (round 6): the hash arrives as a QUERY parameter, not a path segment.
  // The whole point of the shared extractor is that an explorer LINK is valid
  // input — and a link contains slashes, so as `:txHash` it never matched the
  // route and the operator got a bare 404 instead of the 400 that explains the
  // problem. Also throttled: it is a read, but it is a read of the money path.
  @Get('onchain-hash')
  @Roles('ADMIN', 'ACCOUNTANT')
  @RelaxableThrottle(ONCHAIN_HASH_INSPECT_LIMIT)
  inspectOnChainHash(@Query('txHash') txHash: unknown, @CurrentUser() user: SessionUser) {
    // MED-S (round 7): `?txHash=a&txHash=b` arrives as an ARRAY, and anything
    // non-string crashed the handler on `.trim()` — a 500 on the money path,
    // introduced by moving the hash into a query parameter. Narrow here and let
    // the service answer with its normal 400.
    if (typeof txHash !== 'string') {
      throw new BadRequestException(
        'Укажите ровно один параметр txHash (0x + 64 hex или ссылка на Etherscan)',
      )
    }
    return this.svc.inspectOnChainHash(txHash, user)
  }

  // task-soft-delete-and-money-audit (security-audit finding 3, 27.07). Now a
  // SOFT delete (marks deletedAt/deletedBy/deletionReason — the row is never
  // physically removed). `reason` is mandatory (Zod `min(3)`); a DELETE with
  // a body is intentional here (Fastify/axios both support it) — see
  // `financeApi.deleteTransaction`.
  @Delete(':id')
  @Roles('ADMIN')
  @HttpCode(200)
  adminDelete(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: SessionUser) {
    const data = deleteTransactionSchema.parse(body)
    return this.svc.adminDeleteTransaction(id, data.reason, user)
  }

  // task-soft-delete-and-money-audit. Reverses a soft delete — ADMIN only
  // (ACCOUNTANT can SEE a deleted row via `?includeDeleted=true` / a direct
  // GET, but cannot restore it — RolesGuard + a service-side re-check).
  // Reason is mandatory for the same audit-trail reason as delete.
  @Patch(':id/restore')
  @Roles('ADMIN')
  restore(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: SessionUser) {
    const data = restoreTransactionSchema.parse(body)
    return this.svc.restoreTransaction(id, data.reason, user)
  }

  // security-review PR #456 (MED-3): read side of `transaction_audit_log` —
  // ADMIN only. See TransactionsService.getTransactionAuditLog's doc for why.
  @Get(':id/audit-log')
  @Roles('ADMIN')
  getAuditLog(@Param('id') id: string, @CurrentUser() user: SessionUser) {
    return this.svc.getTransactionAuditLog(id, user)
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

  // No @Roles here on purpose (see the class-level comment above) — RolesGuard
  // is effectively a NO-OP for this route (it returns true when no @Roles
  // metadata is present), so the REAL RBAC gate is the ForbiddenException at
  // the top of `TransactionsService.getSummary`. Do not "clean up" by
  // removing that service-side check as a supposed duplicate of the guard —
  // it is the only gate this route has.
  @Get('summary')
  getSummary(@CurrentUser() user: SessionUser) {
    return this.svc.getSummary(user)
  }

  // task-drop-share-override-and-receiver (D3). ADMIN declares USDT project income
  // on a USDT-payment project. POST /api/finance/usdt-income — ADMIN ONLY (Q4:
  // ACCOUNTANT may NOT declare). The @Roles('ADMIN') gate runs BEFORE the handler
  // (RolesGuard via class-level @UseGuards) — 403 for SENIOR/DROP/HR/JUNIOR/
  // ACCOUNTANT at the guard layer — in ADDITION to the service-side role check.
  // Body validated via createUsdtIncomeSchema (receiverId = an ADMIN uuid OR the
  // 'COMPANY_ACCOUNT' marker). The gross lands on the receiver; the company books
  // atomic obligations to the senior (unless ADMIN) and drop (if bound).
  @Post('usdt-income')
  @Roles('ADMIN')
  declareUsdtProjectIncome(@Body() body: unknown, @CurrentUser() user: SessionUser) {
    return this.svc.declareUsdtProjectIncome(
      createUsdtIncomeSchema.parse(body) as Parameters<
        TransactionsService['declareUsdtProjectIncome']
      >[0],
      user,
    )
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
  //
  // security-review PR #521 round 3 (LOW-1): the handle existed before this
  // task, but only server-side callers (always a clean, internally-computed
  // date) ever exercised it. The date-of-record feature is the FIRST thing
  // that puts a client-suppliable value on this path (both the settle
  // dialog's own preview fetch and — indirectly — whatever `?date=` a
  // caller of THIS route sends). Not SSRF (the NBU host is hardcoded), but
  // a malformed value still reaches the upstream URL unvalidated, and a
  // malformed/mistargeted request produces the exact same
  // cache-poisoning-shaped risk the MED fix above closes for the trusted
  // internal path — cheaper to reject the shape here than to reason about
  // every downstream consequence of an arbitrary string.
  @Get('exchange-rate')
  getExchangeRate(@Query('date') date: string | undefined) {
    if (date !== undefined && !/^\d{8}$/.test(date)) {
      throw new BadRequestException('date должен быть в формате YYYYMMDD')
    }
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
