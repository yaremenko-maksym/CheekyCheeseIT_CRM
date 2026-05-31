/**
 * Drop role - phase 4-A. Public read-only endpoints for the new on-demand
 * balance pipeline. The controllers stay thin: RBAC checks delegate into
 * BalanceService.assertCan… helpers, and the service returns wire-ready DTOs.
 *
 *   GET /api/balances/tov
 *   GET /api/balances/admin/:adminId
 *   GET /api/balances/senior/:seniorId
 *   GET /api/pending-obligations
 *
 * Mounted alongside the legacy `FinanceSummaryController` in `FinanceModule`.
 * Phase 2 getSummary is intentionally NOT migrated here; both flows coexist.
 */
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
import { JwtAuthGuard } from '../auth/jwt.guard'
import {
  BalanceService,
  type BalanceCurrency,
  type PendingObligationsFilter,
} from './balance.service'

const SUPPORTED_CURRENCIES: ReadonlyArray<BalanceCurrency> = ['USDT', 'USD', 'EUR', 'UAH']

function parseCurrency(input: string | undefined): BalanceCurrency {
  if (!input) return 'USD'
  const normalised = input.toUpperCase() as BalanceCurrency
  return SUPPORTED_CURRENCIES.includes(normalised) ? normalised : 'USD'
}

@UseGuards(JwtAuthGuard)
@Controller('balances')
export class BalanceController {
  constructor(private readonly balance: BalanceService) {}

  @Get('tov')
  async getTOV(
    @CurrentUser() user: SessionUser,
    @Query('currency') currency: string | undefined,
  ) {
    this.balance.assertCanReadTOV(user)
    return this.balance.getTOVBalance(parseCurrency(currency))
  }

  @Get('admin/:adminId')
  async getAdmin(
    @Param('adminId') adminId: string,
    @CurrentUser() user: SessionUser,
    @Query('currency') currency: string | undefined,
  ) {
    this.balance.assertCanReadAdminBalance(user, adminId)
    return this.balance.getAdminBalance(adminId, parseCurrency(currency))
  }

  @Get('senior/:seniorId')
  async getSenior(
    @Param('seniorId') seniorId: string,
    @CurrentUser() user: SessionUser,
    @Query('currency') currency: string | undefined,
  ) {
    this.balance.assertCanReadSeniorBalance(user, seniorId)
    return this.balance.getSeniorBalance(seniorId, parseCurrency(currency))
  }
}

/**
 * `/api/pending-obligations` lives on its own controller (sibling to
 * BalanceController) so URL grouping reads naturally — balances are an
 * aggregate, pending obligations are an entity list with its own lifecycle.
 */
@UseGuards(JwtAuthGuard)
@Controller('pending-obligations')
export class PendingObligationsController {
  constructor(private readonly balance: BalanceService) {}

  @Get()
  async list(
    @CurrentUser() user: SessionUser,
    @Query('status') status: string | undefined,
    @Query('creditorUserId') creditorUserId: string | undefined,
  ) {
    this.balance.assertCanListPendingObligations(user)

    const filter: PendingObligationsFilter = {}
    if (status === 'PENDING' || status === 'PAID' || status === 'CANCELLED') {
      filter.status = status
    }

    // SENIOR can only see their own obligations regardless of the query
    // string. ADMIN/ACCOUNTANT may filter by an explicit creditorUserId or
    // omit it for the full list.
    if (user.role === 'SENIOR') {
      filter.creditorUserId = user.id
    } else if (creditorUserId) {
      filter.creditorUserId = creditorUserId
    }

    return this.balance.getPendingObligations(filter)
  }
}
