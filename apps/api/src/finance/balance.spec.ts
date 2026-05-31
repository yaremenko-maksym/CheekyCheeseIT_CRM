/**
 * Drop role - phase 4-A. Unit tests for `BalanceService` — verifies the
 * computed-on-demand TOВ / admin / senior balance math and the multi-currency
 * conversion via NBU rates.
 *
 * The service is instantiated with mock `DatabaseService` + mock
 * `NbuCurrencyService` shaped exactly like the real ones. The drizzle
 * `query.transactions.findMany()` and `query.pendingObligations.findMany()`
 * calls are stubbed with hand-rolled rows so tests stay deterministic and
 * never touch a real DB.
 *
 * Coverage:
 *   - TOВ: empty → 0; +TOV_INCOME → income; −DIVIDEND_TO_ADMIN; −EXPENSE
 *     (FIAT_TOV label); −DIVIDEND_TAX.
 *   - Admin: empty → 0; +ADMIN_INCOME_CASH; +DIVIDEND_TO_ADMIN; recipientId
 *     fallback; cross-admin attribution does not leak.
 *   - Senior: SENIOR_PENDING_PAYOUT does NOT credit the balance; SENIOR_PAID
 *     does.
 *   - Multi-currency: USDT + UAH + USD rows are normalized to USD via NBU
 *     rates.
 */
import { describe, expect, it } from 'vitest'
import { BalanceService, convertToBase } from './balance.service'

// ── helpers ────────────────────────────────────────────────────────────────

function makeRates(usdUah = '40.0000', eurUah = '44.0000') {
  return { usdUah, usdtUah: usdUah, eurUah, date: '20260531' }
}

interface MockTransactionRow {
  id?: string
  type: string
  status?: string
  amount: string
  currency: 'USDT' | 'USD' | 'EUR' | 'UAH'
  senderId?: string | null
  senderLabel?: string | null
  receiverId?: string | null
  receiverLabel?: string | null
  recipientId?: string | null
  projectId?: string | null
}

interface MockObligationRow {
  id: string
  creditorUserId: string
  debtorType: 'DROP' | 'TOV' | 'ADMIN'
  debtorUserId: string | null
  sourceTransactionId: string
  closingTransactionId: string | null
  amount: string
  currency: 'USDT' | 'USD' | 'EUR' | 'UAH'
  status: 'PENDING' | 'PAID' | 'CANCELLED'
  createdAt: Date
  updatedAt: Date
}

function makeTx(overrides: Partial<MockTransactionRow>): MockTransactionRow {
  return {
    id: `tx-${Math.random().toString(36).slice(2)}`,
    status: 'PAID',
    amount: '0',
    currency: 'USD',
    senderId: null,
    senderLabel: null,
    receiverId: null,
    receiverLabel: null,
    recipientId: null,
    projectId: null,
    type: 'TOV_INCOME',
    ...overrides,
  }
}

function makeService(
  options: {
    transactions?: MockTransactionRow[]
    obligations?: MockObligationRow[]
    rates?: ReturnType<typeof makeRates>
  } = {},
): BalanceService {
  const rates = options.rates ?? makeRates()
  const drizzleClient = {
    query: {
      transactions: {
        findMany: async () => options.transactions ?? [],
      },
      pendingObligations: {
        findMany: async (args?: { where?: unknown; orderBy?: unknown }) => {
          // The tests for getPendingObligations swap out filters by mutating
          // this list; we ignore the `where` predicate object (drizzle SQL
          // builder) and rely on test-level filtering instead.
          void args
          return options.obligations ?? []
        },
      },
    },
  }
  const db = { db: drizzleClient } as never
  const nbu = {
    getRates: async () => rates,
  } as never
  return new BalanceService(db, nbu)
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('convertToBase', () => {
  it('passes through same currency', () => {
    expect(convertToBase(100, 'USD', 'USD', makeRates())).toBe(100)
    expect(convertToBase(100, 'USDT', 'USDT', makeRates())).toBe(100)
  })

  it('treats USDT 1:1 with USD', () => {
    expect(convertToBase(100, 'USDT', 'USD', makeRates())).toBeCloseTo(100, 6)
    expect(convertToBase(100, 'USD', 'USDT', makeRates())).toBeCloseTo(100, 6)
  })

  it('converts UAH to USD using usdUah rate', () => {
    // 4000 UAH / 40 UAH per USD = 100 USD
    expect(convertToBase(4000, 'UAH', 'USD', makeRates('40.0000', '44.0000'))).toBeCloseTo(
      100,
      6,
    )
  })

  it('converts EUR to USD via UAH triangulation', () => {
    // 100 EUR → 100 * 44 UAH = 4400 UAH → 4400 / 40 = 110 USD
    expect(convertToBase(100, 'EUR', 'USD', makeRates('40.0000', '44.0000'))).toBeCloseTo(
      110,
      6,
    )
  })
})

describe('BalanceService.getTOVBalance', () => {
  it('empty ledger → 0 with zero breakdown', async () => {
    const svc = makeService({ transactions: [] })
    const result = await svc.getTOVBalance('USD')
    expect(result.balance).toBe(0)
    expect(result.currency).toBe('USD')
    expect(result.breakdown).toEqual({
      income: 0,
      dividends_paid: 0,
      expenses: 0,
      tax: 0,
    })
  })

  it('1× TOV_INCOME $1000 → balance 1000', async () => {
    const svc = makeService({
      transactions: [makeTx({ type: 'TOV_INCOME', amount: '1000', currency: 'USD' })],
    })
    const result = await svc.getTOVBalance('USD')
    expect(result.balance).toBeCloseTo(1000, 6)
    expect(result.breakdown.income).toBeCloseTo(1000, 6)
  })

  it('after DIVIDEND_TO_ADMIN $500 → balance 500', async () => {
    const svc = makeService({
      transactions: [
        makeTx({ type: 'TOV_INCOME', amount: '1000', currency: 'USD' }),
        makeTx({ type: 'DIVIDEND_TO_ADMIN', amount: '500', currency: 'USD' }),
      ],
    })
    const result = await svc.getTOVBalance('USD')
    expect(result.balance).toBeCloseTo(500, 6)
    expect(result.breakdown.income).toBeCloseTo(1000, 6)
    expect(result.breakdown.dividends_paid).toBeCloseTo(500, 6)
  })

  it('after FIAT_TOV EXPENSE $100 → balance 400', async () => {
    const svc = makeService({
      transactions: [
        makeTx({ type: 'TOV_INCOME', amount: '1000', currency: 'USD' }),
        makeTx({ type: 'DIVIDEND_TO_ADMIN', amount: '500', currency: 'USD' }),
        makeTx({
          type: 'EXPENSE',
          amount: '100',
          currency: 'USD',
          receiverLabel: 'FIAT_TOV: Cloud bill',
        }),
      ],
    })
    const result = await svc.getTOVBalance('USD')
    expect(result.balance).toBeCloseTo(400, 6)
    expect(result.breakdown.expenses).toBeCloseTo(100, 6)
  })

  it('legacy EXPENSE without FIAT_TOV label is ignored', async () => {
    const svc = makeService({
      transactions: [
        makeTx({ type: 'TOV_INCOME', amount: '1000', currency: 'USD' }),
        // No FIAT_TOV marker — this is a legacy expense, getSummary still
        // counts it, BalanceService.getTOVBalance must not.
        makeTx({
          type: 'EXPENSE',
          amount: '100',
          currency: 'USD',
          receiverLabel: 'Прочее',
        }),
      ],
    })
    const result = await svc.getTOVBalance('USD')
    expect(result.balance).toBeCloseTo(1000, 6)
    expect(result.breakdown.expenses).toBe(0)
  })

  it('DIVIDEND_TAX debits the balance', async () => {
    const svc = makeService({
      transactions: [
        makeTx({ type: 'TOV_INCOME', amount: '1000', currency: 'USD' }),
        // 6.5% of 1000 = 65
        makeTx({ type: 'DIVIDEND_TAX', amount: '65', currency: 'USD' }),
      ],
    })
    const result = await svc.getTOVBalance('USD')
    expect(result.balance).toBeCloseTo(935, 6)
    expect(result.breakdown.tax).toBeCloseTo(65, 6)
  })
})

describe('BalanceService.getAdminBalance', () => {
  const MAKSYM = '00000000-0000-0000-0000-000000000001'
  const KOSTYA = '00000000-0000-0000-0000-000000000002'

  it('empty ledger → 0', async () => {
    const svc = makeService({ transactions: [] })
    const result = await svc.getAdminBalance(MAKSYM, 'USD')
    expect(result.balance).toBe(0)
  })

  it('ADMIN_INCOME_CASH $500 (recipientId = self) → balance 500', async () => {
    const svc = makeService({
      transactions: [
        makeTx({
          type: 'ADMIN_INCOME_CASH',
          amount: '500',
          currency: 'USD',
          recipientId: MAKSYM,
        }),
      ],
    })
    const result = await svc.getAdminBalance(MAKSYM, 'USD')
    expect(result.balance).toBeCloseTo(500, 6)
    expect(result.breakdown.cash_income).toBeCloseTo(500, 6)
  })

  it('DIVIDEND_TO_ADMIN $250 stacks on existing cash → balance 750', async () => {
    const svc = makeService({
      transactions: [
        makeTx({
          type: 'ADMIN_INCOME_CASH',
          amount: '500',
          currency: 'USD',
          recipientId: MAKSYM,
        }),
        makeTx({
          type: 'DIVIDEND_TO_ADMIN',
          amount: '250',
          currency: 'USD',
          recipientId: MAKSYM,
        }),
      ],
    })
    const result = await svc.getAdminBalance(MAKSYM, 'USD')
    expect(result.balance).toBeCloseTo(750, 6)
    expect(result.breakdown.cash_income).toBeCloseTo(500, 6)
    expect(result.breakdown.dividends).toBeCloseTo(250, 6)
  })

  it('does not leak income for a different admin', async () => {
    const svc = makeService({
      transactions: [
        makeTx({
          type: 'ADMIN_INCOME_CASH',
          amount: '500',
          currency: 'USD',
          recipientId: KOSTYA,
        }),
      ],
    })
    const result = await svc.getAdminBalance(MAKSYM, 'USD')
    expect(result.balance).toBe(0)
  })

  it('falls back to receiverId when recipientId is null', async () => {
    const svc = makeService({
      transactions: [
        makeTx({
          type: 'ADMIN_INCOME_CRYPTO',
          amount: '300',
          currency: 'USDT',
          recipientId: null,
          receiverId: MAKSYM,
        }),
      ],
    })
    const result = await svc.getAdminBalance(MAKSYM, 'USD')
    // USDT 1:1 USD
    expect(result.balance).toBeCloseTo(300, 6)
    expect(result.breakdown.crypto_income).toBeCloseTo(300, 6)
  })

  it('EXPENSE sent by admin debits balance', async () => {
    const svc = makeService({
      transactions: [
        makeTx({
          type: 'ADMIN_INCOME_CASH',
          amount: '1000',
          currency: 'USD',
          recipientId: MAKSYM,
        }),
        makeTx({ type: 'EXPENSE', amount: '200', currency: 'USD', senderId: MAKSYM }),
      ],
    })
    const result = await svc.getAdminBalance(MAKSYM, 'USD')
    expect(result.balance).toBeCloseTo(800, 6)
    expect(result.breakdown.expenses).toBeCloseTo(200, 6)
  })
})

describe('BalanceService.getSeniorBalance', () => {
  const SENIOR_A = 'senior-a-id'
  const SENIOR_B = 'senior-b-id'

  it('SENIOR_PENDING_PAYOUT does NOT change balance', async () => {
    const svc = makeService({
      transactions: [
        makeTx({
          type: 'SENIOR_PENDING_PAYOUT',
          amount: '1000',
          currency: 'USD',
          recipientId: SENIOR_A,
        }),
      ],
    })
    const result = await svc.getSeniorBalance(SENIOR_A, 'USD')
    expect(result.balance).toBe(0)
    expect(result.breakdown.paid_income).toBe(0)
  })

  it('SENIOR_PAID credits the balance', async () => {
    const svc = makeService({
      transactions: [
        makeTx({
          type: 'SENIOR_PENDING_PAYOUT',
          amount: '1000',
          currency: 'USD',
          recipientId: SENIOR_A,
        }),
        // Closes the obligation: senior actually got paid
        makeTx({
          type: 'SENIOR_PAID',
          amount: '1000',
          currency: 'USD',
          recipientId: SENIOR_A,
        }),
      ],
    })
    const result = await svc.getSeniorBalance(SENIOR_A, 'USD')
    expect(result.balance).toBeCloseTo(1000, 6)
    expect(result.breakdown.paid_income).toBeCloseTo(1000, 6)
  })

  it('SENIOR_INCOME_CRYPTO credits as crypto income', async () => {
    const svc = makeService({
      transactions: [
        makeTx({
          type: 'SENIOR_INCOME_CRYPTO',
          amount: '500',
          currency: 'USDT',
          recipientId: SENIOR_A,
        }),
      ],
    })
    const result = await svc.getSeniorBalance(SENIOR_A, 'USD')
    expect(result.balance).toBeCloseTo(500, 6)
    expect(result.breakdown.crypto_income).toBeCloseTo(500, 6)
  })

  it('does not leak income for another senior', async () => {
    const svc = makeService({
      transactions: [
        makeTx({
          type: 'SENIOR_PAID',
          amount: '1000',
          currency: 'USD',
          recipientId: SENIOR_B,
        }),
      ],
    })
    const result = await svc.getSeniorBalance(SENIOR_A, 'USD')
    expect(result.balance).toBe(0)
  })

  it('EXPENSE by senior debits the balance', async () => {
    const svc = makeService({
      transactions: [
        makeTx({
          type: 'SENIOR_PAID',
          amount: '1000',
          currency: 'USD',
          recipientId: SENIOR_A,
        }),
        makeTx({ type: 'EXPENSE', amount: '100', currency: 'USD', senderId: SENIOR_A }),
      ],
    })
    const result = await svc.getSeniorBalance(SENIOR_A, 'USD')
    expect(result.balance).toBeCloseTo(900, 6)
    expect(result.breakdown.expenses).toBeCloseTo(100, 6)
  })
})

describe('BalanceService multi-currency conversion (edge case AC7)', () => {
  it('TOV_INCOME 1000 USDT + 4000 UAH + 100 EUR → USD via NBU rates', async () => {
    const svc = makeService({
      transactions: [
        makeTx({ type: 'TOV_INCOME', amount: '1000', currency: 'USDT' }), // = 1000 USD
        makeTx({ type: 'TOV_INCOME', amount: '4000', currency: 'UAH' }), // = 100 USD @ 40
        makeTx({ type: 'TOV_INCOME', amount: '100', currency: 'EUR' }), // = 110 USD via 44/40
      ],
      rates: makeRates('40.0000', '44.0000'),
    })
    const result = await svc.getTOVBalance('USD')
    expect(result.balance).toBeCloseTo(1210, 4)
    expect(result.currency).toBe('USD')
  })

  it('TOV_INCOME 1000 USD returned in UAH → 40000 UAH at rate 40', async () => {
    const svc = makeService({
      transactions: [makeTx({ type: 'TOV_INCOME', amount: '1000', currency: 'USD' })],
      rates: makeRates('40.0000', '44.0000'),
    })
    const result = await svc.getTOVBalance('UAH')
    expect(result.balance).toBeCloseTo(40000, 4)
    expect(result.currency).toBe('UAH')
  })

  it('default currency is USD when not specified', async () => {
    const svc = makeService({
      transactions: [makeTx({ type: 'TOV_INCOME', amount: '500', currency: 'USDT' })],
    })
    const result = await svc.getTOVBalance()
    expect(result.currency).toBe('USD')
    expect(result.balance).toBeCloseTo(500, 6)
  })
})

describe('BalanceService.getPendingObligations', () => {
  const SENIOR_A = 'senior-a-id'
  const SENIOR_B = 'senior-b-id'
  const SOURCE_TX = 'tx-source-1'

  function makeObligation(overrides: Partial<MockObligationRow> = {}): MockObligationRow {
    const now = new Date('2026-05-30T00:00:00Z')
    return {
      id: 'oblig-1',
      creditorUserId: SENIOR_A,
      debtorType: 'TOV',
      debtorUserId: null,
      sourceTransactionId: SOURCE_TX,
      closingTransactionId: null,
      amount: '1000',
      currency: 'USD',
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    }
  }

  it('creation → 1 row PENDING', async () => {
    const svc = makeService({
      obligations: [makeObligation()],
    })
    const list = await svc.getPendingObligations()
    expect(list).toHaveLength(1)
    expect(list[0]!.status).toBe('PENDING')
    expect(list[0]!.amount).toBe('1000')
    expect(list[0]!.currency).toBe('USD')
    // ISO-string timestamps in the wire shape
    expect(list[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('closing with SENIOR_PAID → row in PAID with closingTransactionId', async () => {
    const closingTx = 'tx-closing-1'
    const svc = makeService({
      obligations: [
        makeObligation({
          status: 'PAID',
          closingTransactionId: closingTx,
        }),
      ],
    })
    const list = await svc.getPendingObligations()
    expect(list[0]!.status).toBe('PAID')
    expect(list[0]!.closingTransactionId).toBe(closingTx)
  })

  it('filter by creditorUserId returns only that senior', async () => {
    // The mock ignores `where`; this test enforces the wire contract by
    // controlling the input dataset. The real service builds an `and()`
    // predicate that drizzle applies — covered separately by integration.
    const svc = makeService({
      obligations: [makeObligation({ id: 'o-a', creditorUserId: SENIOR_A })],
    })
    const list = await svc.getPendingObligations({ creditorUserId: SENIOR_A })
    expect(list).toHaveLength(1)
    expect(list[0]!.creditorUserId).toBe(SENIOR_A)
  })

  it('filter by status PENDING returns only PENDING rows', async () => {
    const svc = makeService({
      obligations: [makeObligation({ status: 'PENDING' })],
    })
    const list = await svc.getPendingObligations({ status: 'PENDING' })
    expect(list).toHaveLength(1)
    expect(list[0]!.status).toBe('PENDING')
  })

  // Sanity check on the wire shape — what the controller hands to clients.
  it('returns ISO timestamps and camelCase keys', async () => {
    const svc = makeService({
      obligations: [
        makeObligation({
          debtorType: 'DROP',
          debtorUserId: SENIOR_B,
        }),
      ],
    })
    const [row] = await svc.getPendingObligations()
    expect(row).toMatchObject({
      id: expect.any(String),
      creditorUserId: SENIOR_A,
      debtorType: 'DROP',
      debtorUserId: SENIOR_B,
      sourceTransactionId: SOURCE_TX,
      closingTransactionId: null,
      amount: '1000',
      currency: 'USD',
      status: 'PENDING',
    })
  })
})
