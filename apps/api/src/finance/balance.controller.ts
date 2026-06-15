/**
 * Drop role - phase 4 (refactor — task-drop-phase4-refactor-remove-tov.md).
 * Read-only endpoints for personal balance lookups (admin / senior) and the
 * pending-obligations list.
 *
 *   GET /api/balances/admin/:adminId
 *   GET /api/balances/senior/:seniorId
 *   GET /api/pending-obligations
 *
 * Removed in the refactor (AC3): GET /api/balances/tov. The corporate ТОВ
 * balance has no place in the post-refactor model.
 *
 * Mounted alongside the legacy `FinanceSummaryController` in `FinanceModule`.
 */
import { Controller, Get, Param, Query } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { CurrentUser } from '../auth/current-user.decorator'
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

// Auth enforced by global JwtAuthGuard (see AppModule APP_GUARD).
@Controller('balances')
export class BalanceController {
  constructor(private readonly balance: BalanceService) {}

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

  /**
   * GET /api/balances/total-earned/:userId — lifetime «всего заработано с нами».
   * RBAC: ADMIN / ACCOUNTANT only (assertCanReadTotalEarned). Returns a
   * TotalEarnedDto for any target user (SENIOR / DROP / JUNIOR / HR / …),
   * computed by SQL aggregation of PAID rows mapped to the target's role.
   */
  @Get('total-earned/:userId')
  async getTotalEarned(
    @Param('userId') userId: string,
    @CurrentUser() user: SessionUser,
    @Query('currency') currency: string | undefined,
  ) {
    this.balance.assertCanReadTotalEarned(user)
    return this.balance.getTotalEarned(userId, parseCurrency(currency))
  }
}

/**
 * `/api/pending-obligations` lives on its own controller (sibling to
 * BalanceController) so URL grouping reads naturally — balances are an
 * aggregate, pending obligations are an entity list with its own lifecycle.
 */
// Auth enforced by global JwtAuthGuard (see AppModule APP_GUARD).
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
