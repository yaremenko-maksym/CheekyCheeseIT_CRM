/**
 * Unit tests for SummaryService (decomposition stage T-L8) — the seam is the
 * provider's own public API, constructed directly over a DatabaseService stub.
 *
 * What is pinned here (DB-independent, fast):
 *   - RBAC gate per method: every role the gate must refuse is refused with the
 *     method's own 403 code BEFORE any DB access (the throwing stub proves it);
 *     every role it must admit resolves.
 *   - The empty-aggregate mapping of getAccountantSummary.
 *   - The `TransactionsService` thin delegates forward the caller verbatim to
 *     SummaryService and return its result (controllers / admin.controller call
 *     the delegates, so a delegate that dropped the caller or the month would
 *     silently change what a role sees).
 *   - The extracted CRON_ELIGIBLE_SALARY_ROLES constant keeps its exact
 *     membership and is still the one TransactionsService re-exports.
 *
 * The figure-level math of each summary stays covered through the delegates by
 * the existing accountant-summary*, senior-summary*, income-compliance* and
 * transactions.get-summary specs (real SummaryService wired by the harness).
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { CRON_ELIGIBLE_SALARY_ROLES } from './salary-roles.const'
import { CRON_ELIGIBLE_SALARY_ROLES as REEXPORTED } from './transactions.service'
import { SummaryService } from './summary.service'
import type { NbuCurrencyService } from './nbu-currency.service'

function user(role: SessionUser['role'], id = `${role.toLowerCase()}-1`): SessionUser {
  return {
    id,
    role,
    displayName: `Test ${role}`,
    email: `${id}@test.com`,
    avatarUrl: null,
    avatarDocumentId: null,
    seniorSharePercent: 26,
  }
}

const ALL_ROLES: SessionUser['role'][] = ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP']

/** A DB whose every access throws — proves the RBAC gate fires first. */
function makeThrowingService(): SummaryService {
  const boom = () => {
    throw new Error('DB must not be queried for forbidden roles')
  }
  const db = { db: { select: boom, query: new Proxy({}, { get: boom }) } }
  return new SummaryService(db as never, {} as NbuCurrencyService)
}

function rolesExcept(allowed: SessionUser['role'][]): SessionUser['role'][] {
  return ALL_ROLES.filter((r) => !allowed.includes(r))
}

describe('SummaryService — RBAC gate per method (before any DB access)', () => {
  const gates: {
    method:
      'getSummary' | 'getAccountantSummary' | 'getSeniorSummary' | 'getIncomeComplianceOverview'
    allowed: SessionUser['role'][]
    code: string
  }[] = [
    { method: 'getSummary', allowed: ['ADMIN', 'ACCOUNTANT'], code: 'FINANCE_SUMMARY_FORBIDDEN' },
    {
      method: 'getAccountantSummary',
      allowed: ['ADMIN', 'ACCOUNTANT'],
      code: 'FINANCE_ACCOUNTANT_SUMMARY_FORBIDDEN',
    },
    {
      method: 'getSeniorSummary',
      allowed: ['ADMIN', 'SENIOR'],
      code: 'FINANCE_SENIOR_SUMMARY_FORBIDDEN',
    },
    {
      method: 'getIncomeComplianceOverview',
      allowed: ['ADMIN', 'ACCOUNTANT'],
      code: 'FINANCE_INCOME_COMPLIANCE_FORBIDDEN',
    },
  ]

  for (const { method, allowed, code } of gates) {
    for (const role of rolesExcept(allowed)) {
      it(`${method} refuses ${role} with ${code} (403)`, async () => {
        const svc = makeThrowingService()
        await expect(svc[method](user(role))).rejects.toMatchObject({
          response: { code, statusCode: 403 },
        })
      })
    }
  }

  it('getAccountantSummary admits ADMIN and ACCOUNTANT (empty aggregate -> zero KPI shape)', async () => {
    const db = {
      db: {
        select: () => ({
          from: () => ({
            where: () =>
              Promise.resolve([
                {
                  pendingCount: 0,
                  pendingAmount: 0,
                  validatedCount: 0,
                  validatedAmount: 0,
                  paidAmount: 0,
                  recipientCount: 0,
                },
              ]),
          }),
        }),
      },
    }
    const svc = new SummaryService(db as never, {} as NbuCurrencyService)
    for (const role of ['ADMIN', 'ACCOUNTANT'] as const) {
      await expect(svc.getAccountantSummary(user(role))).resolves.toEqual({
        pendingValidation: { count: 0, amount: 0 },
        validatedThisMonth: { count: 0, amount: 0 },
        paidThisMonth: { amount: 0 },
        recipientCount: 0,
      })
    }
  })

  it('getSeniorSummary admits SENIOR and ADMIN', async () => {
    const db = {
      db: {
        query: {
          users: { findFirst: () => Promise.resolve({ seniorSharePercent: 26 }) },
          transactions: { findMany: () => Promise.resolve([]) },
          payoutRequests: { findMany: () => Promise.resolve([]) },
          teamMembers: { findMany: () => Promise.resolve([]) },
        },
        select: () => ({
          from: () => ({
            where: () => Object.assign(Promise.resolve([]), { orderBy: () => Promise.resolve([]) }),
          }),
        }),
      },
    }
    const svc = new SummaryService(db as never, {} as NbuCurrencyService)
    for (const role of ['SENIOR', 'ADMIN'] as const) {
      await expect(svc.getSeniorSummary(user(role))).resolves.toBeDefined()
    }
  })
})

describe('TransactionsService summary delegates forward verbatim to SummaryService', () => {
  function build() {
    const summaryService = {
      getSummary: vi.fn().mockResolvedValue('summary'),
      getAccountantSummary: vi.fn().mockResolvedValue('accountant'),
      getSeniorSummary: vi.fn().mockResolvedValue('senior'),
      getIncomeComplianceOverview: vi.fn().mockResolvedValue('compliance'),
    }
    const svc = makeTransactionsService({
      db: {} as never,
      summaryService: summaryService as never,
    })
    return { svc, summaryService }
  }

  it('getSummary', async () => {
    const { svc, summaryService } = build()
    const u = user('ADMIN')
    await expect(svc.getSummary(u)).resolves.toBe('summary')
    expect(summaryService.getSummary).toHaveBeenCalledWith(u)
  })

  it('getAccountantSummary', async () => {
    const { svc, summaryService } = build()
    const u = user('ACCOUNTANT')
    await expect(svc.getAccountantSummary(u)).resolves.toBe('accountant')
    expect(summaryService.getAccountantSummary).toHaveBeenCalledWith(u)
  })

  it('getSeniorSummary', async () => {
    const { svc, summaryService } = build()
    const u = user('SENIOR')
    await expect(svc.getSeniorSummary(u)).resolves.toBe('senior')
    expect(summaryService.getSeniorSummary).toHaveBeenCalledWith(u)
  })

  it('getIncomeComplianceOverview forwards caller AND month', async () => {
    const { svc, summaryService } = build()
    const u = user('ADMIN')
    await expect(svc.getIncomeComplianceOverview(u, '2026-03')).resolves.toBe('compliance')
    expect(summaryService.getIncomeComplianceOverview).toHaveBeenCalledWith(u, '2026-03')
  })
})

describe('CRON_ELIGIBLE_SALARY_ROLES (extracted to salary-roles.const.ts)', () => {
  it('keeps its exact membership', () => {
    expect([...CRON_ELIGIBLE_SALARY_ROLES].sort()).toEqual(['ACCOUNTANT', 'HR', 'JUNIOR'])
  })

  it('is the same set TransactionsService re-exports for existing importers', () => {
    expect(REEXPORTED).toBe(CRON_ELIGIBLE_SALARY_ROLES)
  })
})
