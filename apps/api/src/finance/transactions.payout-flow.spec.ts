/**
 * Unit tests for feat/finance-payout-flow (#7):
 *
 *   1. validateTransaction(SENIOR_INCOME, 'validate') — ONLY flips status to
 *      VALIDATED, does NOT create a payout_request or PAYOUT row.
 *
 *   2. validateTransaction(DROP_INCOME, 'validate') — retains the original
 *      behaviour: flip + create payout_request + PAYOUT(PENDING_PAYMENT).
 *
 *   3. createPayoutRequest — single call creates exactly one payout_request
 *      and one PAYOUT row; aggregate payable is sum of per-tx payables.
 *
 *   4. createPayoutRequest — duplicate guard: if a transaction already has a
 *      payoutRequestId the isNull() filter excludes it, so
 *      txs.length !== transactionIds.length → BadRequestException.
 *
 *   5. createPayoutRequest — multi-tx aggregation with different sharePercent
 *      per tx: payableAmount = Σ (amount_i × (1 - share_i/100)).
 *
 * DB calls are stubbed with vitest vi.fn() — no real Postgres connection.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { TransactionsService } from './transactions.service'

// ── Helpers ────────────────────────────────────────────────────────────────

const SENIOR_USER: SessionUser = {
  id: 'senior-1',
  role: 'SENIOR',
  displayName: 'Senior',
  email: 's@test.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

const ACCOUNTANT_USER: SessionUser = {
  id: 'acc-1',
  role: 'ACCOUNTANT',
  displayName: 'Accountant',
  email: 'acc@test.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

const DROP_USER: SessionUser = {
  id: 'drop-1',
  role: 'DROP',
  displayName: 'Drop',
  email: 'd@test.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

function makeTx(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    type: 'SENIOR_INCOME' as const,
    status: 'PENDING' as const,
    amount: '1000',
    currency: 'USDT' as const,
    receiverId: 'senior-1',
    projectId: 'proj-1',
    payoutRequestId: null,
    seniorSharePercent: 26,
    createdBy: 'senior-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makePayoutRequestRow(id = 'pr-1') {
  return {
    id,
    seniorId: 'senior-1',
    incomeAmount: '1000',
    payableAmount: '740',
    contractAddress: '0xdeadbeef',
    status: 'PENDING' as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

// Build a TransactionsService with fully-stubbed DB. The `db` object mirrors
// the shape that the service actually calls; all calls beyond what a given
// test exercises fall through to vi.fn() which returns undefined by default.
function makeService(dbOverrides: Record<string, unknown> = {}) {
  // Base stub — most tests only exercise a subset of these.
  const dbStub = {
    db: {
      query: {
        transactions: { findFirst: vi.fn(), findMany: vi.fn() },
        users: { findFirst: vi.fn() },
        payoutRequests: { findFirst: vi.fn() },
        projects: { findFirst: vi.fn() },
        teamMembers: { findMany: vi.fn().mockResolvedValue([]) },
      },
      transaction: vi.fn(),
      update: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      values: vi.fn().mockResolvedValue([makePayoutRequestRow()]),
      where: vi.fn().mockResolvedValue([]),
      returning: vi.fn().mockResolvedValue([makePayoutRequestRow()]),
      ...dbOverrides,
    },
  } as never

  const invoicesStub = {
    autoCreateForPayout: vi.fn().mockResolvedValue(undefined),
    autoCreateForIncome: vi.fn().mockResolvedValue(undefined),
  } as never

  const documentsStub = {
    findOne: vi.fn(),
  } as never

  return new TransactionsService(dbStub, invoicesStub, documentsStub)
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('validateTransaction — SENIOR_INCOME (#7)', () => {
  it('flips SENIOR_INCOME to VALIDATED without creating payout_request or PAYOUT', async () => {
    // Arrange: a PENDING SENIOR_INCOME tx
    const tx = makeTx({ status: 'PENDING', type: 'SENIOR_INCOME' })

    const dbInsertMock = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) })
    const dbUpdateMock = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    })

    // findFirst returns the tx for the initial lookup, then the updated tx for findOne
    const updatedTx = { ...tx, status: 'VALIDATED', payoutRequestId: null }
    const findFirstMock = vi
      .fn()
      .mockResolvedValueOnce(tx) // initial fetch
      .mockResolvedValue(updatedTx) // subsequent reads (findOne)

    const db = {
      db: {
        query: {
          transactions: { findFirst: findFirstMock, findMany: vi.fn().mockResolvedValue([]) },
          users: { findFirst: vi.fn().mockResolvedValue({ id: 'senior-1' }) },
          teamMembers: { findMany: vi.fn().mockResolvedValue([]) },
          projects: { findFirst: vi.fn().mockResolvedValue({ id: 'proj-1', name: 'P' }) },
          projectMembers: { findFirst: vi.fn().mockResolvedValue(null) },
          juniorPayments: { findFirst: vi.fn().mockResolvedValue(null) },
        },
        insert: dbInsertMock,
        update: dbUpdateMock,
      },
    } as never

    const invoicesStub = {
      autoCreateForPayout: vi.fn(),
      autoCreateForIncome: vi.fn(),
    } as never
    const documentsStub = { findOne: vi.fn() } as never

    const svc = new TransactionsService(db, invoicesStub, documentsStub)

    // Act
    await svc.validateTransaction('tx-1', 'validate', null, ACCOUNTANT_USER)

    // Assert: insert was NOT called (no payout_request, no PAYOUT row created)
    expect(dbInsertMock).not.toHaveBeenCalled()

    // Assert: update was called exactly once (flip to VALIDATED)
    expect(dbUpdateMock).toHaveBeenCalledTimes(1)
  })

  it('rejects non-PENDING SENIOR_INCOME with BadRequestException (idempotency)', async () => {
    const tx = makeTx({ status: 'VALIDATED', type: 'SENIOR_INCOME' })

    const db = {
      db: {
        query: {
          transactions: { findFirst: vi.fn().mockResolvedValue(tx) },
        },
      },
    } as never
    const invoicesStub = {} as never
    const documentsStub = {} as never

    const svc = new TransactionsService(db, invoicesStub, documentsStub)

    await expect(
      svc.validateTransaction('tx-1', 'validate', null, ACCOUNTANT_USER),
    ).rejects.toThrow(BadRequestException)
  })

  it('rejects non-ADMIN/ACCOUNTANT actors with ForbiddenException', async () => {
    const db = { db: { query: { transactions: { findFirst: vi.fn() } } } } as never
    const svc = new TransactionsService(db, {} as never, {} as never)

    await expect(svc.validateTransaction('tx-1', 'validate', null, SENIOR_USER)).rejects.toThrow(
      ForbiddenException,
    )
  })
})

describe('validateTransaction — DROP_INCOME still creates payout_request (#7 regression)', () => {
  it('DROP_INCOME validate creates payout_request + PAYOUT atomically', async () => {
    const dropTx = makeTx({
      id: 'dtx-1',
      type: 'DROP_INCOME',
      status: 'PENDING',
      receiverId: 'drop-1',
    })

    const insertReturningMock = vi.fn().mockResolvedValue([makePayoutRequestRow('pr-drop-1')])
    const insertValuesMock = vi.fn().mockReturnValue({ returning: insertReturningMock })
    const insertIntoMock = vi.fn().mockReturnValue({ values: insertValuesMock })

    // Simulated PAYOUT insert (no returning needed)
    const insertPayoutMock = vi.fn().mockResolvedValue([])

    // insert is called twice: payoutRequests, then transactions (PAYOUT)
    let insertCallCount = 0
    const insertDispatch = vi.fn().mockImplementation(() => {
      insertCallCount++
      if (insertCallCount === 1) return { values: insertValuesMock }
      return { values: vi.fn().mockResolvedValue([]) }
    })

    const dbTxMock = {
      insert: insertDispatch,
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      }),
    }

    const db = {
      db: {
        query: {
          transactions: {
            findFirst: vi
              .fn()
              .mockResolvedValueOnce(dropTx)
              .mockResolvedValue({ ...dropTx, status: 'VALIDATED', payoutRequestId: 'pr-drop-1' }),
            findMany: vi.fn().mockResolvedValue([]),
          },
          users: {
            findFirst: vi
              .fn()
              .mockResolvedValue({ id: 'drop-1', dropSharePercent: 5, walletUsdtErc20: '0xdrop' }),
          },
          projects: { findFirst: vi.fn().mockResolvedValue({ id: 'proj-1', name: 'P' }) },
          teamMembers: { findMany: vi.fn().mockResolvedValue([]) },
          projectMembers: { findFirst: vi.fn().mockResolvedValue(null) },
          juniorPayments: { findFirst: vi.fn().mockResolvedValue(null) },
        },
        transaction: vi
          .fn()
          .mockImplementation((fn: (dbtx: unknown) => Promise<void>) => fn(dbTxMock)),
        insert: insertIntoMock,
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
        }),
      },
    } as never

    const invoicesStub = { autoCreateForPayout: vi.fn(), autoCreateForIncome: vi.fn() } as never
    const documentsStub = { findOne: vi.fn() } as never
    const svc = new TransactionsService(db, invoicesStub, documentsStub)

    await svc.validateTransaction('dtx-1', 'validate', null, ACCOUNTANT_USER)

    // db.transaction() MUST have been called (atomic)
    const { db: innerDb } = db as { db: { transaction: ReturnType<typeof vi.fn> } }
    expect(innerDb.transaction).toHaveBeenCalledTimes(1)
  })
})

describe('createPayoutRequest (#7)', () => {
  it('throws ForbiddenException for non-SENIOR roles', async () => {
    const svc = makeService()
    await expect(svc.createPayoutRequest(['tx-1'], ACCOUNTANT_USER)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('throws BadRequestException when tx count mismatch (dup guard or wrong owner)', async () => {
    // findMany returns fewer txs than requested (isNull guard filtered one out)
    const db = {
      db: {
        query: {
          transactions: {
            findMany: vi.fn().mockResolvedValue([makeTx()]), // only 1 returned for 2 requested
          },
        },
      },
    } as never
    const svc = new TransactionsService(db, {} as never, {} as never)

    await expect(
      svc.createPayoutRequest(['tx-1', 'tx-already-linked'], SENIOR_USER),
    ).rejects.toThrow(BadRequestException)
  })

  it('creates single payout_request for multiple VALIDATED txs', async () => {
    // Two VALIDATED txs owned by SENIOR_USER, no payoutRequestId
    const tx1 = makeTx({
      id: 'tx-1',
      amount: '1000',
      seniorSharePercent: 26,
      payoutRequestId: null,
    })
    const tx2 = makeTx({ id: 'tx-2', amount: '500', seniorSharePercent: 30, payoutRequestId: null })

    const prRow = makePayoutRequestRow('pr-new-1')
    const insertReturnMock = vi.fn().mockResolvedValue([prRow])
    const insertValuesMock = vi.fn().mockReturnValue({ returning: insertReturnMock })
    const insertIntoMock = vi.fn().mockReturnValue({ values: insertValuesMock })

    const updateWhereMock = vi.fn().mockResolvedValue([])
    const updateSetMock = vi.fn().mockReturnValue({ where: updateWhereMock })
    const updateMock = vi.fn().mockReturnValue({ set: updateSetMock })

    const payoutInsertValuesMock = vi.fn().mockResolvedValue([])
    // Second insert call (PAYOUT row) returns empty
    let callIdx = 0
    const insertDispatch = vi.fn().mockImplementation(() => {
      callIdx++
      if (callIdx === 1) return { values: insertValuesMock } // payoutRequests
      return { values: payoutInsertValuesMock } // PAYOUT transaction
    })

    const findPayoutRequestMock = vi.fn().mockResolvedValue({
      ...prRow,
      transactions: [tx1, tx2],
    })

    const db = {
      db: {
        query: {
          transactions: {
            findMany: vi.fn().mockResolvedValue([tx1, tx2]),
            findFirst: vi.fn().mockResolvedValue(null),
          },
          payoutRequests: { findFirst: findPayoutRequestMock },
          users: { findFirst: vi.fn() },
          projects: { findFirst: vi.fn() },
          teamMembers: { findMany: vi.fn().mockResolvedValue([]) },
        },
        insert: insertDispatch,
        update: updateMock,
      },
    } as never

    const invoicesStub = { autoCreateForPayout: vi.fn(), autoCreateForIncome: vi.fn() } as never
    const svc = new TransactionsService(db, invoicesStub, {} as never)

    await svc.createPayoutRequest(['tx-1', 'tx-2'], SENIOR_USER)

    // insert called twice: once for payoutRequests, once for PAYOUT row
    expect(insertDispatch).toHaveBeenCalledTimes(2)

    // Correct aggregate payable: 1000*(1-0.26) + 500*(1-0.30) = 740 + 350 = 1090
    const insertedValues = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(parseFloat(insertedValues['payableAmount'] as string)).toBeCloseTo(1090, 2)
    expect(parseFloat(insertedValues['incomeAmount'] as string)).toBeCloseTo(1500, 2)

    // update called once (link txs + flip to PENDING_PAYMENT)
    expect(updateMock).toHaveBeenCalledTimes(1)
  })

  it('per-tx payable aggregation: different sharePercent values', () => {
    // Pure math check — no DB needed.
    // tx1: 2000 * (1 - 0.20) = 1600
    // tx2: 3000 * (1 - 0.30) = 2100
    // total payable = 3700, income = 5000
    const txs = [
      { amount: '2000', seniorSharePercent: 20 },
      { amount: '3000', seniorSharePercent: 30 },
    ]
    const payable = txs.reduce((sum, tx) => {
      const share = tx.seniorSharePercent ?? 26
      return sum + parseFloat(tx.amount) * (1 - share / 100)
    }, 0)
    const income = txs.reduce((sum, tx) => sum + parseFloat(tx.amount), 0)
    expect(payable).toBeCloseTo(3700, 2)
    expect(income).toBeCloseTo(5000, 2)
  })
})

describe('createPayoutRequest — duplicate guard (belt-and-suspenders, #7)', () => {
  it('BadRequest when all txs already have payoutRequestId (filter returns 0)', async () => {
    // isNull(payoutRequestId) filter means linked txs are excluded from results
    const db = {
      db: {
        query: {
          transactions: {
            // Returns [] because isNull filter excluded the already-linked tx
            findMany: vi.fn().mockResolvedValue([]),
          },
        },
      },
    } as never
    const svc = new TransactionsService(db, {} as never, {} as never)

    await expect(svc.createPayoutRequest(['tx-already-in-payout'], SENIOR_USER)).rejects.toThrow(
      BadRequestException,
    )
  })
})
