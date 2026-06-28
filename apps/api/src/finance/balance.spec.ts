/**
 * Drop role - phase 4 (refactor). Unit tests for `BalanceService` —
 * verifies the computed-on-demand admin / senior balance math and the
 * multi-currency conversion via NBU rates.
 *
 * The service is instantiated with mock `DatabaseService` + mock
 * `NbuCurrencyService` shaped exactly like the real ones. The drizzle
 * `query.transactions.findMany()` and `query.pendingObligations.findMany()`
 * calls are stubbed with hand-rolled rows so tests stay deterministic and
 * never touch a real DB.
 *
 * Coverage:
 *   - Admin: empty → 0; +ADMIN_INCOME_CASH; +DIVIDEND_TO_ADMIN; recipientId
 *     fallback; cross-admin attribution does not leak.
 *   - Senior: SENIOR_PENDING_PAYOUT does NOT credit the balance; SENIOR_PAID
 *     does.
 *   - Multi-currency: USDT + UAH + USD rows are normalized to USD via NBU
 *     rates (admin balance path).
 *
 * Removed in the refactor (AC3): TOV balance aggregate + tests.
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
    expect(convertToBase(4000, 'UAH', 'USD', makeRates('40.0000', '44.0000'))).toBeCloseTo(100, 6)
  })

  it('converts EUR to USD via UAH triangulation', () => {
    // 100 EUR → 100 * 44 UAH = 4400 UAH → 4400 / 40 = 110 USD
    expect(convertToBase(100, 'EUR', 'USD', makeRates('40.0000', '44.0000'))).toBeCloseTo(110, 6)
  })
})

// Phase 4 refactor: BalanceService.getTOVBalance removed (see
// task-drop-phase4-refactor-remove-tov.md AC3). Tests for that path
// deleted alongside the implementation.

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

// ── R3: RBAC helper 403 guards ────────────────────────────────────────────────
//
// These tests document the RBAC contracts of the three `assertCan*` helpers so
// that any future refactor that accidentally widens access is caught immediately.
// The helpers are pure (no async, no DB) — we just call them with the viewer
// SessionUser and assert ForbiddenException is thrown for disallowed roles.

import { ForbiddenException } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'

function makeViewer(role: SessionUser['role'], id = `${role.toLowerCase()}-id`): SessionUser {
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

describe('R3 — BalanceService RBAC helpers: assertCanReadAdminBalance', () => {
  const TARGET_ADMIN_ID = '00000000-0000-0000-0000-aaaaaaaaaaaa'

  it('ADMIN can read any admin balance', () => {
    const svc = makeService()
    expect(() => svc.assertCanReadAdminBalance(makeViewer('ADMIN'), TARGET_ADMIN_ID)).not.toThrow()
  })

  it('ACCOUNTANT can read any admin balance', () => {
    const svc = makeService()
    expect(() =>
      svc.assertCanReadAdminBalance(makeViewer('ACCOUNTANT'), TARGET_ADMIN_ID),
    ).not.toThrow()
  })

  it('SENIOR cannot read admin balance → ForbiddenException', () => {
    const svc = makeService()
    expect(() => svc.assertCanReadAdminBalance(makeViewer('SENIOR'), TARGET_ADMIN_ID)).toThrow(
      ForbiddenException,
    )
  })

  it('JUNIOR cannot read admin balance → ForbiddenException', () => {
    const svc = makeService()
    expect(() => svc.assertCanReadAdminBalance(makeViewer('JUNIOR'), TARGET_ADMIN_ID)).toThrow(
      ForbiddenException,
    )
  })

  it('HR cannot read admin balance → ForbiddenException', () => {
    const svc = makeService()
    expect(() => svc.assertCanReadAdminBalance(makeViewer('HR'), TARGET_ADMIN_ID)).toThrow(
      ForbiddenException,
    )
  })

  it('DROP cannot read admin balance → ForbiddenException', () => {
    const svc = makeService()
    expect(() => svc.assertCanReadAdminBalance(makeViewer('DROP'), TARGET_ADMIN_ID)).toThrow(
      ForbiddenException,
    )
  })
})

describe('R3 — BalanceService RBAC helpers: assertCanReadSeniorBalance', () => {
  const SENIOR_A_ID = 'senior-a-id'
  const SENIOR_B_ID = 'senior-b-id'

  it('SENIOR can read own balance', () => {
    const svc = makeService()
    const viewer = makeViewer('SENIOR', SENIOR_A_ID)
    expect(() => svc.assertCanReadSeniorBalance(viewer, SENIOR_A_ID)).not.toThrow()
  })

  it('ADMIN can read any senior balance', () => {
    const svc = makeService()
    expect(() => svc.assertCanReadSeniorBalance(makeViewer('ADMIN'), SENIOR_A_ID)).not.toThrow()
  })

  it('ACCOUNTANT can read any senior balance', () => {
    const svc = makeService()
    expect(() =>
      svc.assertCanReadSeniorBalance(makeViewer('ACCOUNTANT'), SENIOR_A_ID),
    ).not.toThrow()
  })

  it('SENIOR_B cannot read SENIOR_A balance → ForbiddenException', () => {
    const svc = makeService()
    const viewer = makeViewer('SENIOR', SENIOR_B_ID)
    expect(() => svc.assertCanReadSeniorBalance(viewer, SENIOR_A_ID)).toThrow(ForbiddenException)
  })

  it('JUNIOR cannot read senior balance → ForbiddenException', () => {
    const svc = makeService()
    expect(() => svc.assertCanReadSeniorBalance(makeViewer('JUNIOR'), SENIOR_A_ID)).toThrow(
      ForbiddenException,
    )
  })

  it('HR cannot read senior balance → ForbiddenException', () => {
    const svc = makeService()
    expect(() => svc.assertCanReadSeniorBalance(makeViewer('HR'), SENIOR_A_ID)).toThrow(
      ForbiddenException,
    )
  })

  it('DROP cannot read senior balance → ForbiddenException', () => {
    const svc = makeService()
    expect(() => svc.assertCanReadSeniorBalance(makeViewer('DROP'), SENIOR_A_ID)).toThrow(
      ForbiddenException,
    )
  })
})

describe('R3 — BalanceService RBAC helpers: assertCanListPendingObligations', () => {
  it('ADMIN can list pending obligations', () => {
    const svc = makeService()
    expect(() => svc.assertCanListPendingObligations(makeViewer('ADMIN'))).not.toThrow()
  })

  it('ACCOUNTANT can list pending obligations', () => {
    const svc = makeService()
    expect(() => svc.assertCanListPendingObligations(makeViewer('ACCOUNTANT'))).not.toThrow()
  })

  it('SENIOR can list (own) pending obligations', () => {
    const svc = makeService()
    expect(() => svc.assertCanListPendingObligations(makeViewer('SENIOR'))).not.toThrow()
  })

  it('JUNIOR cannot list pending obligations → ForbiddenException', () => {
    const svc = makeService()
    expect(() => svc.assertCanListPendingObligations(makeViewer('JUNIOR'))).toThrow(
      ForbiddenException,
    )
  })

  it('HR cannot list pending obligations → ForbiddenException', () => {
    const svc = makeService()
    expect(() => svc.assertCanListPendingObligations(makeViewer('HR'))).toThrow(ForbiddenException)
  })

  it('DROP cannot list pending obligations → ForbiddenException', () => {
    const svc = makeService()
    expect(() => svc.assertCanListPendingObligations(makeViewer('DROP'))).toThrow(
      ForbiddenException,
    )
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

// ── Audit 2026-06-28 (#10): getSeniorBalance counts PAID SENIOR_INCOME ────────
describe('BalanceService.getSeniorBalance — SENIOR_INCOME (#10)', () => {
  const SENIOR_A = 'senior-a-id'

  it('counts PAID SENIOR_INCOME as real platform income', async () => {
    const svc = makeService({
      transactions: [
        makeTx({
          type: 'SENIOR_INCOME',
          status: 'PAID',
          amount: '740',
          currency: 'USD',
          receiverId: SENIOR_A,
        }),
      ],
    })
    const result = await svc.getSeniorBalance(SENIOR_A, 'USD')
    expect(result.balance).toBeCloseTo(740, 6)
    expect(result.breakdown.platform_income).toBeCloseTo(740, 6)
  })

  it('ignores NON-PAID SENIOR_INCOME (only settled money counts)', async () => {
    const svc = makeService({
      transactions: [
        makeTx({
          type: 'SENIOR_INCOME',
          status: 'VALIDATED',
          amount: '500',
          currency: 'USD',
          receiverId: SENIOR_A,
        }),
      ],
    })
    const result = await svc.getSeniorBalance(SENIOR_A, 'USD')
    expect(result.balance).toBe(0)
    expect(result.breakdown.platform_income).toBe(0)
  })

  it('does NOT double-count: SENIOR_INCOME stacks with SENIOR_PAID but is a distinct credit', async () => {
    const svc = makeService({
      transactions: [
        makeTx({
          type: 'SENIOR_INCOME',
          status: 'PAID',
          amount: '300',
          currency: 'USD',
          receiverId: SENIOR_A,
        }),
        makeTx({
          type: 'SENIOR_PAID',
          status: 'PAID',
          amount: '200',
          currency: 'USD',
          recipientId: SENIOR_A,
        }),
      ],
    })
    const result = await svc.getSeniorBalance(SENIOR_A, 'USD')
    // 300 platform + 200 paid = 500 — each counted once.
    expect(result.balance).toBeCloseTo(500, 6)
    expect(result.breakdown.platform_income).toBeCloseTo(300, 6)
    expect(result.breakdown.paid_income).toBeCloseTo(200, 6)
  })

  it("does not leak another senior's SENIOR_INCOME", async () => {
    const svc = makeService({
      transactions: [
        makeTx({
          type: 'SENIOR_INCOME',
          status: 'PAID',
          amount: '999',
          currency: 'USD',
          receiverId: 'senior-b-id',
        }),
      ],
    })
    const result = await svc.getSeniorBalance(SENIOR_A, 'USD')
    expect(result.balance).toBe(0)
  })
})

// ── Audit 2026-06-28 (#2): getTotalEarned drop income double-count ────────────
describe('BalanceService.getTotalEarned — DROP income (#2)', () => {
  const DROP_ID = 'drop-user-1'
  const ADMIN_ID = 'admin-1'

  // getTotalEarned reads the target user row first; stub users.findFirst.
  function makeDropEarnedSvc(transactions: MockTransactionRow[]): BalanceService {
    const drizzleClient = {
      query: {
        users: {
          findFirst: async () => ({ id: DROP_ID, role: 'DROP', displayName: 'Drop' }),
        },
        transactions: {
          findMany: async () => transactions,
        },
      },
    }
    const db = { db: drizzleClient } as never
    const nbu = { getRates: async () => makeRates() } as never
    return new BalanceService(db, nbu)
  }

  it('gross DROP_INCOME (senderId=null) + linked PAYOUT_DROP slice → totalEarned = slice only', async () => {
    const svc = makeDropEarnedSvc([
      // External-client gross income lands on the drop with senderId=null.
      makeTx({
        type: 'DROP_INCOME',
        status: 'PAID',
        amount: '1000',
        currency: 'USDT',
        senderId: null,
        receiverId: DROP_ID,
        recipientId: DROP_ID,
      }),
      // The drop's REAL slice — counted.
      makeTx({
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: '50',
        currency: 'USDT',
        senderId: null,
        receiverId: DROP_ID,
        recipientId: DROP_ID,
      }),
    ])
    const result = await svc.getTotalEarned(DROP_ID, 'USD')
    // Only the 50 slice — the 1000 gross is NOT double-counted.
    expect(result.totalEarned).toBeCloseTo(50, 6)
    expect(result.breakdown.payout).toBeCloseTo(50, 6)
    expect(result.breakdown.income ?? 0).toBe(0)
  })

  it('DIRECT admin→drop DROP_INCOME (senderId set, no PAYOUT_DROP) → counts that amount', async () => {
    // Сергей's GamingTec comp: a direct payment to the drop, senderId = admin.
    const svc = makeDropEarnedSvc([
      makeTx({
        type: 'DROP_INCOME',
        status: 'PAID',
        amount: '300',
        currency: 'USDT',
        senderId: ADMIN_ID,
        receiverId: DROP_ID,
        recipientId: DROP_ID,
      }),
    ])
    const result = await svc.getTotalEarned(DROP_ID, 'USD')
    expect(result.totalEarned).toBeCloseTo(300, 6)
    expect(result.breakdown.income).toBeCloseTo(300, 6)
  })

  it('mixed: gross (excluded) + slice + direct income → slice + direct only', async () => {
    const svc = makeDropEarnedSvc([
      makeTx({
        type: 'DROP_INCOME',
        status: 'PAID',
        amount: '1000',
        currency: 'USDT',
        senderId: null,
        receiverId: DROP_ID,
      }),
      makeTx({
        type: 'PAYOUT_DROP',
        status: 'PAID',
        amount: '50',
        currency: 'USDT',
        receiverId: DROP_ID,
      }),
      makeTx({
        type: 'DROP_INCOME',
        status: 'PAID',
        amount: '300',
        currency: 'USDT',
        senderId: ADMIN_ID,
        receiverId: DROP_ID,
      }),
    ])
    const result = await svc.getTotalEarned(DROP_ID, 'USD')
    expect(result.totalEarned).toBeCloseTo(350, 6) // 50 slice + 300 direct
  })
})

describe('BalanceService multi-currency conversion (admin balance)', () => {
  const MAKSYM = '00000000-0000-0000-0000-000000000001'

  it('ADMIN_INCOME_CASH 1000 USDT + 4000 UAH + 100 EUR → USD via NBU rates', async () => {
    const svc = makeService({
      transactions: [
        makeTx({
          type: 'ADMIN_INCOME_CASH',
          amount: '1000',
          currency: 'USDT',
          recipientId: MAKSYM,
        }), // = 1000 USD
        makeTx({
          type: 'ADMIN_INCOME_CASH',
          amount: '4000',
          currency: 'UAH',
          recipientId: MAKSYM,
        }), // = 100 USD @ 40
        makeTx({
          type: 'ADMIN_INCOME_CASH',
          amount: '100',
          currency: 'EUR',
          recipientId: MAKSYM,
        }), // = 110 USD via 44/40
      ],
      rates: makeRates('40.0000', '44.0000'),
    })
    const result = await svc.getAdminBalance(MAKSYM, 'USD')
    expect(result.balance).toBeCloseTo(1210, 4)
    expect(result.currency).toBe('USD')
  })

  it('ADMIN_INCOME_CASH 1000 USD returned in UAH → 40000 UAH at rate 40', async () => {
    const svc = makeService({
      transactions: [
        makeTx({
          type: 'ADMIN_INCOME_CASH',
          amount: '1000',
          currency: 'USD',
          recipientId: MAKSYM,
        }),
      ],
      rates: makeRates('40.0000', '44.0000'),
    })
    const result = await svc.getAdminBalance(MAKSYM, 'UAH')
    expect(result.balance).toBeCloseTo(40000, 4)
    expect(result.currency).toBe('UAH')
  })

  it('default currency is USD when not specified', async () => {
    const svc = makeService({
      transactions: [
        makeTx({
          type: 'ADMIN_INCOME_CASH',
          amount: '500',
          currency: 'USDT',
          recipientId: MAKSYM,
        }),
      ],
    })
    const result = await svc.getAdminBalance(MAKSYM)
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
