/**
 * Unit tests for TransactionsService.getAccountantSummary (ACCOUNTANT Sprint 1).
 *
 * Coverage:
 *   RBAC (AC2):
 *     - SENIOR / JUNIOR / HR / DROP → ForbiddenException.
 *     - ACCOUNTANT / ADMIN → resolve.
 *   KPI math (AC1):
 *     - pendingValidation counts PENDING SENIOR_INCOME + DROP_INCOME (amount sum).
 *     - non-income PENDING rows (EXPENSE / SALARY) are excluded.
 *     - validatedThisMonth counts VALIDATED rows with validatedAt in current month.
 *     - VALIDATED rows from a previous month are excluded.
 *     - paidThisMonth sums PAID income/payout rows created in the current month.
 *     - recipientCount = distinct income parties (receiverId ?? senderId).
 *
 * Uses a minimal DatabaseService stub returning controlled rows — no Postgres.
 */
import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { TransactionsService } from './transactions.service'

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

type TxStub = {
  id: string
  type: string
  status: string
  amount: string
  senderId: string | null
  receiverId: string | null
  validatedAt: Date | null
  createdAt: Date
}

function makeStub(txs: TxStub[]) {
  const dbStub = {
    db: {
      query: {
        transactions: {
          findMany: () => Promise.resolve(txs),
        },
      },
    },
  }
  return new TransactionsService(dbStub as never, {} as never, {} as never)
}

// Dates anchored relative to "now" so the test is stable across calendar months.
const now = new Date()
const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15))
const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15))

function tx(partial: Partial<TxStub> & Pick<TxStub, 'type' | 'status'>): TxStub {
  return {
    id: `tx-${Math.random().toString(36).slice(2)}`,
    amount: '100',
    senderId: null,
    receiverId: null,
    validatedAt: null,
    createdAt: thisMonth,
    ...partial,
  }
}

describe('getAccountantSummary — RBAC guard (AC2)', () => {
  const forbiddenRoles: SessionUser['role'][] = ['SENIOR', 'JUNIOR', 'HR', 'DROP']

  for (const role of forbiddenRoles) {
    it(`throws ForbiddenException for ${role}`, async () => {
      const svc = makeStub([])
      await expect(svc.getAccountantSummary(user(role))).rejects.toBeInstanceOf(ForbiddenException)
    })
  }

  it('resolves for ACCOUNTANT', async () => {
    const svc = makeStub([])
    await expect(svc.getAccountantSummary(user('ACCOUNTANT'))).resolves.toBeDefined()
  })

  it('resolves for ADMIN', async () => {
    const svc = makeStub([])
    await expect(svc.getAccountantSummary(user('ADMIN'))).resolves.toBeDefined()
  })
})

describe('getAccountantSummary — pendingValidation (AC1)', () => {
  it('counts PENDING SENIOR_INCOME + DROP_INCOME and sums amount', async () => {
    const svc = makeStub([
      tx({ type: 'SENIOR_INCOME', status: 'PENDING', amount: '1000', senderId: 's1' }),
      tx({ type: 'DROP_INCOME', status: 'PENDING', amount: '500', receiverId: 'd1' }),
      // VALIDATED income — not pending.
      tx({ type: 'SENIOR_INCOME', status: 'VALIDATED', amount: '999', senderId: 's2' }),
    ])
    const r = await svc.getAccountantSummary(user('ACCOUNTANT'))
    expect(r.pendingValidation.count).toBe(2)
    expect(r.pendingValidation.amount).toBe(1500)
  })

  it('excludes PENDING EXPENSE / SALARY rows (not validatable income)', async () => {
    const svc = makeStub([
      tx({ type: 'EXPENSE', status: 'PENDING', amount: '350' }),
      tx({ type: 'SALARY', status: 'PENDING', amount: '500' }),
    ])
    const r = await svc.getAccountantSummary(user('ADMIN'))
    expect(r.pendingValidation.count).toBe(0)
    expect(r.pendingValidation.amount).toBe(0)
  })
})

describe('getAccountantSummary — validatedThisMonth (AC1)', () => {
  it('counts VALIDATED rows validated in the current month', async () => {
    const svc = makeStub([
      tx({ type: 'SENIOR_INCOME', status: 'VALIDATED', amount: '1000', validatedAt: thisMonth }),
      tx({ type: 'DROP_INCOME', status: 'VALIDATED', amount: '250', validatedAt: thisMonth }),
    ])
    const r = await svc.getAccountantSummary(user('ACCOUNTANT'))
    expect(r.validatedThisMonth.count).toBe(2)
    expect(r.validatedThisMonth.amount).toBe(1250)
  })

  it('excludes VALIDATED rows validated in a previous month', async () => {
    const svc = makeStub([
      tx({ type: 'SENIOR_INCOME', status: 'VALIDATED', amount: '1000', validatedAt: lastMonth }),
    ])
    const r = await svc.getAccountantSummary(user('ACCOUNTANT'))
    expect(r.validatedThisMonth.count).toBe(0)
    expect(r.validatedThisMonth.amount).toBe(0)
  })

  it('excludes VALIDATED rows with null validatedAt', async () => {
    const svc = makeStub([
      tx({ type: 'SENIOR_INCOME', status: 'VALIDATED', amount: '1000', validatedAt: null }),
    ])
    const r = await svc.getAccountantSummary(user('ACCOUNTANT'))
    expect(r.validatedThisMonth.count).toBe(0)
  })
})

describe('getAccountantSummary — paidThisMonth (AC1)', () => {
  it('sums PAID income/payout rows created this month', async () => {
    const svc = makeStub([
      tx({ type: 'SENIOR_INCOME', status: 'PAID', amount: '2000', createdAt: thisMonth }),
      tx({ type: 'PAYOUT', status: 'PAID', amount: '500', createdAt: thisMonth }),
      // PAID but last month — excluded.
      tx({ type: 'SENIOR_INCOME', status: 'PAID', amount: '9999', createdAt: lastMonth }),
    ])
    const r = await svc.getAccountantSummary(user('ADMIN'))
    expect(r.paidThisMonth.amount).toBe(2500)
  })

  it('returns 0 when nothing was paid this month', async () => {
    const svc = makeStub([
      tx({ type: 'SENIOR_INCOME', status: 'PAID', amount: '5000', createdAt: lastMonth }),
    ])
    const r = await svc.getAccountantSummary(user('ACCOUNTANT'))
    expect(r.paidThisMonth.amount).toBe(0)
  })
})

describe('getAccountantSummary — recipientCount (AC1)', () => {
  it('counts distinct income parties across receiverId/senderId', async () => {
    const svc = makeStub([
      tx({ type: 'DROP_INCOME', status: 'PENDING', receiverId: 'd1' }),
      tx({ type: 'DROP_INCOME', status: 'PAID', receiverId: 'd1' }), // same party
      tx({ type: 'SENIOR_INCOME', status: 'VALIDATED', senderId: 's1' }),
      tx({ type: 'SENIOR_INCOME', status: 'PENDING', senderId: 's2' }),
      // non-income row — must not contribute a party.
      tx({ type: 'EXPENSE', status: 'PAID', senderId: 'admin-x' }),
    ])
    const r = await svc.getAccountantSummary(user('ACCOUNTANT'))
    // d1, s1, s2 → 3 distinct parties.
    expect(r.recipientCount).toBe(3)
  })

  it('returns 0 when no income rows exist', async () => {
    const svc = makeStub([tx({ type: 'EXPENSE', status: 'PAID', senderId: 'x' })])
    const r = await svc.getAccountantSummary(user('ADMIN'))
    expect(r.recipientCount).toBe(0)
  })
})
