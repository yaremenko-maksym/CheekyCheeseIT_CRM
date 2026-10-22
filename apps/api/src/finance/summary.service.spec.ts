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
 * Figure-level math (totals, balances, USD conversion, compliance counters,
 * query predicates) is pinned in the second half of this file against hand-computed
 * literals — the mutation gate sees unit specs only, so the integration specs
 * cannot be its oracle. The existing accountant-summary*, senior-summary*,
 * income-compliance* and transactions.get-summary specs remain as the
 * through-the-delegates characterisation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SessionUser } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { collectParamValues, compileWhere } from './__test-helpers__/drizzle-where-introspection'
import { nonDeletedTransactions, pendingObligations, visibleProjects } from '../database/schema'
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

// ════════════════════════════════════════════════════════════════════════════
// Figure-level unit-double coverage (T-L8 mutation gate).
//
// The mutation gate runs the UNIT suite only and cannot see the
// `*.integration.spec.ts` files that used to be the sole characterisation of the
// summary math (see .claude/rules/common/mutation-gate-integration-specs.md).
// These tests construct SummaryService DIRECTLY over a hand-rolled
// DatabaseService double and assert hand-computed literals (the oracle is the
// scenarios of accountant-summary*, senior-summary.unit, income-compliance.unit
// and transactions.get-summary specs, mirrored here against SummaryService).
// ════════════════════════════════════════════════════════════════════════════

type Row = Record<string, unknown>

const RATES = { usdUah: '40', usdtUah: '40', eurUah: '50', date: '2026-06-28' }

interface DbData {
  txs?: Row[]
  admins?: Row[]
  drops?: Row[]
  owners?: Row[]
  closingIds?: unknown[]
  projects?: Row[]
  selfUser?: Row | undefined
  payouts?: Row[]
  salaryRows?: Row[]
  accountantRows?: Row[]
  teamMembers?: Row[]
}

function makeDb(data: DbData = {}) {
  const cap = {
    txFindMany: [] as Array<{ where?: unknown; columns?: unknown }>,
    usersFindMany: [] as Array<{ params: unknown[]; columns?: unknown }>,
    usersFindFirst: [] as Array<{ where?: unknown }>,
    payoutsFindMany: [] as Array<{ where?: unknown }>,
    pendingSelectArg: undefined as unknown,
    salaryWhere: undefined as unknown,
    accountantSelectArg: undefined as unknown,
    accountantWhere: undefined as unknown,
  }
  const db = {
    query: {
      transactions: {
        findMany: (args?: { where?: unknown; columns?: unknown }) => {
          cap.txFindMany.push({ where: args?.where, columns: args?.columns })
          return Promise.resolve(data.txs ?? [])
        },
      },
      users: {
        findMany: (args?: { where?: unknown; columns?: unknown }) => {
          const params = collectParamValues(args?.where)
          cap.usersFindMany.push({ params, columns: args?.columns })
          if (params.includes('ADMIN')) return Promise.resolve(data.admins ?? [])
          if (params.includes('DROP')) return Promise.resolve(data.drops ?? [])
          return Promise.resolve(data.owners ?? [])
        },
        findFirst: (args?: { where?: unknown }) => {
          cap.usersFindFirst.push({ where: args?.where })
          return Promise.resolve(data.selfUser)
        },
      },
      payoutRequests: {
        findMany: (args?: { where?: unknown }) => {
          cap.payoutsFindMany.push({ where: args?.where })
          return Promise.resolve(data.payouts ?? [])
        },
      },
      teamMembers: { findMany: () => Promise.resolve(data.teamMembers ?? []) },
    },
    select: (arg?: unknown) => ({
      from: (table: unknown) => {
        if (table === pendingObligations) {
          cap.pendingSelectArg = arg
          return { where: () => Promise.resolve((data.closingIds ?? []).map((id) => ({ id }))) }
        }
        if (table === visibleProjects) {
          const rows = data.projects ?? []
          return Object.assign(Promise.resolve(rows), {
            where: () => ({ orderBy: () => Promise.resolve(rows) }),
          })
        }
        if (table === nonDeletedTransactions) {
          return {
            where: (w: unknown) => {
              cap.salaryWhere = w
              return Promise.resolve(data.salaryRows ?? [])
            },
          }
        }
        cap.accountantSelectArg = arg
        return {
          where: (w: unknown) => {
            cap.accountantWhere = w
            return Promise.resolve(data.accountantRows ?? [])
          },
        }
      },
    }),
  }
  const nbu = { getRates: vi.fn().mockResolvedValue(RATES) }
  const svc = new SummaryService({ db } as never, nbu as never)
  return { svc, cap }
}

afterEach(() => {
  vi.useRealTimers()
})

function freeze(iso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(iso))
}

// ── getSummary ──────────────────────────────────────────────────────────────

let seq = 0
function stx(o: Row & { type: string }): Row {
  seq += 1
  return {
    id: `tx-${seq}`,
    status: 'PAID',
    amount: '0',
    currency: 'USD',
    senderId: null,
    receiverId: null,
    fundingSource: null,
    txDate: null,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    sender: null,
    receiver: null,
    project: null,
    ...o,
  }
}

const ADMINS = [
  { id: 'a1', displayName: 'Alice', role: 'ADMIN' },
  { id: 'a2', displayName: 'Bob', role: 'ADMIN' },
]

function mainLedger(): Row[] {
  return [
    stx({ type: 'ADMIN_INCOME', amount: '1000', receiverId: 'a1' }),
    stx({
      type: 'ADMIN_INCOME',
      amount: '400',
      receiverId: 'a2',
      fundingSource: 'COMPANY_ACCOUNT',
    }),
    stx({
      id: 'sen-real',
      type: 'SENIOR_INCOME',
      amount: '300',
      txDate: new Date('2026-05-10T00:00:00Z'),
    }),
    stx({ id: 'settle-1', type: 'SENIOR_INCOME', amount: '260' }),
    stx({ id: '', type: 'SENIOR_INCOME', amount: '50' }),
    stx({ type: 'DROP_INCOME', amount: '4', currency: 'EUR', receiverId: 'd0' }),
    stx({ type: 'EXPENSE', amount: '120.5', senderId: 'a1' }),
    stx({ type: 'EXPENSE', status: 'PENDING', amount: '999' }),
    stx({ type: 'SALARY', amount: '80.25', senderId: 'a2', receiverId: 'jr' }),
    stx({ type: 'PAYOUT_ADMIN', amount: '70', receiverId: 'a2' }),
    stx({ type: 'ADMIN_TRANSFER', amount: '30', senderId: 'a1', receiverId: 'a2' }),
    stx({ type: 'PAYOUT_CONFIRMED', amount: '10', receiverId: 'a1' }),
    stx({ type: 'PAYOUT', amount: '5', receiverId: 'a1' }),
    stx({ type: 'PAYOUT_ADMIN', status: 'PENDING', amount: '100', receiverId: 'a1' }),
    stx({
      type: 'ADMIN_INCOME',
      amount: '4000',
      currency: 'UAH',
      receiverId: 'a2',
      txDate: new Date('2026-04-02T00:00:00Z'),
    }),
  ]
}

describe('SummaryService.getSummary — figures (hand-computed literals)', () => {
  it('totals, net balance, admin HOLDING balances and the monthly series', async () => {
    const { svc, cap } = makeDb({
      txs: mainLedger(),
      admins: ADMINS,
      closingIds: [null, '', 'settle-1'],
    })
    const r = await svc.getSummary(user('ADMIN'))

    // income: 1000 + 400 + 300 + 50 ('' id is NOT a settlement) + 5 (4 EUR*50/40)
    //         + 100 (4000 UAH/40); the 260 settlement slice is excluded.
    expect(r.totalIncome).toBe(1855)
    expect(r.totalExpenses).toBe(120.5) // the PENDING 999 is ignored
    expect(r.totalSalaries).toBe(80.25)
    expect(r.netBalance).toBe(1654.25)

    // a1 received 1000 + 10 (PAYOUT_CONFIRMED) ; sent 120.5 + 30
    // a2 received 70 + 30 + 100 (COMPANY_ACCOUNT 400 excluded) ; sent 80.25
    expect(r.adminBalances).toEqual([
      { userId: 'a1', displayName: 'Alice', balance: 859.5 },
      { userId: 'a2', displayName: 'Bob', balance: 119.75 },
    ])
    expect(r.dropBalances).toEqual([])

    // months are emitted sorted ascending although the ledger starts in June
    expect(r.monthly).toEqual([
      { month: '2026-04', income: 100, expenses: 0, salaries: 0, profit: 100 },
      { month: '2026-05', income: 300, expenses: 0, salaries: 0, profit: 300 },
      { month: '2026-06', income: 1455, expenses: 120.5, salaries: 80.25, profit: 1254.25 },
    ])

    // the closing-transaction lookup selects exactly the `id` column
    expect(Object.keys(cap.pendingSelectArg as object)).toEqual(['id'])
    // role-scoped user reads bind the exact role literal
    expect(cap.usersFindMany.map((c) => c.params)).toEqual([['ADMIN'], ['DROP']])
    // the ledger read is soft-delete scoped
    expect(compileWhere(cap.txFindMany[0]!.where).sql).toContain('"deleted_at" is null')
  })

  it('ACCOUNTANT sees admin balances, never queries DROP users and gets no drop balances', async () => {
    const { svc, cap } = makeDb({
      txs: [stx({ type: 'PAYOUT_ADMIN', amount: '500', receiverId: 'a1' })],
      admins: [ADMINS[0]!],
      drops: [{ id: 'd1', displayName: 'Dan', dropSharePercent: 7 }],
    })
    const r = await svc.getSummary(user('ACCOUNTANT'))
    expect(r.adminBalances).toEqual([{ userId: 'a1', displayName: 'Alice', balance: 500 }])
    expect(r.dropBalances).toEqual([])
    expect(cap.usersFindMany.map((c) => c.params)).toEqual([['ADMIN']])
  })

  it('maps drop aggregates to the admin-summary shape (no debtToCompany)', async () => {
    const { svc } = makeDb({
      txs: [
        stx({ type: 'PAYOUT_DROP', amount: '50', currency: 'USDT', receiverId: 'd1' }),
        stx({ type: 'DROP_INCOME', status: 'PENDING', amount: '500', receiverId: 'd1' }),
      ],
      drops: [{ id: 'd1', displayName: 'Dan', dropSharePercent: 7 }],
    })
    const r = await svc.getSummary(user('ADMIN'))
    expect(r.dropBalances).toEqual([
      { userId: 'd1', displayName: 'Dan', balance: 50, dropSharePercent: 7, pendingCount: 1 },
    ])
  })

  it('PAID non-income/expense/salary rows never leak into totals or the monthly series', async () => {
    const { svc } = makeDb({
      txs: [stx({ type: 'PAYOUT_ADMIN', amount: '70', receiverId: 'a1' })],
      admins: [],
    })
    const r = await svc.getSummary(user('ADMIN'))
    expect(r.totalIncome).toBe(0)
    expect(r.totalExpenses).toBe(0)
    expect(r.totalSalaries).toBe(0)
    expect(r.monthly).toEqual([
      { month: '2026-06', income: 0, expenses: 0, salaries: 0, profit: 0 },
    ])
  })

  it('sums several rows of one month and splits expenses / salaries / income per month', async () => {
    const jan = new Date('2026-01-15T00:00:00Z')
    const { svc } = makeDb({
      txs: [
        stx({ type: 'EXPENSE', amount: '10.5', createdAt: jan }),
        stx({ type: 'EXPENSE', amount: '2.25', createdAt: jan }),
        stx({ type: 'SALARY', amount: '7', createdAt: jan }),
        stx({ type: 'DROP_INCOME', amount: '40', createdAt: jan }),
        stx({ type: 'SENIOR_INCOME', amount: '3', createdAt: jan }),
      ],
      admins: [],
    })
    const r = await svc.getSummary(user('ADMIN'))
    expect(r.monthly).toEqual([
      { month: '2026-01', income: 43, expenses: 12.75, salaries: 7, profit: 23.25 },
    ])
    expect(r.totalIncome).toBe(43)
    expect(r.totalExpenses).toBe(12.75)
    expect(r.totalSalaries).toBe(7)
    expect(r.netBalance).toBe(23.25)
  })
})

// ── getAccountantSummary ────────────────────────────────────────────────────

describe('SummaryService.getAccountantSummary — query shape + row mapping', () => {
  it('maps every column of the aggregate row to its KPI slot', async () => {
    const { svc } = makeDb({
      accountantRows: [
        {
          pendingCount: 3,
          pendingAmount: 30.5,
          validatedCount: 4,
          validatedAmount: 41.25,
          paidAmount: 52,
          recipientCount: 6,
        },
      ],
    })
    await expect(svc.getAccountantSummary(user('ACCOUNTANT'))).resolves.toEqual({
      pendingValidation: { count: 3, amount: 30.5 },
      validatedThisMonth: { count: 4, amount: 41.25 },
      paidThisMonth: { amount: 52 },
      recipientCount: 6,
    })
  })

  it('an empty aggregate result (no row) degrades to zeros', async () => {
    const { svc } = makeDb({ accountantRows: [] })
    await expect(svc.getAccountantSummary(user('ADMIN'))).resolves.toEqual({
      pendingValidation: { count: 0, amount: 0 },
      validatedThisMonth: { count: 0, amount: 0 },
      paidThisMonth: { amount: 0 },
      recipientCount: 0,
    })
  })

  it('compiles the exact aggregation SQL, bound to the UTC first-of-month boundary', async () => {
    freeze('2026-03-17T12:00:00Z')
    const { svc, cap } = makeDb({ accountantRows: [] })
    await svc.getAccountantSummary(user('ADMIN'))
    const arg = cap.accountantSelectArg as Record<string, never>
    const compiled = Object.fromEntries(
      Object.entries(arg).map(([k, v]) => [k, new PgDialect().sqlToQuery(v)]),
    )
    expect(Object.keys(arg)).toEqual([
      'pendingCount',
      'pendingAmount',
      'validatedCount',
      'validatedAmount',
      'paidAmount',
      'recipientCount',
    ])
    const pend = `"transactions"."status" = 'PENDING' and "transactions"."type" in ('SENIOR_INCOME', 'DROP_INCOME')`
    expect(compiled.pendingCount!.sql).toBe(`count(*) filter (where ${pend})`)
    expect(compiled.pendingAmount!.sql).toBe(
      `coalesce(sum("transactions"."amount") filter (where ${pend}), 0)`,
    )
    const val = `"transactions"."status" = 'VALIDATED' and "transactions"."validated_at" is not null and "transactions"."validated_at" >= $1`
    expect(compiled.validatedCount!.sql).toBe(`count(*) filter (where ${val})`)
    expect(compiled.validatedAmount!.sql).toBe(
      `coalesce(sum("transactions"."amount") filter (where ${val}), 0)`,
    )
    expect(compiled.paidAmount!.sql).toBe(
      `coalesce(sum("transactions"."amount") filter (where "transactions"."status" = 'PAID' and "transactions"."type" in ('SENIOR_INCOME', 'DROP_INCOME', 'PAYOUT', 'PAYOUT_ADMIN', 'PAYOUT_DROP', 'PAYOUT_CONFIRMED') and "transactions"."created_at" >= $1), 0)`,
    )
    expect(compiled.recipientCount!.sql).toBe(
      `count(distinct coalesce("transactions"."receiver_id", "transactions"."sender_id")) filter (where "transactions"."type" in ('SENIOR_INCOME', 'DROP_INCOME'))`,
    )
    for (const k of ['validatedCount', 'validatedAmount', 'paidAmount']) {
      expect(compiled[k]!.params).toEqual([new Date('2026-03-01T00:00:00.000Z')])
    }
    expect(compileWhere(cap.accountantWhere).sql).toContain('"deleted_at" is null')
  })
})

// ── getSeniorSummary ────────────────────────────────────────────────────────

describe('SummaryService.getSeniorSummary — figures', () => {
  const MAR = '2026-03-17T12:00:00Z'

  it('share income, last month, 8-month history, progress and payouts for a frozen March', async () => {
    freeze(MAR)
    const { svc, cap } = makeDb({
      selfUser: { seniorSharePercent: 40 },
      projects: [
        { id: 'p1', name: 'Alpha', companyName: 'Acme', seniorSharePercentOverride: null },
        { id: 'p2', name: 'Beta', companyName: 'Globex', seniorSharePercentOverride: 50 },
      ],
      txs: [
        // exactly the first instant of this month: counts as THIS month
        {
          amount: '1000.50',
          seniorSharePercent: 30,
          txDate: new Date('2026-03-01T00:00:00Z'),
          createdAt: new Date('2026-03-01T00:00:00Z'),
          projectId: 'p1',
        },
        // null snapshot -> user default 40%
        {
          amount: '200',
          seniorSharePercent: null,
          txDate: new Date('2026-03-16T00:00:00Z'),
          createdAt: new Date('2026-03-16T00:00:00Z'),
          projectId: 'p2',
        },
        // exactly the first instant of LAST month: counts as last month
        {
          amount: '500',
          seniorSharePercent: 25,
          txDate: new Date('2026-02-01T00:00:00Z'),
          createdAt: new Date('2026-02-01T00:00:00Z'),
          projectId: 'p1',
        },
        // one ms before last month: total only
        {
          amount: '100',
          seniorSharePercent: 10,
          txDate: new Date('2026-01-31T23:59:59.999Z'),
          createdAt: new Date('2026-01-31T23:59:59.999Z'),
          projectId: 'p1',
        },
        { amount: 'NaN', seniorSharePercent: 99, createdAt: new Date('2026-03-02T00:00:00Z') },
        // txDate null -> createdAt; project no longer active
        {
          amount: '40',
          seniorSharePercent: 50,
          txDate: null,
          createdAt: new Date('2026-03-05T00:00:00Z'),
          projectId: 'p-gone',
        },
        // a 0% snapshot is a real 0, not "missing"; no project id
        {
          amount: '1000',
          seniorSharePercent: 0,
          txDate: new Date('2026-03-10T00:00:00Z'),
          createdAt: new Date('2026-03-10T00:00:00Z'),
          projectId: null,
        },
      ],
      payouts: [{ payableAmount: '10.5' }, { payableAmount: '20' }, { payableAmount: 'x' }],
    })
    const r = await svc.getSeniorSummary(user('SENIOR'))

    // total = 300.15 + 80 + 125 + 10 + 20 + 0 ; thisMonth = 300.15 + 80 + 20
    expect(r.seniorShareIncome.total).toBeCloseTo(535.15, 9)
    expect(r.seniorShareIncome.thisMonth).toBeCloseTo(400.15, 9)
    expect(r.seniorShareIncome.currency).toBe('USD')
    expect(r.earningsStats.lastMonthIncome).toBeCloseTo(125, 9)

    const hist = r.earningsStats.monthlyHistory
    expect(hist.map((h) => h.month)).toEqual([
      '2025-08',
      '2025-09',
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
      '2026-03',
    ])
    expect(hist.map((h) => Number(h.amount.toFixed(6)))).toEqual([0, 0, 0, 0, 0, 10, 125, 400.15])

    expect(r.earningsStats.companyIncomeProgress).toEqual({ received: 2, total: 2 })
    expect(r.pendingPayouts).toEqual({ count: 3, amount: 30.5 })
    expect(r.activeProjects).toEqual({
      count: 2,
      items: [
        { id: 'p1', name: 'Alpha', companyName: 'Acme', sharePercent: 40 },
        { id: 'p2', name: 'Beta', companyName: 'Globex', sharePercent: 50 },
      ],
    })

    // salary lookup is bound to this UTC month, zero-padded, for the caller
    expect(compileWhere(cap.salaryWhere).params).toEqual(['SALARY', 'senior-1', '2026-03'])
    // paid-income read binds exactly type / status / receiver
    expect(collectParamValues(cap.txFindMany[0]!.where)).toEqual([
      'SENIOR_INCOME',
      'PAID',
      'senior-1',
    ])
    expect(compileWhere(cap.txFindMany[0]!.where).sql).toContain('"deleted_at" is null')
    // payout read binds seniorId / status
    expect(collectParamValues(cap.payoutsFindMany[0]!.where)).toEqual(['senior-1', 'PENDING'])
    // the self-user read is bound to the caller id
    expect(compileWhere(cap.usersFindFirst[0]!.where)).toMatchObject({
      sql: expect.stringContaining('"users"."id" = $1'),
      params: ['senior-1'],
    })
  })

  it('wraps the window over a year boundary (January)', async () => {
    freeze('2026-01-10T00:00:00Z')
    const { svc, cap } = makeDb({
      selfUser: { seniorSharePercent: 26 },
      txs: [
        {
          amount: '100',
          seniorSharePercent: 10,
          txDate: new Date('2025-12-15T00:00:00Z'),
          createdAt: new Date('2025-12-15T00:00:00Z'),
          projectId: null,
        },
      ],
    })
    const r = await svc.getSeniorSummary(user('SENIOR'))
    expect(r.earningsStats.lastMonthIncome).toBeCloseTo(10, 9)
    expect(r.seniorShareIncome.thisMonth).toBe(0)
    expect(r.earningsStats.monthlyHistory[0]!.month).toBe('2025-06')
    expect(r.earningsStats.monthlyHistory[7]).toEqual({ month: '2026-01', amount: 0 })
    expect(r.earningsStats.monthlyHistory[6]!.month).toBe('2025-12')
    expect(compileWhere(cap.salaryWhere).params).toContain('2026-01')
  })

  it('share % falls back selfUser -> session user -> 26 default', async () => {
    const project = { id: 'p1', name: 'A', companyName: 'C', seniorSharePercentOverride: null }
    const shareOf = async (selfUser: Row | undefined, sessionShare: number | undefined) => {
      const { svc } = makeDb({ selfUser, projects: [project] })
      const u = { ...user('SENIOR'), seniorSharePercent: sessionShare } as unknown as SessionUser
      return (await svc.getSeniorSummary(u)).activeProjects.items[0]!.sharePercent
    }
    expect(await shareOf({ seniorSharePercent: 40 }, 33)).toBe(40)
    expect(await shareOf(undefined, 33)).toBe(33)
    expect(await shareOf(undefined, undefined)).toBe(26)
  })

  it('a null-snapshot income uses the resolved default share in its sum', async () => {
    freeze(MAR)
    const { svc } = makeDb({
      selfUser: undefined,
      txs: [
        {
          amount: '100',
          seniorSharePercent: null,
          txDate: new Date('2026-03-02T00:00:00Z'),
          createdAt: new Date('2026-03-02T00:00:00Z'),
          projectId: null,
        },
      ],
    })
    const u = { ...user('SENIOR'), seniorSharePercent: 33 } as SessionUser
    expect((await svc.getSeniorSummary(u)).seniorShareIncome.total).toBeCloseTo(33, 9)
  })

  it('income with neither txDate nor createdAt still counts toward the total only', async () => {
    freeze(MAR)
    const { svc } = makeDb({
      selfUser: { seniorSharePercent: 50 },
      txs: [{ amount: '100', seniorSharePercent: 50, txDate: null, createdAt: null }],
    })
    const r = await svc.getSeniorSummary(user('SENIOR'))
    expect(r.seniorShareIncome.total).toBe(50)
    expect(r.seniorShareIncome.thisMonth).toBe(0)
    expect(r.earningsStats.lastMonthIncome).toBe(0)
  })

  it('an income on a project with no id never inflates arrival progress', async () => {
    freeze(MAR)
    const { svc } = makeDb({
      selfUser: { seniorSharePercent: 50 },
      projects: [{ id: 'p1', name: 'A', companyName: 'C', seniorSharePercentOverride: null }],
      txs: [
        {
          amount: '10',
          seniorSharePercent: 50,
          txDate: new Date('2026-03-02T00:00:00Z'),
          createdAt: new Date('2026-03-02T00:00:00Z'),
          projectId: null,
        },
      ],
    })
    const r = await svc.getSeniorSummary(user('SENIOR'))
    expect(r.earningsStats.companyIncomeProgress).toEqual({ received: 0, total: 1 })
  })

  it('salary state: EXISTS maps through, a cron-eligible role without a row awaits creation', async () => {
    const exists = makeDb({
      selfUser: { seniorSharePercent: 26 },
      salaryRows: [{ amount: '1500', status: 'PENDING', currency: 'USD' }],
    })
    const r = await exists.svc.getSeniorSummary(user('SENIOR'))
    expect(r.mySalaryState).toEqual({
      state: 'EXISTS',
      amount: 1500,
      status: 'PENDING',
      currency: 'USD',
    })
    expect(r.mySalaryStatus).toEqual({ amount: 1500, currency: 'USD', status: 'PENDING' })
    expect(r.mySalaryAggregateState).toMatchObject({ state: 'EXISTS', transactionCount: 1 })

    // a role that IS in CRON_ELIGIBLE_SALARY_ROLES reaches the helper only via a
    // direct provider call that bypasses the RBAC gate's own caller set; the gate
    // admits SENIOR/ADMIN only, so pin the two real outcomes:
    const configured = makeDb({
      selfUser: { seniorSharePercent: 26, monthlySalary: '2000' },
      salaryRows: [],
    })
    expect((await configured.svc.getSeniorSummary(user('SENIOR'))).mySalaryState).toEqual({
      state: 'NOT_CRON_ELIGIBLE',
    })
    const bare = makeDb({ selfUser: { seniorSharePercent: 26 }, salaryRows: [] })
    expect((await bare.svc.getSeniorSummary(user('SENIOR'))).mySalaryState).toEqual({
      state: 'NOT_CONFIGURED',
    })
  })
})

// ── getIncomeComplianceOverview ─────────────────────────────────────────────

describe('SummaryService.getIncomeComplianceOverview — figures', () => {
  const MONTH = '2026-03'
  const own = (id: string, displayName: string, role: string): Row => ({ id, displayName, role })
  const proj = (id: string, seniorId: string, dropId: string | null = null): Row => ({
    id,
    name: `Proj ${id}`,
    companyName: `Co ${id}`,
    seniorId,
    dropId,
  })
  const inc = (
    type: string,
    status: string,
    projectId: string | null,
    receiverId: string | null,
    txDate: string | null = '2026-03-10T00:00:00Z',
    createdAt: string | null = '2026-03-10T00:00:00Z',
  ): Row => ({
    type,
    status,
    projectId,
    receiverId,
    txDate: txDate ? new Date(txDate) : null,
    createdAt: createdAt ? new Date(createdAt) : null,
  })
  const miss = (
    id: string,
    flags: { pendingValidation?: boolean; accrued?: boolean } = {},
  ): Row => ({
    projectId: id,
    name: `Proj ${id}`,
    companyName: `Co ${id}`,
    submitted: false,
    pendingValidation: flags.pendingValidation ?? false,
    accrued: flags.accrued ?? false,
  })

  it('groups by receiver, applies evidence priority and sorts laggards-first', async () => {
    const { svc } = makeDb({
      owners: [
        own('A1', 'Ann', 'ADMIN'),
        own('S1', 'Sam', 'SENIOR'),
        own('S2', 'Bob', 'SENIOR'),
        own('S3', 'Aaron', 'SENIOR'),
        own('D1', 'Dan', 'DROP'),
      ],
      projects: [
        proj('P1', 'S1'),
        proj('P2', 'S1', 'D1'),
        proj('P3', 'A1'),
        proj('P6', 'S2', 'D1'),
        proj('P7', 'S3'),
        proj('P8', 'S3'),
        proj('P9', 'S3'),
        proj('P10', 'S3'),
      ],
      txs: [
        inc('SENIOR_INCOME', 'PAID', 'P1', 'S1'),
        inc('SENIOR_INCOME', 'PENDING', 'P2', 'S1'),
        inc('DROP_PENDING_PAYOUT', 'PENDING_PAYMENT', 'P2', 'D1'),
        // self-declare keys are project-level: another admin's receiverId still counts
        inc('ADMIN_INCOME', 'PAID', 'P3', 'A2'),
        // receiver-scoped evidence of a DIFFERENT drop must not count for D1
        inc('PAYOUT_DROP', 'PAID', 'P6', 'D9'),
        inc('SENIOR_INCOME', 'PAID', 'P7', 'S3'),
        inc('SENIOR_INCOME', 'PENDING', 'P7', 'S3'),
        inc('SENIOR_PENDING_PAYOUT', 'PENDING_PAYMENT', 'P8', 'S3'),
        inc('SENIOR_INCOME', 'PENDING', 'P8', 'S3'),
        // payout-request window: an already-earned income is received, not accrued
        inc('SENIOR_INCOME', 'PENDING_PAYMENT', 'P9', 'x'),
        // an obligation owed to someone else is not evidence for S3
        inc('SENIOR_PENDING_PAYOUT', 'PENDING_PAYMENT', 'P10', 'S9'),
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'), MONTH)

    expect(r.month).toBe('2026-03')
    expect(r.totals).toEqual({
      expectedProjects: 10,
      submittedProjects: 4,
      laggingReceivers: 4,
      completeReceivers: 1,
      pendingProjects: 1,
      accruedProjects: 2,
    })
    expect(r.receivers).toEqual([
      {
        userId: 'S2',
        displayName: 'Bob',
        role: 'SENIOR',
        expected: 1,
        submitted: 0,
        pendingCount: 0,
        accruedCount: 0,
        missingProjects: [miss('P6')],
      },
      {
        userId: 'D1',
        displayName: 'Dan',
        role: 'DROP',
        expected: 2,
        submitted: 0,
        pendingCount: 0,
        accruedCount: 1,
        missingProjects: [miss('P2', { accrued: true }), miss('P6')],
      },
      {
        userId: 'S1',
        displayName: 'Sam',
        role: 'SENIOR',
        expected: 2,
        submitted: 1,
        pendingCount: 1,
        accruedCount: 0,
        missingProjects: [miss('P2', { pendingValidation: true })],
      },
      {
        userId: 'S3',
        displayName: 'Aaron',
        role: 'SENIOR',
        expected: 4,
        submitted: 2,
        pendingCount: 0,
        accruedCount: 1,
        missingProjects: [miss('P8', { accrued: true }), miss('P10')],
      },
      {
        userId: 'A1',
        displayName: 'Ann',
        role: 'ADMIN_SENIOR',
        expected: 1,
        submitted: 1,
        pendingCount: 0,
        accruedCount: 0,
        missingProjects: [],
      },
    ])
  })

  it('drop evidence (PAYOUT_DROP / DROP_INCOME) and the UTC month window boundaries', async () => {
    const { svc } = makeDb({
      owners: [own('S1', 'Sam', 'SENIOR'), own('D1', 'Dan', 'DROP')],
      projects: [proj('Q1', 'S1', 'D1'), proj('Q2', 'S1', 'D1'), proj('Q3', 'S1', 'D1')],
      txs: [
        // first instant of the month: in
        inc('PAYOUT_DROP', 'PAID', 'Q1', 'D1', '2026-03-01T00:00:00.000Z'),
        // first instant of the NEXT month: out
        inc('SENIOR_INCOME', 'PAID', 'Q1', 'S1', '2026-04-01T00:00:00.000Z'),
        // txDate null -> createdAt, last ms of the month: in
        inc('DROP_INCOME', 'VALIDATED', 'Q2', 'D1', null, '2026-03-31T23:59:59.999Z'),
        // one ms before the month: out
        inc('SENIOR_INCOME', 'PAID', 'Q2', 'S1', '2026-02-28T23:59:59.999Z'),
        // no project id -> ignored; no date at all -> ignored
        inc('DROP_INCOME', 'PAID', null, 'D1'),
        inc('DROP_INCOME', 'PAID', 'Q3', 'D1', null, null),
        // dates absent altogether (undefined -> Invalid Date would slip past both range checks)
        { type: 'DROP_INCOME', status: 'PAID', projectId: 'Q3', receiverId: 'D1' },
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ACCOUNTANT'), MONTH)
    const dan = r.receivers.find((x) => x.userId === 'D1')!
    const sam = r.receivers.find((x) => x.userId === 'S1')!
    expect([dan.expected, dan.submitted]).toEqual([3, 2])
    expect(dan.missingProjects).toEqual([miss('Q3')])
    expect([sam.expected, sam.submitted, sam.pendingCount]).toEqual([3, 0, 0])
    expect(r.totals).toMatchObject({
      expectedProjects: 6,
      submittedProjects: 2,
      laggingReceivers: 2,
      completeReceivers: 0,
    })
  })

  it('ignores owners that are missing or not income receivers, and a null dropId', async () => {
    const { svc } = makeDb({
      owners: [own('J1', 'Jun', 'JUNIOR'), own('S1', 'Sam', 'SENIOR'), own('D1', 'Dan', 'DROP')],
      projects: [proj('R1', 'ghost'), proj('R2', 'J1', 'D1'), proj('R3', 'S1', null)],
      txs: [],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'), MONTH)
    expect(r.receivers.map((x) => [x.userId, x.role, x.expected]).sort()).toEqual([
      ['D1', 'DROP', 1],
      ['S1', 'SENIOR', 1],
    ])
    expect(r.totals.expectedProjects).toBe(2)
  })

  it('binds the owner / evidence reads to exactly the right ids, columns, types and statuses', async () => {
    const { svc, cap } = makeDb({
      owners: [own('S1', 'Sam', 'SENIOR')],
      projects: [proj('P1', 'S1'), proj('P2', 'S1', 'D1')],
      txs: [],
    })
    await svc.getIncomeComplianceOverview(user('ADMIN'), MONTH)
    // senior first, then drop, de-duplicated, falsy dropId dropped
    expect(cap.usersFindMany[0]!.params).toEqual(['S1', 'D1'])
    expect(cap.usersFindMany[0]!.columns).toEqual({ id: true, displayName: true, role: true })
    const tx = cap.txFindMany[0]!
    expect(collectParamValues(tx.where)).toEqual([
      'SENIOR_INCOME',
      'ADMIN_INCOME',
      'DROP_INCOME',
      'SENIOR_PENDING_PAYOUT',
      'DROP_PENDING_PAYOUT',
      'PAYOUT_DROP',
      'VALIDATED',
      'PAID',
      'PENDING',
      'PENDING_PAYMENT',
      'P1',
      'P2',
    ])
    expect(tx.columns).toEqual({
      type: true,
      status: true,
      projectId: true,
      receiverId: true,
      txDate: true,
      createdAt: true,
    })
  })

  it('defaults to the current UTC month and rolls the year for December', async () => {
    freeze('2026-02-10T08:00:00Z')
    const base = {
      owners: [own('S1', 'Sam', 'SENIOR')],
      projects: [proj('P1', 'S1')],
    }
    const feb = makeDb({
      ...base,
      txs: [
        inc('SENIOR_INCOME', 'PAID', 'P1', 'S1', '2026-02-01T00:00:00.000Z'),
        inc('SENIOR_INCOME', 'PAID', 'P1', 'S1', '2026-01-31T23:59:59.999Z'),
      ],
    })
    const r = await feb.svc.getIncomeComplianceOverview(user('ADMIN'))
    expect(r.month).toBe('2026-02')
    expect(r.totals.submittedProjects).toBe(1)

    const dec = makeDb({
      ...base,
      txs: [inc('SENIOR_INCOME', 'PAID', 'P1', 'S1', '2026-12-31T23:59:59.999Z')],
    })
    const d = await dec.svc.getIncomeComplianceOverview(user('ADMIN'), '2026-12')
    expect(d.month).toBe('2026-12')
    expect(d.totals.submittedProjects).toBe(1)

    const next = makeDb({
      ...base,
      txs: [inc('SENIOR_INCOME', 'PAID', 'P1', 'S1', '2027-01-01T00:00:00.000Z')],
    })
    expect(
      (await next.svc.getIncomeComplianceOverview(user('ADMIN'), '2026-12')).totals,
    ).toMatchObject({
      submittedProjects: 0,
    })
  })

  it('returns the zero overview for no active projects without touching users / transactions', async () => {
    const { svc, cap } = makeDb({ projects: [] })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'), '2026-03')
    expect(r).toEqual({
      month: '2026-03',
      totals: {
        expectedProjects: 0,
        submittedProjects: 0,
        laggingReceivers: 0,
        completeReceivers: 0,
        pendingProjects: 0,
        accruedProjects: 0,
      },
      receivers: [],
    })
    expect(cap.usersFindMany).toHaveLength(0)
    expect(cap.txFindMany).toHaveLength(0)
  })

  it('a single project is NOT treated as the empty case', async () => {
    const { svc } = makeDb({
      owners: [own('S1', 'Sam', 'SENIOR')],
      projects: [proj('P1', 'S1')],
      txs: [],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'), '2026-03')
    expect(r.totals).toMatchObject({ expectedProjects: 1, laggingReceivers: 1 })
  })

  it('ties on ratio fall back to fewer submitted, then name', async () => {
    const { svc } = makeDb({
      owners: [own('S1', 'Zoe', 'SENIOR'), own('S2', 'Amy', 'SENIOR'), own('S3', 'Max', 'SENIOR')],
      projects: [
        proj('P1', 'S1'),
        proj('P2', 'S1'),
        proj('P3', 'S2'),
        proj('P4', 'S2'),
        proj('P5', 'S2'),
        proj('P6', 'S2'),
        proj('P7', 'S3'),
        proj('P8', 'S3'),
      ],
      txs: [
        // Zoe 1/2, Amy 2/4 (same ratio, more submitted), Max 1/2 (same as Zoe -> name)
        inc('SENIOR_INCOME', 'PAID', 'P1', 'S1'),
        inc('SENIOR_INCOME', 'PAID', 'P3', 'S2'),
        inc('SENIOR_INCOME', 'PAID', 'P4', 'S2'),
        inc('SENIOR_INCOME', 'PAID', 'P7', 'S3'),
      ],
    })
    const r = await svc.getIncomeComplianceOverview(user('ADMIN'), '2026-03')
    expect(r.receivers.map((x) => x.displayName)).toEqual(['Max', 'Zoe', 'Amy'])
  })
})
