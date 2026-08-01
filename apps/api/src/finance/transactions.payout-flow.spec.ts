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
 *   6. createPayoutRequest — Phase 8 v2 (replaces the old mixed-currency guard):
 *      batch with transactions of different currencies is ACCEPTED and the
 *      company-shares are converted to a single USDT payable.
 *
 *   7. createPayoutRequest — Phase 8 v2: PAYOUT row + payout_request are ALWAYS
 *      USDT (settlement with the company is in crypto).
 *
 *   8. createPayoutRequest — atomicity: full path runs inside db.transaction().
 *
 * Phase 8 v2 — createPayoutRequest now:
 *   - fetches the NBU rate snapshot (stubbed NbuCurrencyService) to convert
 *     cross-currency company-shares into USDT,
 *   - reads the company wallet from dbtx.query.companyAccount (recipient),
 *   - throws BadRequest('Кошелёк компании не настроен') when it is unset.
 * The constructor is now 5-arg: (db, invoices, documents, nbu, etherscan).
 *
 * DB calls are stubbed with vitest vi.fn() — no real Postgres connection.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import type { NbuCurrencyService } from './nbu-currency.service'
import type { EtherscanService } from './etherscan.service'

// ── Helpers ────────────────────────────────────────────────────────────────

const COMPANY_WALLET = '0xC0FFEE0000000000000000000000000000000001'

// Stubbed NBU snapshot. usdtUah === usdUah (USDT pegged 1:1 to USD). Picked
// round-ish rates so the EUR/UAH→USDT conversions in the assertions are easy to
// reason about: 1 USD = 40 UAH, 1 EUR = 44 UAH ⇒ 1 EUR = 1.1 USDT.
function makeNbuStub(): NbuCurrencyService {
  return {
    getRates: vi.fn().mockResolvedValue({
      usdUah: '40.0000',
      usdtUah: '40.0000',
      eurUah: '44.0000',
      date: '20260620',
    }),
  } as unknown as NbuCurrencyService
}

// Default Etherscan stub — happy on-chain confirm (only exercised by
// payPayoutRequest tests; createPayoutRequest never calls it).
function makeEtherscanStub(): EtherscanService {
  return {
    verifyDeposit: vi.fn().mockResolvedValue({
      found: true,
      toMatches: true,
      confirmed: true,
      confirmations: 12,
      amountUsdt: null,
    }),
  } as unknown as EtherscanService
}

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

// ── dbtx stub factory ─────────────────────────────────────────────────────
//
// createPayoutRequest now runs entirely inside db.transaction(async dbtx => {}).
// The service calls:
//   1. dbtx.select().from(transactions).where(...).for('update')
//      → returns lockedRows array
//   2. dbtx.insert(payoutRequests).values(...).returning()
//      → returns [prRow]
//   3. dbtx.update(transactions).set(...).where(...)
//      → resolves (no return used)
//   4. dbtx.insert(transactions).values(...)
//      → resolves (no return used)
//
// The builder chains are fully fluent so every stub method must return `this`
// (i.e. the same mock object) until the terminal awaitable is reached.
// We use a real object with shared mocks so assertions can inspect call args.

function makeDbtxStub(
  lockedRows: unknown[],
  prRow: ReturnType<typeof makePayoutRequestRow>,
  // Phase 8 v2 — the company wallet the recipient resolves to. null = unset
  // (createPayoutRequest must then throw 'Кошелёк компании не настроен').
  walletAddress: string | null = COMPANY_WALLET,
) {
  // Terminal resolvers
  const forMock = vi.fn().mockResolvedValue(lockedRows) // select chain terminal
  const returningMock = vi.fn().mockResolvedValue([prRow]) // insert PR chain terminal
  const updateWhereMock = vi.fn().mockResolvedValue([]) // update chain terminal
  const insertValuesResolveMock = vi.fn().mockResolvedValue([]) // insert PAYOUT terminal

  // select() chain: .select().from().where().for()
  const selectWhereMock = vi.fn().mockReturnValue({ for: forMock })
  const selectFromMock = vi.fn().mockReturnValue({ where: selectWhereMock })
  const selectMock = vi.fn().mockReturnValue({ from: selectFromMock })

  // insert(payoutRequests) chain: .insert().values().returning()
  // insert(transactions)   chain: .insert().values() [resolves directly]
  let insertCallIdx = 0
  const insertMock = vi.fn().mockImplementation(() => {
    insertCallIdx++
    if (insertCallIdx === 1) {
      // First insert: payoutRequests → chain ends with .returning()
      return { values: vi.fn().mockReturnValue({ returning: returningMock }) }
    }
    // Second insert: transactions PAYOUT row → chain ends with .values() resolve
    return { values: insertValuesResolveMock }
  })

  // update(transactions) chain: .update().set().where()
  const updateMock = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({ where: updateWhereMock }),
  })

  // Phase 8 v2 — dbtx.query.companyAccount.findFirst() resolves the recipient.
  const companyAccountFindFirst = vi
    .fn()
    .mockResolvedValue(walletAddress ? { walletAddress, confirmationThreshold: 12 } : null)

  return {
    dbtx: {
      select: selectMock,
      insert: insertMock,
      update: updateMock,
      query: { companyAccount: { findFirst: companyAccountFindFirst } },
    },
    mocks: {
      selectMock,
      forMock,
      insertMock,
      returningMock,
      updateMock,
      insertValuesResolveMock,
      companyAccountFindFirst,
    },
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

  return makeTransactionsService({
    db: dbStub,
    invoicesService: invoicesStub,
    documentsService: documentsStub,
    nbuCurrencyService: makeNbuStub(),
    etherscanService: makeEtherscanStub(),
  })
}

// Helper: build a service whose db.transaction() executes the callback with a
// fully-wired dbtx stub, and whose query.payoutRequests.findFirst returns a
// stubbed payout-request row (for the findPayoutRequest tail call).
function makeServiceWithTransaction(
  lockedRows: unknown[],
  prRow: ReturnType<typeof makePayoutRequestRow>,
) {
  const { dbtx, mocks } = makeDbtxStub(lockedRows, prRow)

  const dbStub = {
    db: {
      query: {
        transactions: {
          findFirst: vi.fn().mockResolvedValue(null),
          findMany: vi.fn().mockResolvedValue([]),
        },
        users: { findFirst: vi.fn() },
        payoutRequests: {
          findFirst: vi.fn().mockResolvedValue({
            ...prRow,
            senior: { displayName: 'Senior' },
            transactions: lockedRows,
          }),
        },
        projects: { findFirst: vi.fn() },
        teamMembers: { findMany: vi.fn().mockResolvedValue([]) },
      },
      // db.transaction(fn) — execute the callback with our dbtx stub
      transaction: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(dbtx)),
      // Top-level select/insert/update stubs (not called by createPayoutRequest
      // but present so TransactionsService constructor + other helpers don't fail)
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue([]),
      }),
    },
  } as never

  const invoicesStub = {
    autoCreateForPayout: vi.fn().mockResolvedValue(undefined),
    autoCreateForIncome: vi.fn().mockResolvedValue(undefined),
  } as never

  const svc = makeTransactionsService({
    db: dbStub,
    invoicesService: invoicesStub,
    nbuCurrencyService: makeNbuStub(),
    etherscanService: makeEtherscanStub(),
  })
  return { svc, dbStub, mocks }
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
    // task-soft-delete-and-money-audit (AC5): validateTransaction now wraps
    // the status flip in a db.transaction so it can atomically journal the
    // VALIDATE action alongside it.
    const dbTransactionMock = vi
      .fn()
      .mockImplementation((fn: (dbtx: unknown) => Promise<void>) =>
        fn({ insert: dbInsertMock, update: dbUpdateMock }),
      )

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
        transaction: dbTransactionMock,
        insert: dbInsertMock,
        update: dbUpdateMock,
      },
    } as never

    const invoicesStub = {
      autoCreateForPayout: vi.fn(),
      autoCreateForIncome: vi.fn(),
    } as never
    const documentsStub = { findOne: vi.fn() } as never

    const svc = makeTransactionsService({
      db,
      invoicesService: invoicesStub,
      documentsService: documentsStub,
      nbuCurrencyService: makeNbuStub(),
      etherscanService: makeEtherscanStub(),
    })

    // Act
    await svc.validateTransaction('tx-1', 'validate', null, ACCOUNTANT_USER)

    // Assert: no payout_request / PAYOUT row created — insert is called
    // EXACTLY once, for the VALIDATE journal entry (task-soft-delete-and-
    // money-audit, AC5), not for a second money row.
    expect(dbInsertMock).toHaveBeenCalledTimes(1)

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

    const svc = makeTransactionsService({
      db,
      invoicesService: invoicesStub,
      documentsService: documentsStub,
      nbuCurrencyService: makeNbuStub(),
      etherscanService: makeEtherscanStub(),
    })

    await expect(
      svc.validateTransaction('tx-1', 'validate', null, ACCOUNTANT_USER),
    ).rejects.toThrow(BadRequestException)
  })

  it('rejects non-ADMIN/ACCOUNTANT actors with ForbiddenException', async () => {
    const db = { db: { query: { transactions: { findFirst: vi.fn() } } } } as never
    const svc = makeTransactionsService({
      db,
      nbuCurrencyService: makeNbuStub(),
      etherscanService: makeEtherscanStub(),
    })

    await expect(svc.validateTransaction('tx-1', 'validate', null, SENIOR_USER)).rejects.toThrow(
      ForbiddenException,
    )
  })
})

describe('validateTransaction — DROP_INCOME flip-only (task-drop-payout-company-account)', () => {
  // task-drop-payout-company-account: DROP_INCOME validate is now flip-only —
  // SAME as SENIOR_INCOME. No payout_request and no placeholder PAYOUT are
  // created at validate time anymore (the legacy auto-payout was a payment-
  // channel artifact). The DROP later bundles their VALIDATED DROP_INCOME via
  // createPayoutRequest, exactly like a SENIOR.
  it('flips DROP_INCOME to VALIDATED without creating payout_request or PAYOUT', async () => {
    const dropTx = makeTx({
      id: 'dtx-1',
      type: 'DROP_INCOME',
      status: 'PENDING',
      receiverId: 'drop-1',
    })

    const dbInsertMock = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) })
    const dbUpdateMock = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    })
    const dbTransactionMock = vi
      .fn()
      .mockImplementation((fn: (dbtx: unknown) => Promise<void>) =>
        fn({ insert: dbInsertMock, update: dbUpdateMock }),
      )

    const db = {
      db: {
        query: {
          transactions: {
            findFirst: vi
              .fn()
              .mockResolvedValueOnce(dropTx)
              .mockResolvedValue({ ...dropTx, status: 'VALIDATED', payoutRequestId: null }),
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
        transaction: dbTransactionMock,
        insert: dbInsertMock,
        update: dbUpdateMock,
      },
    } as never

    const invoicesStub = { autoCreateForPayout: vi.fn(), autoCreateForIncome: vi.fn() } as never
    const documentsStub = { findOne: vi.fn() } as never
    const svc = makeTransactionsService({
      db,
      invoicesService: invoicesStub,
      documentsService: documentsStub,
      nbuCurrencyService: makeNbuStub(),
      etherscanService: makeEtherscanStub(),
    })

    await svc.validateTransaction('dtx-1', 'validate', null, ACCOUNTANT_USER)

    // No payout_request and no PAYOUT row created — insert is called EXACTLY
    // once, for the VALIDATE journal entry (task-soft-delete-and-money-audit,
    // AC5), not for a second money row. The flip now DOES open a
    // db.transaction (SENIOR's mirror above does too) so the journal write
    // is atomic with the status flip.
    expect(dbInsertMock).toHaveBeenCalledTimes(1)
    expect(dbTransactionMock).toHaveBeenCalledTimes(1)
    // Exactly one update — the status flip to VALIDATED.
    expect(dbUpdateMock).toHaveBeenCalledTimes(1)
  })
})

describe('createPayoutRequest (#7)', () => {
  it('throws ForbiddenException for non-SENIOR roles', async () => {
    // db.transaction is not reached — role check fires first
    const svc = makeService()
    await expect(svc.createPayoutRequest(['tx-1'], ACCOUNTANT_USER)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('throws BadRequestException when tx count mismatch (dup guard or wrong owner)', async () => {
    // FOR UPDATE lock returns fewer rows than requested →
    // lockedRows.length !== transactionIds.length → BadRequestException.
    // lockedRows = 1 row for 2 requested ids (isNull guard filtered one out).
    const lockedRow = makeTx({ id: 'tx-1', currency: 'USDT' as const })
    const prRow = makePayoutRequestRow()

    // Build a dbtx stub whose select chain returns only 1 row
    const { dbtx } = makeDbtxStub([lockedRow], prRow)

    const db = {
      db: {
        query: {
          transactions: { findFirst: vi.fn(), findMany: vi.fn() },
          payoutRequests: { findFirst: vi.fn() },
        },
        transaction: vi
          .fn()
          .mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(dbtx)),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
        }),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
      },
    } as never
    const svc = makeTransactionsService({
      db,
      nbuCurrencyService: makeNbuStub(),
      etherscanService: makeEtherscanStub(),
    })

    await expect(
      svc.createPayoutRequest(['tx-1', 'tx-already-linked'], SENIOR_USER),
    ).rejects.toThrow(BadRequestException)
  })

  it('creates single payout_request for multiple VALIDATED txs', async () => {
    // Two VALIDATED USDT txs owned by SENIOR_USER, no payoutRequestId.
    // Verifies: insert called 2x, correct aggregate payable, update called 1x.
    const tx1 = makeTx({
      id: 'tx-1',
      amount: '1000',
      seniorSharePercent: 26,
      currency: 'USDT' as const,
      payoutRequestId: null,
    })
    const tx2 = makeTx({
      id: 'tx-2',
      amount: '500',
      seniorSharePercent: 30,
      currency: 'USDT' as const,
      payoutRequestId: null,
    })
    const lockedRows = [tx1, tx2]
    const prRow = makePayoutRequestRow('pr-new-1')

    const { svc, mocks } = makeServiceWithTransaction(lockedRows, prRow)

    await svc.createPayoutRequest(['tx-1', 'tx-2'], SENIOR_USER)

    // insert called twice: once for payoutRequests, once for PAYOUT row
    expect(mocks.insertMock).toHaveBeenCalledTimes(2)

    // Correct aggregate payable (decimal-safe integer arithmetic):
    //   tx1: 1000 * (1 - 26/100) = 740
    //   tx2:  500 * (1 - 30/100) = 350
    //   total payable = 1090, income = 1500
    // returningMock is called with no args — values were passed via .values() before.
    // We check the values mock on the first insert call instead.
    const firstInsertValuesArg = (
      mocks.insertMock.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> }
    ).values.mock.calls[0]?.[0] as Record<string, unknown>
    expect(parseFloat(firstInsertValuesArg['payableAmount'] as string)).toBeCloseTo(1090, 2)
    expect(parseFloat(firstInsertValuesArg['incomeAmount'] as string)).toBeCloseTo(1500, 2)

    // update called once (link txs + flip to PENDING_PAYMENT)
    expect(mocks.updateMock).toHaveBeenCalledTimes(1)
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

  // ── Phase 8 v2 (AC2) — mixed currencies ACCEPTED, converted to one USDT payout
  it('accepts mixed-currency batch and sums company-shares into a single USDT payable', async () => {
    // USDT 1000 @26% → 740 USDT; USD 500 @26% → 370 USD (=370 USDT, 1:1).
    // Total payable = 1110 USDT; income = 1500 USDT (1000 + 500). The previous
    // mixed-currency hard guard (BadRequest) is gone — this is the bug fix.
    const txUsdt = makeTx({
      id: 'tx-usdt',
      currency: 'USDT' as const,
      amount: '1000',
      seniorSharePercent: 26,
    })
    const txUsd = makeTx({
      id: 'tx-usd',
      currency: 'USD' as const,
      amount: '500',
      seniorSharePercent: 26,
    })
    const lockedRows = [txUsdt, txUsd]
    const prRow = makePayoutRequestRow('pr-mixed-1')

    const { svc, mocks } = makeServiceWithTransaction(lockedRows, prRow)

    // Does NOT throw.
    await svc.createPayoutRequest(['tx-usdt', 'tx-usd'], SENIOR_USER)

    // payout_request (first insert) carries the USDT-converted sums.
    const prInsertArg = (
      mocks.insertMock.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> }
    ).values.mock.calls[0]?.[0] as Record<string, unknown>
    expect(parseFloat(prInsertArg['payableAmount'] as string)).toBeCloseTo(1110, 2)
    expect(parseFloat(prInsertArg['incomeAmount'] as string)).toBeCloseTo(1500, 2)

    // PAYOUT row (second insert) is always USDT and equals the payable.
    const payoutInsertArg = (
      mocks.insertMock.mock.results[1]?.value as { values: ReturnType<typeof vi.fn> }
    ).values.mock.calls[0]?.[0] as Record<string, unknown>
    expect(payoutInsertArg['currency']).toBe('USDT')
    expect(parseFloat(payoutInsertArg['amount'] as string)).toBeCloseTo(1110, 2)
  })

  // ── Phase 8 v2 — PAYOUT/payout_request are ALWAYS USDT (EUR converted) ──
  it('EUR batch is converted to USDT (PAYOUT currency=USDT, not EUR)', async () => {
    // EUR 1000 @26% → 740 EUR; EUR 500 @26% → 370 EUR. Total share = 1110 EUR.
    // 1 EUR = eurUah/usdUah = 44/40 = 1.1 USDT ⇒ payable = 1110 * 1.1 = 1221 USDT.
    // income = 1500 EUR * 1.1 = 1650 USDT.
    const txEur1 = makeTx({
      id: 'tx-eur-1',
      currency: 'EUR' as const,
      amount: '1000',
      seniorSharePercent: 26,
    })
    const txEur2 = makeTx({
      id: 'tx-eur-2',
      currency: 'EUR' as const,
      amount: '500',
      seniorSharePercent: 26,
    })
    const lockedRows = [txEur1, txEur2]
    const prRow = makePayoutRequestRow('pr-eur-1')

    const { svc, mocks } = makeServiceWithTransaction(lockedRows, prRow)

    await svc.createPayoutRequest(['tx-eur-1', 'tx-eur-2'], SENIOR_USER)

    // payout_request — USDT-converted sums.
    const prInsertArg = (
      mocks.insertMock.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> }
    ).values.mock.calls[0]?.[0] as Record<string, unknown>
    expect(parseFloat(prInsertArg['payableAmount'] as string)).toBeCloseTo(1221, 2)
    expect(parseFloat(prInsertArg['incomeAmount'] as string)).toBeCloseTo(1650, 2)

    // PAYOUT row is USDT regardless of the EUR source.
    const payoutInsertArg = (
      mocks.insertMock.mock.results[1]?.value as { values: ReturnType<typeof vi.fn> }
    ).values.mock.calls[0]?.[0] as Record<string, unknown>
    expect(payoutInsertArg['currency']).toBe('USDT')
  })

  // ── Phase 8 v2 — recipient = company wallet; unset wallet rejected ──
  it('uses the company wallet as recipient (contractAddress)', async () => {
    const tx = makeTx({ id: 'tx-1', currency: 'USDT' as const, amount: '1000' })
    const prRow = makePayoutRequestRow('pr-wallet-1')
    const { svc, mocks } = makeServiceWithTransaction([tx], prRow)

    await svc.createPayoutRequest(['tx-1'], SENIOR_USER)

    const prInsertArg = (
      mocks.insertMock.mock.results[0]?.value as { values: ReturnType<typeof vi.fn> }
    ).values.mock.calls[0]?.[0] as Record<string, unknown>
    expect(prInsertArg['contractAddress']).toBe(COMPANY_WALLET)
  })

  it('throws BadRequest when the company wallet is not configured', async () => {
    const tx = makeTx({ id: 'tx-1', currency: 'USDT' as const, amount: '1000' })
    const prRow = makePayoutRequestRow('pr-nowallet-1')
    // walletAddress null → recipient unresolved.
    const { dbtx } = makeDbtxStub([tx], prRow, null)
    const db = {
      db: {
        query: {
          transactions: { findFirst: vi.fn(), findMany: vi.fn() },
          payoutRequests: { findFirst: vi.fn() },
        },
        transaction: vi
          .fn()
          .mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(dbtx)),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
        }),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
      },
    } as never
    const svc = makeTransactionsService({
      db,
      nbuCurrencyService: makeNbuStub(),
      etherscanService: makeEtherscanStub(),
    })

    await expect(svc.createPayoutRequest(['tx-1'], SENIOR_USER)).rejects.toThrow(
      BadRequestException,
    )
  })

  // ── MED — atomicity: all writes run inside a single db.transaction() ──
  it('all DB mutations run inside a single db.transaction() call', async () => {
    const tx1 = makeTx({
      id: 'tx-1',
      currency: 'USDT' as const,
      amount: '1000',
      seniorSharePercent: 26,
    })
    const prRow = makePayoutRequestRow('pr-atomic-1')
    const { svc, dbStub } = makeServiceWithTransaction([tx1], prRow)

    await svc.createPayoutRequest(['tx-1'], SENIOR_USER)

    const transactionMock = (dbStub as { db: { transaction: ReturnType<typeof vi.fn> } }).db
      .transaction
    expect(transactionMock).toHaveBeenCalledTimes(1)
  })
})

describe('createPayoutRequest — duplicate guard (belt-and-suspenders, #7)', () => {
  it('BadRequest when all txs already have payoutRequestId (filter returns 0)', async () => {
    // FOR UPDATE lock returns [] (isNull guard excluded the already-linked tx).
    // lockedRows.length (0) !== transactionIds.length (1) → BadRequestException.
    const prRow = makePayoutRequestRow()
    const { dbtx } = makeDbtxStub([], prRow) // empty locked rows

    const db = {
      db: {
        query: {
          transactions: { findFirst: vi.fn(), findMany: vi.fn() },
          payoutRequests: { findFirst: vi.fn() },
        },
        transaction: vi
          .fn()
          .mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(dbtx)),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
        }),
        insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
      },
    } as never
    const svc = makeTransactionsService({
      db,
      nbuCurrencyService: makeNbuStub(),
      etherscanService: makeEtherscanStub(),
    })

    await expect(svc.createPayoutRequest(['tx-already-in-payout'], SENIOR_USER)).rejects.toThrow(
      BadRequestException,
    )
  })
})
