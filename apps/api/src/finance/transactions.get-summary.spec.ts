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
  createdAt: Date
  [k: string]: unknown
}

type UserStub = {
  id: string
  role: string
  displayName: string
  dropSharePercent: number | null
}

function makeStub(
  txs: TxStub[],
  dropUsers: UserStub[] = [],
  adminUsers: UserStub[] = [],
  // task-drop-share-override-and-receiver (C4): ids of SENIOR_INCOME rows that
  // are settlements (they close a pending_obligation) and must be excluded from
  // income. getSummary reads these via db.select({id}).from(pendingObligations).
  closingTxIds: string[] = [],
) {
  // getSummary calls users.findMany twice, in this order:
  //   1st call: eq(users.role, 'ADMIN')  → adminUsers
  //   2nd call: eq(users.role, 'DROP')   → dropUsers
  // We use a call counter to return the correct dataset per invocation
  // instead of trying to inspect the opaque drizzle predicate object.
  let callCount = 0
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
          findMany: (_args: unknown) => {
            callCount += 1
            if (callCount === 1) return Promise.resolve(adminUsers) // ADMIN query
            return Promise.resolve(dropUsers) // DROP query
          },
        },
      },
      // C4 closing-transaction lookup: db.select({id}).from(pendingObligations)
      //   .where(isNotNull(closingTransactionId)) → [{ id }].
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(closingTxIds.map((id) => ({ id }))),
        }),
      }),
    },
  }
  return makeTransactionsService({ db: dbStub as never })
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

// ── Rich fixture helpers for the income / currency / txDate fixes ──────────────
// A fuller transaction shape — getSummary reads currency / fundingSource / txDate
// / receiverId / senderId. Defaults model a clean USD, today-dated, PAID row.
function tx(overrides: Partial<TxStub> & { type: string }): TxStub {
  return {
    id: `tx-${Math.random().toString(36).slice(2)}`,
    status: 'PAID',
    amount: '0',
    senderId: null,
    receiverId: null,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    currency: 'USD',
    fundingSource: null,
    txDate: null,
    recipientId: null,
    ...overrides,
  }
}

function adminUser(id: string, displayName: string): UserStub {
  return { id, role: 'ADMIN', displayName, dropSharePercent: null }
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

// task-accountant-sees-admin-balances (2026-08-17, owner decision): #214/#215
// zeroed `adminBalances` for ACCOUNTANT; that zeroing is REVERSED (SEC-3 on
// #551 made the contradiction with `assertCanReadAdminBalance` live — see the
// comment above `canSeeAdminBalances` in transactions.service.ts). This
// block pins the reversal AND proves `dropBalances` is untouched — that half
// of #214/#215 stands. MUST FAIL RED if `adminBalances: []` is restored for
// ACCOUNTANT (verified manually against the pre-fix code — see PR body).
describe('getSummary — task-accountant-sees-admin-balances: adminBalances reversal', () => {
  const ADMIN_ID = 'admin-x'

  function ledgerWithOneAdminBalance() {
    return [tx({ type: 'PAYOUT_ADMIN', amount: '500', receiverId: ADMIN_ID })]
  }

  it('ACCOUNTANT: adminBalances is NON-EMPTY and carries the real balance (literal assert)', async () => {
    const svc = makeStub(ledgerWithOneAdminBalance(), [], [adminUser(ADMIN_ID, 'Admin X')])
    const result = await svc.getSummary(user('ACCOUNTANT'))
    expect(result.adminBalances).toHaveLength(1)
    expect(result.adminBalances[0]).toEqual({
      userId: ADMIN_ID,
      displayName: 'Admin X',
      balance: 500,
    })
  })

  it('ACCOUNTANT and ADMIN see the SAME adminBalances for the same ledger (two screens no longer disagree)', async () => {
    const svcAccountant = makeStub(
      ledgerWithOneAdminBalance(),
      [],
      [adminUser(ADMIN_ID, 'Admin X')],
    )
    const svcAdmin = makeStub(ledgerWithOneAdminBalance(), [], [adminUser(ADMIN_ID, 'Admin X')])
    const [accountantResult, adminResult] = await Promise.all([
      svcAccountant.getSummary(user('ACCOUNTANT')),
      svcAdmin.getSummary(user('ADMIN')),
    ])
    expect(accountantResult.adminBalances).toEqual(adminResult.adminBalances)
  })

  it('ACCOUNTANT: dropBalances is STILL EMPTY — #214/#215 unchanged for drops', async () => {
    const svc = makeStub([makePaidDropIncome(DROP_ID)], [dropUserStub], [])
    const result = await svc.getSummary(user('ACCOUNTANT'))
    expect(result.dropBalances).toEqual([])
  })

  it('ADMIN: dropBalances is still NON-EMPTY (no regression on the untouched half)', async () => {
    const svc = makeStub([makePaidDropIncome(DROP_ID)], [dropUserStub], [])
    const result = await svc.getSummary(user('ADMIN'))
    expect(result.dropBalances.length).toBeGreaterThan(0)
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

// ── C4 (task-drop-share-override-and-receiver): settlement SENIOR_INCOME excluded ──
// The discriminator is now "is this SENIOR_INCOME a closing transaction of an
// obligation" (regardless of funding), replacing the old funding-only check —
// so ADMIN_PERSONAL settlements (funding=null) are excluded too.
describe('getSummary — C4: settlement SENIOR_INCOME not double-counted', () => {
  it('PAID DROP_INCOME gross + settlement SENIOR_INCOME slice → totalIncome counts the gross once', async () => {
    const svc = makeStub(
      [
        tx({ type: 'DROP_INCOME', amount: '1000', receiverId: DROP_ID }),
        // Company→senior settlement of the drop IOU — already represented by the gross.
        tx({
          id: 'settle-senior-1',
          type: 'SENIOR_INCOME',
          amount: '260',
          fundingSource: 'COMPANY_ACCOUNT',
          receiverId: 'sr',
        }),
      ],
      [],
      [],
      ['settle-senior-1'],
    )
    const result = await svc.getSummary(user('ADMIN'))
    // 1000 gross only — the 260 settlement slice is excluded.
    expect(result.totalIncome).toBeCloseTo(1000, 6)
  })

  it('ADMIN_PERSONAL settlement SENIOR_INCOME (funding=null) is ALSO excluded (C4 fix)', async () => {
    const svc = makeStub(
      [
        tx({ type: 'ADMIN_INCOME', amount: '1000', receiverId: 'admin-x' }),
        // Admin-personal settlement of the senior IOU — funding=null, but it is a
        // closing transaction so it must NOT be double-counted.
        tx({
          id: 'settle-senior-2',
          type: 'SENIOR_INCOME',
          amount: '260',
          fundingSource: null,
          receiverId: 'sr',
        }),
      ],
      [],
      [],
      ['settle-senior-2'],
    )
    const result = await svc.getSummary(user('ADMIN'))
    expect(result.totalIncome).toBeCloseTo(1000, 6)
  })

  it('NON-settlement SENIOR_INCOME is still counted', async () => {
    const svc = makeStub([
      tx({ type: 'SENIOR_INCOME', amount: '740', fundingSource: null, receiverId: 'sr' }),
    ])
    const result = await svc.getSummary(user('ADMIN'))
    expect(result.totalIncome).toBeCloseTo(740, 6)
  })

  it('monthly income series also excludes settlement SENIOR_INCOME', async () => {
    const svc = makeStub(
      [
        tx({ type: 'DROP_INCOME', amount: '1000', receiverId: DROP_ID }),
        tx({
          id: 'settle-senior-3',
          type: 'SENIOR_INCOME',
          amount: '260',
          fundingSource: 'COMPANY_ACCOUNT',
          receiverId: 'sr',
        }),
      ],
      [],
      [],
      ['settle-senior-3'],
    )
    const result = await svc.getSummary(user('ADMIN'))
    const month = result.monthly.find((m) => m.month === '2026-06')
    expect(month!.income).toBeCloseTo(1000, 6)
  })
})

// ── Audit 2026-06-28 (#9): monthly buckets keyed by txDate, not createdAt ─────
describe('getSummary — #9: monthly buckets by txDate', () => {
  it('a back-dated row (txDate month ≠ createdAt month) lands in the txDate month', async () => {
    const svc = makeStub([
      tx({
        type: 'ADMIN_INCOME',
        amount: '500',
        createdAt: new Date('2026-06-15T00:00:00Z'),
        txDate: new Date('2026-03-10T00:00:00Z'),
        receiverId: 'admin-x',
      }),
    ])
    const result = await svc.getSummary(user('ADMIN'))
    expect(result.monthly.find((m) => m.month === '2026-03')?.income).toBeCloseTo(500, 6)
    expect(result.monthly.find((m) => m.month === '2026-06')).toBeUndefined()
  })

  it('falls back to createdAt when txDate is null', async () => {
    const svc = makeStub([
      tx({
        type: 'ADMIN_INCOME',
        amount: '500',
        createdAt: new Date('2026-06-15T00:00:00Z'),
        txDate: null,
        receiverId: 'admin-x',
      }),
    ])
    const result = await svc.getSummary(user('ADMIN'))
    expect(result.monthly.find((m) => m.month === '2026-06')?.income).toBeCloseTo(500, 6)
  })
})

// ── Audit 2026-06-28 (#4): mixed-currency conversion + REGRESSION GATE ─────────
describe('getSummary — #4: currency conversion + USDT/USD regression gate', () => {
  const MAKSYM = 'admin-maksym'
  const KOSTYA = 'admin-kostya'

  // HARD REGRESSION GATE: a USDT/USD-only ledger MUST yield byte-exact partner
  // balances. We build a fixture whose HOLDING model (received − ALL sent) gives
  // Максим 78238.34 and Константин 93205.82 (DEBT = |Δ|/2 = 7483.74), mixing USD
  // and USDT rows, and assert the numbers are EXACT — the conversion (#4) must be
  // a no-op for the peg pair.
  function regressionLedger(): TxStub[] {
    return [
      // Максим received 78238.34 across a USD + a USDT row, sent nothing.
      tx({ type: 'PAYOUT_ADMIN', amount: '40000.00', currency: 'USD', receiverId: MAKSYM }),
      tx({ type: 'ADMIN_INCOME', amount: '38238.34', currency: 'USDT', receiverId: MAKSYM }),
      // Константин received 93205.82 (USDT) and sent nothing.
      tx({ type: 'PAYOUT_ADMIN', amount: '93205.82', currency: 'USDT', receiverId: KOSTYA }),
    ]
  }

  it('USDT/USD-only fixture → partner balances are BYTE-EXACT (regression gate)', async () => {
    const svc = makeStub(
      regressionLedger(),
      [],
      [adminUser(MAKSYM, 'Максим'), adminUser(KOSTYA, 'Константин')],
    )
    const result = await svc.getSummary(user('ADMIN'))
    const m = result.adminBalances.find((b) => b.userId === MAKSYM)!
    const k = result.adminBalances.find((b) => b.userId === KOSTYA)!
    // EXACT equality on the partner balances — not toBeCloseTo. Any sub-cent
    // drift from #4 fails here. (The DEBT = |Δ|/2 is a plain JS subtraction of two
    // exact balances done in the UI, so it carries the usual IEEE-754 tail — we
    // assert it to the cent rather than byte-exact.)
    expect(m.balance).toBe(78238.34)
    expect(k.balance).toBe(93205.82)
    expect(Math.abs(m.balance - k.balance) / 2).toBeCloseTo(7483.74, 6)
  })

  it('USDT/USD balances stay byte-exact regardless of the NBU rate (peg short-circuit)', async () => {
    // A wildly different rate must NOT shift USD/USDT totals — they are pegged.
    const oddRates = {
      getRates: () =>
        Promise.resolve({
          usdUah: '37.1234',
          usdtUah: '37.1234',
          eurUah: '50.9',
          date: '2026-06-28',
        }),
    }
    const svc = makeStub(
      regressionLedger(),
      [],
      [adminUser(MAKSYM, 'Максим'), adminUser(KOSTYA, 'Константин')],
    )
    // Swap in the odd-rate NBU stub.
    ;(svc as unknown as { nbuCurrency: typeof oddRates }).nbuCurrency = oddRates
    const result = await svc.getSummary(user('ADMIN'))
    expect(result.adminBalances.find((b) => b.userId === MAKSYM)!.balance).toBe(78238.34)
    expect(result.adminBalances.find((b) => b.userId === KOSTYA)!.balance).toBe(93205.82)
  })

  it('a UAH income row is converted to USD by the NBU rate', async () => {
    // Default stub rate: usdUah = 41.50. 4150 UAH / 41.50 = 100 USD.
    const svc = makeStub([
      tx({ type: 'ADMIN_INCOME', amount: '4150', currency: 'UAH', receiverId: 'a' }),
    ])
    const result = await svc.getSummary(user('ADMIN'))
    expect(result.totalIncome).toBeCloseTo(100, 4)
  })

  it('drop balance is mixed-currency safe (USDT slices summed in base)', async () => {
    const svc = makeStub(
      [
        tx({ type: 'PAYOUT_DROP', amount: '50', currency: 'USDT', receiverId: DROP_ID }),
        tx({ type: 'PAYOUT_DROP', amount: '30', currency: 'USD', receiverId: DROP_ID }),
      ],
      [dropUserStub],
    )
    const result = await svc.getSummary(user('ADMIN'))
    expect(result.dropBalances.find((d) => d.userId === DROP_ID)!.balance).toBeCloseTo(80, 6)
  })
})
