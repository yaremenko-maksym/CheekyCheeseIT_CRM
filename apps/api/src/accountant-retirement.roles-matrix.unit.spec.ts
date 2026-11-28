/**
 * ACCOUNTANT retirement (design §13.3, PR 1b), AC 2: every `@Roles` set that lost ACCOUNTANT is
 * its old set minus ACCOUNTANT, and no endpoint widened. This runs the REAL `RolesGuard` with the
 * REAL `Reflector` over each touched handler's own metadata, for every live role plus a legacy
 * ACCOUNTANT session (still in `roleSchema` until PR 1d), so the full role × endpoint matrix is
 * pinned in one place. The expected sets are literals copied from the pre-PR decorators with
 * ACCOUNTANT struck out — not derived from the code under test.
 */
import { describe, expect, it } from 'vitest'
import { HttpException, type ExecutionContext } from '@nestjs/common'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import type { Role, SessionUser } from '@crm/shared'
import { RolesGuard } from './common/guards/roles.guard'
import { CompanyAccountController } from './finance/company-account.controller'
import { PendingSettlementController } from './finance/pending-settlement.controller'
import {
  FinanceSummaryController,
  PayoutRequestsController,
  TransactionsController,
} from './finance/transactions.controller'
import { UsersController } from './users/users.controller'

type Ctor = { prototype: object; name: string }

const ALL: Role[] = ['ADMIN', 'SENIOR', 'HR', 'JUNIOR', 'DROP', 'ACCOUNTANT']

const MATRIX: Array<[string, Ctor, string, Role[]]> = [
  ['GET /company-account', CompanyAccountController, 'getAccount', ['ADMIN']],
  [
    'GET /company-account/deposits/:id/status',
    CompanyAccountController,
    'getDepositStatus',
    ['SENIOR', 'DROP', 'ADMIN'],
  ],
  [
    'GET /pending-settlements/senior',
    PendingSettlementController,
    'listSenior',
    ['ADMIN', 'SENIOR'],
  ],
  ['GET /pending-settlements/company', PendingSettlementController, 'listCompany', ['ADMIN']],
  [
    'POST /pending-settlements/by-source-transaction/:id/settle-company',
    PendingSettlementController,
    'settleCompanyBySourceTransaction',
    ['ADMIN'],
  ],
  ['POST /transactions/admin-income', TransactionsController, 'createAdminIncome', ['ADMIN']],
  ['POST /transactions/expense', TransactionsController, 'createExpense', ['ADMIN']],
  ['POST /transactions/salary', TransactionsController, 'createSalary', ['ADMIN']],
  ['POST /transactions/admin-transfer', TransactionsController, 'createAdminTransfer', ['ADMIN']],
  ['PATCH /transactions/:id/validate', TransactionsController, 'validate', ['ADMIN']],
  ['POST /transactions/:id/confirm-payout', TransactionsController, 'confirmPayout', ['ADMIN']],
  ['GET /transactions/onchain-hash', TransactionsController, 'inspectOnChainHash', ['ADMIN']],
  ['GET /payout-requests/:id', PayoutRequestsController, 'findOne', ['ADMIN', 'SENIOR', 'DROP']],
  [
    'POST /payout-requests/:id/manual-confirm',
    PayoutRequestsController,
    'manualConfirm',
    ['ADMIN'],
  ],
  ['GET /finance/summary', FinanceSummaryController, 'getSummary', ['ADMIN']],
  ['GET /finance/income-compliance', FinanceSummaryController, 'getIncomeCompliance', ['ADMIN']],
  ['GET /finance/salary-month-gap', FinanceSummaryController, 'getSalaryMonthGap', ['ADMIN']],
  ['GET /finance/salary-parts', FinanceSummaryController, 'getSalaryParts', ['ADMIN']],
  ['GET /users/:id/transactions', UsersController, 'getUserTransactions', ['ADMIN']],
]

function contextFor(ctor: Ctor, method: string, role: Role): ExecutionContext {
  const handler = (ctor.prototype as Record<string, unknown>)[method]
  if (typeof handler !== 'function') throw new Error(`${ctor.name}.${method} is not a handler`)
  return {
    getHandler: () => handler,
    getClass: () => ctor,
    switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u-1', role } as SessionUser }) }),
  } as unknown as ExecutionContext
}

function decide(ctor: Ctor, method: string, role: Role): 'allow' | number {
  try {
    return new RolesGuard(new Reflector()).canActivate(contextFor(ctor, method, role)) ? 'allow' : 0
  } catch (e) {
    if (e instanceof HttpException) return e.getStatus()
    throw e
  }
}

describe('AC 2 — touched @Roles endpoints: role × endpoint matrix (real RolesGuard)', () => {
  it('covers 19 endpoints', () => {
    expect(MATRIX).toHaveLength(19)
  })

  describe.each(MATRIX)('%s', (_route, ctor, method, allowed) => {
    // RolesGuard is not an APP_GUARD: the @Roles metadata is inert unless the
    // controller (or the handler) actually mounts it.
    it('mounts RolesGuard', () => {
      const handler = (ctor.prototype as Record<string, unknown>)[method] as object
      const guards: unknown[] = [
        ...((Reflect.getMetadata(GUARDS_METADATA, ctor) as unknown[] | undefined) ?? []),
        ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ?? []),
      ]
      expect(guards).toContain(RolesGuard)
    })

    it.each(ALL)('%s', (role) => {
      expect(decide(ctor, method, role)).toBe(allowed.includes(role) ? 'allow' : 403)
    })
  })
})
