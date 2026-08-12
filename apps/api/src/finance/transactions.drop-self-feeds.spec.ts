/**
 * Unit tests for the drop self-view feeds added in task-drop-2-backend:
 *   - TransactionsService.getDropSelfIncomes  (GET /finance/drop/me/incomes)
 *   - TransactionsService.getDropSelfPayments (GET /finance/drop/me/payments)
 *
 * Coverage:
 *  RBAC (self-only): every non-DROP role → 403 on both feeds.
 *  Incomes: status mapping (DB → FE) for BOTH income models (task-drop-sees-
 *    own-obligations: DROP_INCOME declared vs DROP_PENDING_PAYOUT/PAYOUT_DROP
 *    obligation, discriminated by `model`), companyName resolution
 *    (senderLabel → project.companyName → '' for declared;
 *    project.companyName → '' for obligation — `senderLabel` on an obligation
 *    row is always the literal 'COMPANY' marker, never a real company name),
 *    status filter, from/to date-window filter, pagination (page/limit slice
 *    + total before slice), createdAt ISO.
 *  Payments: status mapping (PENDING_PAYMENT→pending, PAID→confirmed,
 *    REJECTED→failed), txHash present/absent, amount parse, ISO createdAt.
 *
 * Pure stub for DatabaseService — no Postgres. The DB-level self-scope
 * (receiverId/senderId/type WHERE clauses) is pinned by the real-DB
 * integration spec (drop.rbac.integration.spec.ts), since the stub's findMany
 * ignores the `where` argument by design — these tests target the in-memory
 * mapping / filter / pagination logic the WHERE clause cannot cover.
 */
import { ForbiddenException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import type { DropIncomesQuery, SessionUser } from '@crm/shared'
import { dropIncomesQuerySchema } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'

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

const DROP_ID = 'drop-A'

type IncomeRow = {
  id: string
  type: string
  status: string
  amount: string
  currency: string
  senderLabel: string | null
  receiverId: string | null
  txHash?: string | null
  createdAt: Date
  project?: { companyName: string } | null
}

/** TransactionsService whose `transactions.findMany` returns the supplied rows. */
function makeSvc(rows: unknown[]) {
  const dbStub = {
    db: {
      query: {
        transactions: {
          findMany: () => Promise.resolve(rows),
        },
      },
    },
  }
  return makeTransactionsService({ db: dbStub as never })
}

function q(overrides: Partial<DropIncomesQuery> = {}): DropIncomesQuery {
  return dropIncomesQuerySchema.parse(overrides)
}

const forbiddenRoles: SessionUser['role'][] = ['SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'ADMIN']

// ── getDropSelfIncomes ───────────────────────────────────────────────────────

describe('getDropSelfIncomes — RBAC (self-only)', () => {
  for (const role of forbiddenRoles) {
    it(`throws ForbiddenException for role ${role}`, async () => {
      const svc = makeSvc([])
      await expect(svc.getDropSelfIncomes(user(role), q())).rejects.toBeInstanceOf(
        ForbiddenException,
      )
    })
  }

  it('DROP → resolves a paginated envelope', async () => {
    const svc = makeSvc([])
    const res = await svc.getDropSelfIncomes(user('DROP', DROP_ID), q())
    expect(res).toEqual({ items: [], total: 0, page: 1, limit: 20 })
  })
})

function income(overrides: Partial<IncomeRow> = {}): IncomeRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    type: 'DROP_INCOME',
    status: 'PENDING',
    amount: '1000',
    currency: 'USDT',
    senderLabel: 'TechCorp',
    receiverId: DROP_ID,
    createdAt: new Date('2026-06-12T10:00:00.000Z'),
    project: { companyName: 'TechCorp Project' },
    ...overrides,
  }
}

describe('getDropSelfIncomes — status mapping', () => {
  const cases: Array<[string, string]> = [
    ['PENDING', 'pending'],
    ['VALIDATED', 'validated'],
    ['PAID', 'paid'],
    ['REJECTED', 'rejected'],
  ]
  for (const [db, fe] of cases) {
    it(`maps DB ${db} → ${fe}`, async () => {
      const svc = makeSvc([income({ status: db })])
      const res = await svc.getDropSelfIncomes(user('DROP', DROP_ID), q())
      expect(res.items[0]!.status).toBe(fe)
    })
  }

  it('maps an unexpected DB status defensively to pending (never leaks the enum)', async () => {
    const svc = makeSvc([income({ status: 'LOCKED' })])
    const res = await svc.getDropSelfIncomes(user('DROP', DROP_ID), q())
    expect(res.items[0]!.status).toBe('pending')
  })
})

describe('getDropSelfIncomes — companyName resolution', () => {
  it('uses senderLabel when present', async () => {
    const svc = makeSvc([income({ senderLabel: 'AcmeCo', project: { companyName: 'Other' } })])
    const res = await svc.getDropSelfIncomes(user('DROP', DROP_ID), q())
    expect(res.items[0]!.companyName).toBe('AcmeCo')
  })

  it('falls back to project.companyName when senderLabel is null', async () => {
    const svc = makeSvc([income({ senderLabel: null, project: { companyName: 'ProjectCo' } })])
    const res = await svc.getDropSelfIncomes(user('DROP', DROP_ID), q())
    expect(res.items[0]!.companyName).toBe('ProjectCo')
  })

  it("falls back to '' when neither senderLabel nor project present", async () => {
    const svc = makeSvc([income({ senderLabel: null, project: null })])
    const res = await svc.getDropSelfIncomes(user('DROP', DROP_ID), q())
    expect(res.items[0]!.companyName).toBe('')
  })
})

// task-drop-sees-own-obligations: the feed's second model — a company-booked
// IOU (DROP_PENDING_PAYOUT, later settled IN PLACE to PAYOUT_DROP). Same
// factory shape as `income()` but `senderLabel` is always the literal
// 'COMPANY' marker `bookCompanyObligations` stamps — never a real company name.
function obligationRow(overrides: Partial<IncomeRow> = {}): IncomeRow {
  return {
    id: '00000000-0000-4000-8000-000000000002',
    type: 'DROP_PENDING_PAYOUT',
    status: 'PENDING_PAYMENT',
    amount: '800.48',
    currency: 'USDT',
    senderLabel: 'COMPANY',
    receiverId: DROP_ID,
    createdAt: new Date('2026-08-12T09:00:00.000Z'),
    project: { companyName: 'GamingTec' },
    ...overrides,
  }
}

describe('getDropSelfIncomes — model discriminator (§AC3)', () => {
  it('a DROP_INCOME row carries model="declared"', async () => {
    const svc = makeSvc([income()])
    const res = await svc.getDropSelfIncomes(user('DROP', DROP_ID), q())
    expect(res.items[0]!.model).toBe('declared')
  })

  it('a DROP_PENDING_PAYOUT row carries model="obligation"', async () => {
    const svc = makeSvc([obligationRow()])
    const res = await svc.getDropSelfIncomes(user('DROP', DROP_ID), q())
    expect(res.items[0]!.model).toBe('obligation')
  })

  it('a settled PAYOUT_DROP row ALSO carries model="obligation" (same row, flipped in place)', async () => {
    const svc = makeSvc([obligationRow({ type: 'PAYOUT_DROP', status: 'PAID' })])
    const res = await svc.getDropSelfIncomes(user('DROP', DROP_ID), q())
    expect(res.items[0]!.model).toBe('obligation')
    expect(res.items[0]!.status).toBe('paid')
  })

  it('BOTH models are returned together, each keeping its own discriminator (§AC3)', async () => {
    const svc = makeSvc([income(), obligationRow()])
    const res = await svc.getDropSelfIncomes(user('DROP', DROP_ID), q())
    expect(res.total).toBe(2)
    const models = res.items.map((i) => i.model).sort()
    expect(models).toEqual(['declared', 'obligation'])
  })

  // §AC4: exact-cent parity with the booked amount — no rounding drift.
  it('obligation amount matches the booked figure to the cent (§AC4)', async () => {
    const svc = makeSvc([obligationRow({ amount: '800.48' })])
    const res = await svc.getDropSelfIncomes(user('DROP', DROP_ID), q())
    expect(res.items[0]!.amount).toBe(800.48)
  })
})

describe('getDropSelfIncomes — obligation status mapping', () => {
  const cases: Array<[string, string]> = [
    ['PENDING_PAYMENT', 'pending'],
    ['REJECTED', 'rejected'],
  ]
  for (const [db, fe] of cases) {
    it(`DROP_PENDING_PAYOUT maps DB ${db} → ${fe}`, async () => {
      const svc = makeSvc([obligationRow({ status: db })])
      const res = await svc.getDropSelfIncomes(user('DROP', DROP_ID), q())
      expect(res.items[0]!.status).toBe(fe)
    })
  }

  it('PAYOUT_DROP maps DB PAID → paid', async () => {
    const svc = makeSvc([obligationRow({ type: 'PAYOUT_DROP', status: 'PAID' })])
    const res = await svc.getDropSelfIncomes(user('DROP', DROP_ID), q())
    expect(res.items[0]!.status).toBe('paid')
  })

  it('an obligation row never resolves to "validated" (declared-only state)', async () => {
    // Defensive: even an unexpected DB status on an obligation row must never
    // surface the DROP_INCOME-only 'validated' state.
    const svc = makeSvc([obligationRow({ status: 'VALIDATED' })])
    const res = await svc.getDropSelfIncomes(user('DROP', DROP_ID), q())
    expect(res.items[0]!.status).not.toBe('validated')
  })

  it("companyName uses project.companyName, NEVER the 'COMPANY' senderLabel marker", async () => {
    const svc = makeSvc([
      obligationRow({ senderLabel: 'COMPANY', project: { companyName: 'GamingTec' } }),
    ])
    const res = await svc.getDropSelfIncomes(user('DROP', DROP_ID), q())
    expect(res.items[0]!.companyName).toBe('GamingTec')
  })

  it("companyName falls back to '' when the project link is gone", async () => {
    const svc = makeSvc([obligationRow({ project: null })])
    const res = await svc.getDropSelfIncomes(user('DROP', DROP_ID), q())
    expect(res.items[0]!.companyName).toBe('')
  })
})

describe('getDropSelfIncomes — mapping fields', () => {
  it('parses amount to number, currency passthrough, createdAt ISO', async () => {
    const svc = makeSvc([income({ amount: '1500.50', currency: 'USD' })])
    const res = await svc.getDropSelfIncomes(user('DROP', DROP_ID), q())
    expect(res.items[0]!.amount).toBe(1500.5)
    expect(res.items[0]!.currency).toBe('USD')
    expect(res.items[0]!.createdAt).toBe('2026-06-12T10:00:00.000Z')
  })
})

describe('getDropSelfIncomes — status filter', () => {
  it('returns only rows matching the requested mapped status', async () => {
    const svc = makeSvc([
      income({ id: '00000000-0000-4000-8000-00000000000a', status: 'PENDING' }),
      income({ id: '00000000-0000-4000-8000-00000000000b', status: 'VALIDATED' }),
      income({ id: '00000000-0000-4000-8000-00000000000c', status: 'VALIDATED' }),
    ])
    const res = await svc.getDropSelfIncomes(user('DROP', DROP_ID), q({ status: 'validated' }))
    expect(res.total).toBe(2)
    expect(res.items.every((i) => i.status === 'validated')).toBe(true)
  })
})

describe('getDropSelfIncomes — date-window filter', () => {
  const rows = [
    income({
      id: '00000000-0000-4000-8000-000000000010',
      createdAt: new Date('2026-05-01T00:00:00Z'),
    }),
    income({
      id: '00000000-0000-4000-8000-000000000011',
      createdAt: new Date('2026-06-15T00:00:00Z'),
    }),
    income({
      id: '00000000-0000-4000-8000-000000000012',
      createdAt: new Date('2026-07-01T00:00:00Z'),
    }),
  ]

  it('from bound (inclusive lower)', async () => {
    const svc = makeSvc(rows)
    const res = await svc.getDropSelfIncomes(user('DROP', DROP_ID), q({ from: '2026-06-01' }))
    expect(res.total).toBe(2)
  })

  it('to bound (excludes later)', async () => {
    const svc = makeSvc(rows)
    const res = await svc.getDropSelfIncomes(user('DROP', DROP_ID), q({ to: '2026-06-30' }))
    expect(res.total).toBe(2)
  })

  it('from + to window', async () => {
    const svc = makeSvc(rows)
    const res = await svc.getDropSelfIncomes(
      user('DROP', DROP_ID),
      q({ from: '2026-06-01', to: '2026-06-30' }),
    )
    expect(res.total).toBe(1)
    expect(res.items[0]!.id).toBe('00000000-0000-4000-8000-000000000011')
  })

  it('to bound includes incomes at noon on the last day (non-midnight timestamps)', async () => {
    // Regression for MED review finding code-review-2: Date.parse('YYYY-MM-DD')
    // returns midnight UTC, so incomes at 12:00 on the `to` day were previously
    // dropped. The fix adds 86_399_999 ms to cover the full calendar day.
    const noonOnToDay = new Date('2026-06-15T12:30:00Z') // same day as rows[1]
    const rowsWithNoon = [
      income({
        id: '00000000-0000-4000-8000-000000000020',
        createdAt: new Date('2026-05-01T00:00:00Z'),
      }),
      income({
        id: '00000000-0000-4000-8000-000000000021',
        createdAt: noonOnToDay,
      }),
    ]
    const svc = makeSvc(rowsWithNoon)
    const res = await svc.getDropSelfIncomes(
      user('DROP', DROP_ID),
      q({ to: '2026-06-15' }), // last day is 2026-06-15 — noon must be INCLUDED
    )
    expect(res.total).toBe(2)
    expect(res.items.some((i) => i.id === '00000000-0000-4000-8000-000000000021')).toBe(true)
  })
})

describe('getDropSelfIncomes — pagination', () => {
  const rows = Array.from({ length: 25 }, (_, i) =>
    income({
      id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`,
      // distinct createdAt so ordering by the DB (here: input order) is stable
      createdAt: new Date(2026, 5, 1, 0, i, 0),
    }),
  )

  it('page 1 limit 10 → 10 items, total = 25', async () => {
    const svc = makeSvc(rows)
    const res = await svc.getDropSelfIncomes(user('DROP', DROP_ID), q({ page: 1, limit: 10 }))
    expect(res.items).toHaveLength(10)
    expect(res.total).toBe(25)
    expect(res.page).toBe(1)
    expect(res.limit).toBe(10)
  })

  it('page 3 limit 10 → last 5 items', async () => {
    const svc = makeSvc(rows)
    const res = await svc.getDropSelfIncomes(user('DROP', DROP_ID), q({ page: 3, limit: 10 }))
    expect(res.items).toHaveLength(5)
    expect(res.total).toBe(25)
  })

  it('page beyond range → empty items, total unchanged', async () => {
    const svc = makeSvc(rows)
    const res = await svc.getDropSelfIncomes(user('DROP', DROP_ID), q({ page: 99, limit: 10 }))
    expect(res.items).toHaveLength(0)
    expect(res.total).toBe(25)
  })
})

// ── getDropSelfPayments ──────────────────────────────────────────────────────

type PaymentRow = {
  id: string
  type: string
  status: string
  amount: string
  currency: string
  senderId: string | null
  txHash: string | null
  createdAt: Date
}

function payment(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: '00000000-0000-4000-8000-000000000201',
    type: 'PAYOUT',
    status: 'PENDING_PAYMENT',
    amount: '950',
    currency: 'USDT',
    senderId: DROP_ID,
    txHash: null,
    createdAt: new Date('2026-06-12T10:00:00.000Z'),
    ...overrides,
  }
}

describe('getDropSelfPayments — RBAC (self-only)', () => {
  for (const role of forbiddenRoles) {
    it(`throws ForbiddenException for role ${role}`, async () => {
      const svc = makeSvc([])
      await expect(svc.getDropSelfPayments(user(role))).rejects.toBeInstanceOf(ForbiddenException)
    })
  }

  it('DROP → resolves an array', async () => {
    const svc = makeSvc([])
    const res = await svc.getDropSelfPayments(user('DROP', DROP_ID))
    expect(res).toEqual([])
  })
})

describe('getDropSelfPayments — status mapping', () => {
  const cases: Array<[string, string]> = [
    ['PENDING_PAYMENT', 'pending'],
    ['PAID', 'confirmed'],
    ['REJECTED', 'failed'],
    // Phase 4-B cash-payment gate: explicit case in mapDropPaymentStatus.
    // Fix: MED security finding — was previously falling through silent default.
    ['PENDING_CASH_CONFIRM', 'pending'],
  ]
  for (const [db, fe] of cases) {
    it(`maps DB ${db} → ${fe}`, async () => {
      const svc = makeSvc([payment({ status: db })])
      const res = await svc.getDropSelfPayments(user('DROP', DROP_ID))
      expect(res[0]!.status).toBe(fe)
    })
  }

  it('maps an unexpected DB status defensively to pending', async () => {
    const svc = makeSvc([payment({ status: 'LOCKED' })])
    const res = await svc.getDropSelfPayments(user('DROP', DROP_ID))
    expect(res[0]!.status).toBe('pending')
  })
})

describe('getDropSelfPayments — mapping fields', () => {
  it('omits txHash when null', async () => {
    const svc = makeSvc([payment({ txHash: null })])
    const res = await svc.getDropSelfPayments(user('DROP', DROP_ID))
    expect(res[0]!.txHash).toBeUndefined()
    expect('txHash' in res[0]!).toBe(false)
  })

  it('includes txHash when present', async () => {
    const svc = makeSvc([payment({ txHash: '0xabc123', status: 'PAID' })])
    const res = await svc.getDropSelfPayments(user('DROP', DROP_ID))
    expect(res[0]!.txHash).toBe('0xabc123')
  })

  it('parses amount, passes currency, ISO createdAt', async () => {
    const svc = makeSvc([payment({ amount: '2300.25', currency: 'USD' })])
    const res = await svc.getDropSelfPayments(user('DROP', DROP_ID))
    expect(res[0]!.amount).toBe(2300.25)
    expect(res[0]!.currency).toBe('USD')
    expect(res[0]!.createdAt).toBe('2026-06-12T10:00:00.000Z')
  })
})
