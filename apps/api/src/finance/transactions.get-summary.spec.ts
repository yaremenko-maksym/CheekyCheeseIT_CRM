/**
 * Unit tests for TransactionsService.getSummary — RBAC guard + pendingCount fix.
 *
 * Coverage (matches task review findings):
 *
 *  HIGH#1 — RBAC:
 *   1. Non-ADMIN/non-ACCOUNTANT roles (SENIOR, JUNIOR, HR, DROP) → ForbiddenException.
 *   2. ADMIN → resolves (no exception).
 *   3. ACCOUNTANT → resolves (no exception).
 *
 *  HIGH#2 — pendingCount correctness:
 *   4. DROP_INCOME row with {senderId: null, receiverId: drop.id, status: 'PENDING'}
 *      → pendingCount > 0 for that drop.
 *   5. DROP_INCOME row with only {senderId: drop.id} (old bug pattern) and
 *      receiverId pointing elsewhere → pendingCount = 0 (regression guard).
 *   6. PAID DROP_INCOME for the drop → does NOT count toward pendingCount.
 *
 * The service is instantiated with a minimal stub for DatabaseService that
 * returns controlled data — no real Postgres connection required.
 */
import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { TransactionsService } from './transactions.service'

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
  createdAt: Date
  [k: string]: unknown
}

type UserStub = {
  id: string
  role: string
  displayName: string
  dropSharePercent: number | null
}

function makeStub(txs: TxStub[], dropUsers: UserStub[] = [], adminUsers: UserStub[] = []) {
  const dbStub = {
    db: {
      query: {
        transactions: {
          findMany: () =>
            Promise.resolve(
              txs.map((tx) => ({
                ...tx,
                sender: tx.senderId ? { displayName: `sender-${tx.senderId}` } : null,
                receiver: tx.receiverId ? { displayName: `receiver-${tx.receiverId}` } : null,
                project: null,
              })),
            ),
        },
        users: {
          findMany: ({ where }: { where: unknown }) => {
            // Distinguish ADMIN vs DROP queries by examining the where clause.
            // The drizzle eq(users.role, 'ADMIN') / eq(users.role, 'DROP') call
            // produces an object we cannot easily inspect in a unit stub, so we
            // use a simpler trick: capture which call is which by the order they
            // are made (adminUsers first, then dropUsers in the service).
            // We expose a counter to alternate responses.
            const w = where as { value?: string; right?: { value?: string } }
            const roleValue =
              // drizzle eq produces {left, right: {value}} in different versions
              w?.right?.value ?? (w as { value?: string })?.value
            if (roleValue === 'ADMIN') return Promise.resolve(adminUsers)
            if (roleValue === 'DROP') return Promise.resolve(dropUsers)
            // Fallback — return empty (safe default).
            return Promise.resolve([])
          },
        },
      },
    },
  }
  return new TransactionsService(dbStub as never, {} as never)
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const DROP_ID = 'drop-user-1'
const OTHER_ID = 'other-user-2'

function makePendingDropIncome(receiverId: string, senderId: string | null = null): TxStub {
  return {
    id: 'tx-pending-1',
    type: 'DROP_INCOME',
    status: 'PENDING',
    amount: '500',
    senderId,
    receiverId,
    createdAt: new Date('2025-01-15'),
  }
}

function makePaidDropIncome(receiverId: string): TxStub {
  return {
    id: 'tx-paid-1',
    type: 'DROP_INCOME',
    status: 'PAID',
    amount: '500',
    senderId: null,
    receiverId,
    createdAt: new Date('2025-01-15'),
  }
}

const dropUserStub: UserStub = {
  id: DROP_ID,
  role: 'DROP',
  displayName: 'Test Drop',
  dropSharePercent: 7,
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('getSummary — HIGH#1: RBAC guard', () => {
  const roles: SessionUser['role'][] = ['SENIOR', 'JUNIOR', 'HR', 'DROP']

  for (const role of roles) {
    it(`throws ForbiddenException for role ${role}`, async () => {
      const svc = makeStub([])
      await expect(svc.getSummary(user(role))).rejects.toBeInstanceOf(ForbiddenException)
    })
  }

  it('does NOT throw for ADMIN', async () => {
    const svc = makeStub([], [], [])
    await expect(svc.getSummary(user('ADMIN'))).resolves.toBeDefined()
  })

  it('does NOT throw for ACCOUNTANT', async () => {
    const svc = makeStub([], [], [])
    await expect(svc.getSummary(user('ACCOUNTANT'))).resolves.toBeDefined()
  })
})

describe('getSummary — HIGH#2: pendingCount correctness', () => {
  it('counts PENDING DROP_INCOME where receiverId = drop.id (senderId = null)', async () => {
    const tx = makePendingDropIncome(DROP_ID, null)
    const svc = makeStub([tx], [dropUserStub])
    const result = await svc.getSummary(user('ADMIN'))
    const dropEntry = result.dropBalances.find((d) => d.userId === DROP_ID)
    expect(dropEntry).toBeDefined()
    expect(dropEntry!.pendingCount).toBe(1)
  })

  it('also counts VALIDATED DROP_INCOME (awaiting full validation)', async () => {
    const tx: TxStub = {
      ...makePendingDropIncome(DROP_ID, null),
      status: 'VALIDATED',
      id: 'tx-validated-1',
    }
    const svc = makeStub([tx], [dropUserStub])
    const result = await svc.getSummary(user('ADMIN'))
    const dropEntry = result.dropBalances.find((d) => d.userId === DROP_ID)
    expect(dropEntry!.pendingCount).toBe(1)
  })

  it('regression: DROP_INCOME with senderId = drop.id but wrong receiverId → pendingCount = 0', async () => {
    // This reproduces the OLD bug: senderId was checked instead of receiverId.
    // With the fix, only receiverId matters — this row belongs to another user.
    const tx = makePendingDropIncome(OTHER_ID, DROP_ID)
    const svc = makeStub([tx], [dropUserStub])
    const result = await svc.getSummary(user('ADMIN'))
    const dropEntry = result.dropBalances.find((d) => d.userId === DROP_ID)
    // Drop has no matching receiverId rows → pendingCount = 0
    expect(dropEntry!.pendingCount).toBe(0)
  })

  it('PAID DROP_INCOME does NOT increment pendingCount', async () => {
    const tx = makePaidDropIncome(DROP_ID)
    const svc = makeStub([tx], [dropUserStub])
    const result = await svc.getSummary(user('ADMIN'))
    const dropEntry = result.dropBalances.find((d) => d.userId === DROP_ID)
    expect(dropEntry!.pendingCount).toBe(0)
  })
})
