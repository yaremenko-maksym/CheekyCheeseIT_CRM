/**
 * Unit tests for TransactionsService.getDropSelfSummary — the self-only DROP
 * summary behind `GET /api/finance/drop/me/summary` (task-drop-1-backend AC4).
 *
 * Coverage:
 *
 *  RBAC (self-only):
 *   1. Every non-DROP role (SENIOR / JUNIOR / HR / ACCOUNTANT / ADMIN) → 403.
 *   2. DROP → resolves with the four-field DTO.
 *   3. DROP whose user row is missing → 404 (defensive).
 *
 *  debtToCompany formula (the load-bearing money math). The debt is the sum of
 *  the placeholder PAYOUT rows booked at DROP_INCOME validation that the
 *  company-payment step has NOT yet flipped to PAID — i.e. PAYOUT rows with
 *  `senderId = drop.id` AND `status = 'PENDING_PAYMENT'` (verified against
 *  transactions.service `validateTransaction` + payment-channel `closePayout`):
 *   4. No incomes at all → debtToCompany = 0.
 *   5. One validated-unsettled income (PAYOUT PENDING_PAYMENT) → debt = its amount.
 *   6. Partially paid: one PENDING_PAYMENT + one already-PAID PAYOUT → debt counts
 *      only the PENDING_PAYMENT one.
 *   7. Fully paid: PAYOUT PAID only → debt = 0.
 *   8. Isolation: another drop's PENDING_PAYMENT PAYOUT must NOT leak into this
 *      drop's debt (the helper filters on senderId).
 *   9. balance + pendingIncomesCount mirror the admin dropBalances semantics
 *      (PAYOUT_DROP received − sent; DROP_INCOME PENDING|VALIDATED count).
 *
 * Pure stub for DatabaseService — no Postgres. The integration spec
 * (drop.rbac.integration.spec.ts) pins the same behaviour against a real DB.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'

// ── Session user factory ────────────────────────────────────────────────────

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

// ── DB stub builder ─────────────────────────────────────────────────────────

type TxStub = {
  id: string
  type: string
  status: string
  amount: string
  senderId: string | null
  receiverId: string | null
}

type UserRow = {
  id: string
  displayName: string
  dropSharePercent: number | null
}

/**
 * Build a TransactionsService whose DatabaseService returns:
 *  - users.findFirst → the supplied self row (or undefined to simulate 404)
 *  - transactions.findMany → the supplied ledger
 */
function makeSvc(self: UserRow | undefined, txs: TxStub[]) {
  const dbStub = {
    db: {
      query: {
        users: {
          findFirst: () => Promise.resolve(self),
        },
        transactions: {
          findMany: () => Promise.resolve(txs),
        },
      },
    },
  }
  return makeTransactionsService({ db: dbStub as never })
}

const DROP_ID = 'drop-A'
const OTHER_DROP_ID = 'drop-B'

const selfRow: UserRow = { id: DROP_ID, displayName: 'Drop A', dropSharePercent: 5 }

// Booked at DROP_INCOME validation: type=PAYOUT, senderId=drop, amount = payable.
function payout(
  senderId: string,
  status: string,
  amount: string,
  id = `payout-${amount}-${status}`,
): TxStub {
  return { id, type: 'PAYOUT', status, amount, senderId, receiverId: null }
}

// ── RBAC ─────────────────────────────────────────────────────────────────────

describe('getDropSelfSummary — RBAC (self-only)', () => {
  const forbiddenRoles: SessionUser['role'][] = ['SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'ADMIN']

  for (const role of forbiddenRoles) {
    it(`throws ForbiddenException for role ${role}`, async () => {
      const svc = makeSvc(selfRow, [])
      await expect(svc.getDropSelfSummary(user(role))).rejects.toBeInstanceOf(ForbiddenException)
    })
  }

  it('resolves the four-field DTO for DROP', async () => {
    const svc = makeSvc(selfRow, [])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res).toEqual({
      balance: 0,
      dropSharePercent: 5,
      pendingIncomesCount: 0,
      debtToCompany: 0,
    })
  })

  it('throws NotFoundException when the drop user row is missing', async () => {
    const svc = makeSvc(undefined, [])
    await expect(svc.getDropSelfSummary(user('DROP', DROP_ID))).rejects.toBeInstanceOf(
      NotFoundException,
    )
  })
})

// ── debtToCompany formula ─────────────────────────────────────────────────────

describe('getDropSelfSummary — debtToCompany formula', () => {
  it('no incomes → debtToCompany = 0', async () => {
    const svc = makeSvc(selfRow, [])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.debtToCompany).toBe(0)
  })

  it('one validated-unsettled income → debt = booked payable', async () => {
    // income 1000, share 5% → drop keeps 50, owes company 950 (PAYOUT placeholder).
    const svc = makeSvc(selfRow, [payout(DROP_ID, 'PENDING_PAYMENT', '950')])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.debtToCompany).toBe(950)
  })

  it('partially paid → only PENDING_PAYMENT payouts count', async () => {
    const svc = makeSvc(selfRow, [
      payout(DROP_ID, 'PENDING_PAYMENT', '950', 'p-open'),
      payout(DROP_ID, 'PAID', '475', 'p-paid'),
    ])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.debtToCompany).toBe(950)
  })

  it('fully paid → debtToCompany = 0', async () => {
    const svc = makeSvc(selfRow, [payout(DROP_ID, 'PAID', '950')])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.debtToCompany).toBe(0)
  })

  it('sums multiple PENDING_PAYMENT payouts (float-safe)', async () => {
    // 0.1 + 0.2 must not produce 0.30000000000000004 — scaled-integer guard.
    const svc = makeSvc(selfRow, [
      payout(DROP_ID, 'PENDING_PAYMENT', '0.1', 'p1'),
      payout(DROP_ID, 'PENDING_PAYMENT', '0.2', 'p2'),
    ])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.debtToCompany).toBe(0.3)
  })

  it("ignores another drop's PENDING_PAYMENT payout (no cross-drop leak)", async () => {
    const svc = makeSvc(selfRow, [
      payout(DROP_ID, 'PENDING_PAYMENT', '100', 'mine'),
      payout(OTHER_DROP_ID, 'PENDING_PAYMENT', '999', 'theirs'),
    ])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.debtToCompany).toBe(100)
  })
})

// ── balance + pendingIncomesCount mirror admin dropBalances ──────────────────

describe('getDropSelfSummary — balance & pendingIncomesCount', () => {
  it('balance = Σ PAYOUT_DROP received − sent (PAID only)', async () => {
    const txs: TxStub[] = [
      {
        id: 'r1',
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: '50',
        senderId: null,
        receiverId: DROP_ID,
      },
      {
        id: 'r2',
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: '30',
        senderId: null,
        receiverId: DROP_ID,
      },
      {
        id: 's1',
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: '20',
        senderId: DROP_ID,
        receiverId: null,
      },
      // PENDING PAYOUT_DROP must NOT count toward balance.
      {
        id: 'r3',
        type: 'PAYOUT_DROP',
        status: 'PENDING',
        amount: '999',
        senderId: null,
        receiverId: DROP_ID,
      },
    ]
    const svc = makeSvc(selfRow, txs)
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.balance).toBe(60) // 50 + 30 − 20
  })

  it('pendingIncomesCount = DROP_INCOME rows (PENDING|VALIDATED) for this drop', async () => {
    const txs: TxStub[] = [
      {
        id: 'i1',
        type: 'DROP_INCOME',
        status: 'PENDING',
        amount: '500',
        senderId: null,
        receiverId: DROP_ID,
      },
      {
        id: 'i2',
        type: 'DROP_INCOME',
        status: 'VALIDATED',
        amount: '500',
        senderId: null,
        receiverId: DROP_ID,
      },
      // PAID income → not pending.
      {
        id: 'i3',
        type: 'DROP_INCOME',
        status: 'PAID',
        amount: '500',
        senderId: null,
        receiverId: DROP_ID,
      },
      // Another drop's income → must not count.
      {
        id: 'i4',
        type: 'DROP_INCOME',
        status: 'PENDING',
        amount: '500',
        senderId: null,
        receiverId: OTHER_DROP_ID,
      },
    ]
    const svc = makeSvc(selfRow, txs)
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.pendingIncomesCount).toBe(2)
  })

  it('dropSharePercent falls back to default 5 when NULL', async () => {
    const svc = makeSvc({ id: DROP_ID, displayName: 'Drop A', dropSharePercent: null }, [])
    const res = await svc.getDropSelfSummary(user('DROP', DROP_ID))
    expect(res.dropSharePercent).toBe(5)
  })
})
