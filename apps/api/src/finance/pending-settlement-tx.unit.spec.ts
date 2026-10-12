/**
 * Characterization of the `db.transaction` body of
 * `PendingSettlementService.settleByCompany` (giant decomposition, L4 prereq).
 *
 * The money-movement core is: claim (conditional PENDING -> PAID on
 * pending_obligations) -> amount-changed re-check -> [company debit only:
 * advisory lock + balance gate] -> in-place flip of the source IOU -> closing
 * link. The ORDER is load-bearing: a loser of a double-settle must bail at the
 * claim before any money write.
 *
 * The integration/realdb specs cover this against Postgres but graceful-skip
 * without DATABASE_URL, so the unit mutation gate cannot see them. This spec
 * pins the observable behaviour through a RECORDING db-double: every statement
 * inside the transaction is appended to one ordered event log, WHERE clauses are
 * compiled with the real PgDialect to exact SQL + params.
 *
 * Needs real Postgres (stays integration-only): actual advisory-lock
 * contention, row-lock re-evaluation of the claim under concurrency, and
 * rollback of the claim when a later step throws. The double pins that those
 * calls are MADE, in order, with the right arguments; it cannot model what the
 * database does with them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '@nestjs/common'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { pendingObligations, transactions } from '../database/schema'
import { PendingSettlementService } from './pending-settlement.service'
import type { InvoicesService } from '../invoices/invoices.service'
import type { NbuCurrencyService } from './nbu-currency.service'

type Event =
  | { kind: 'update'; table: unknown; set: Record<string, unknown>; where: unknown; ret: unknown }
  | { kind: 'lock'; dbtx: unknown }
  | { kind: 'balance'; dbtx: unknown }

const h = vi.hoisted(() => ({
  events: [] as unknown[],
  balance: 1_000_000,
}))

vi.mock('./company-account-balance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./company-account-balance')>()
  return {
    ...actual,
    lockCompanyAccount: vi.fn(async (dbtx: unknown) => {
      h.events.push({ kind: 'lock', dbtx })
    }),
    computeCompanyAccountBalanceFromLedger: vi.fn(async (dbtx: unknown) => {
      h.events.push({ kind: 'balance', dbtx })
      return h.balance
    }),
  }
})

const dialect = new PgDialect()
const compile = (q: unknown) => {
  const { sql, params } = dialect.sqlToQuery(q as SQL)
  return { sql, params }
}

const SENIOR_ID = '11111111-1111-4111-8111-111111111111'
const DROP_ID = '22222222-2222-4222-8222-222222222222'
const OB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SRC_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ADMIN_ID = 'adm-1'
const NOW = new Date('2026-08-01T10:00:00.000Z')

const accountant: SessionUser = {
  id: 'acc-1',
  role: 'ACCOUNTANT',
  displayName: 'Accountant',
  email: 'a@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

const obligationRow = (o: Record<string, unknown> = {}) => ({
  id: OB_ID,
  creditorUserId: SENIOR_ID,
  debtorType: 'COMPANY' as const,
  debtorUserId: null,
  sourceTransactionId: SRC_ID,
  closingTransactionId: null,
  amount: '560',
  currency: 'USDT' as const,
  status: 'PENDING' as const,
  createdAt: new Date('2026-05-30T12:00:00Z'),
  updatedAt: new Date('2026-05-30T12:00:00Z'),
  ...o,
})

const sourceRow = (o: Record<string, unknown> = {}) => ({
  id: SRC_ID,
  type: 'SENIOR_PENDING_PAYOUT',
  projectId: null,
  amount: '560',
  currency: 'USDT',
  senderId: null,
  senderLabel: 'COMPANY',
  receiverId: SENIOR_ID,
  status: 'PENDING_PAYMENT',
  payoutRequestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  seniorSharePercent: 26,
  dropSharePercent: null,
  dropCascadeOrigin: false,
  settledAmount: null as string | null,
  settledCurrency: null as string | null,
  fundingSource: null as string | null,
  txDate: null,
  createdAt: new Date('2026-05-30T12:00:00Z'),
  ...o,
})

interface Opts {
  obligation?: Record<string, unknown>
  source?: Record<string, unknown>
  /** What the claim `.returning()` yields; default = one row with the obligation amount. */
  claimRows?: Array<{ id: string; amount: string }>
  /** What the flip `.returning()` yields; default = the flipped row. */
  flipRows?: Array<Record<string, unknown>>
}

function build(opts: Opts = {}) {
  const obligation = obligationRow(opts.obligation)
  const source = sourceRow(opts.source)
  const dbtx: Record<string, unknown> = {}
  dbtx['update'] = (table: unknown) => ({
    set: (set: Record<string, unknown>) => ({
      where: (where: unknown) => {
        const ev = { kind: 'update' as const, table, set, where, ret: undefined as unknown }
        h.events.push(ev)
        const run = (arg?: unknown): Promise<unknown[]> => {
          ev.ret = arg
          if (table === pendingObligations)
            return Promise.resolve(opts.claimRows ?? [{ id: OB_ID, amount: obligation.amount }])
          return Promise.resolve(
            opts.flipRows ?? [{ id: SRC_ID, type: set['type'], amount: '560', currency: 'USDT' }],
          )
        }
        return {
          returning: (arg?: unknown) => run(arg),
          then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve([]).then(res, rej),
        }
      },
    }),
  })
  const inserts: unknown[] = []
  const db = {
    db: {
      query: {
        pendingObligations: { findFirst: vi.fn(async () => obligation) },
        transactions: { findFirst: vi.fn(async () => source) },
        projects: { findFirst: vi.fn(async () => null) },
        users: {
          findFirst: vi.fn(async () => ({ id: ADMIN_ID, role: 'ADMIN', displayName: 'Admin P' })),
        },
      },
      insert: () => ({
        values: async (v: unknown) => {
          inserts.push(v)
        },
      }),
      transaction: async (cb: (tx: unknown) => Promise<void>) => cb(dbtx),
    },
  }
  const invoices = { autoCreateForSeniorPayout: vi.fn(async () => undefined) }
  const nbu = { getRates: vi.fn() }
  const svc = new PendingSettlementService(
    db as never,
    invoices as unknown as InvoicesService,
    nbu as unknown as NbuCurrencyService,
  )
  return { svc, dbtx, invoices, inserts, events: h.events as Event[] }
}

const kinds = (events: Event[]) =>
  events.map((e) =>
    e.kind === 'update' ? (e.table === pendingObligations ? 'upd:obl' : 'upd:tx') : e.kind,
  )

/** Replace drizzle SQL objects in a SET payload with their compiled form. */
const normalise = (set: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(set).map(([k, v]) => [
      k,
      v && typeof v === 'object' && 'queryChunks' in (v as object) ? compile(v) : v,
    ]),
  )

const ADMIN_PERSONAL = {
  fundingSource: 'ADMIN_PERSONAL' as const,
  payerAdminId: ADMIN_ID,
  receiptExternalUrl: 'https://etherscan.io/tx/0xabc123',
}
const COMPANY = {
  fundingSource: 'COMPANY_ACCOUNT' as const,
  receiptExternalUrl: 'https://etherscan.io/tx/0xabc123',
}

describe('settleByCompany — transaction body (L4 characterization)', () => {
  beforeEach(() => {
    h.events.length = 0
    h.balance = 1_000_000
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('order', () => {
    it('company-funded senior settle: claim -> lock -> balance -> flip -> closing link, on the SAME dbtx', async () => {
      const { svc, dbtx, events } = build()
      await svc.settleByCompany(OB_ID, accountant, COMPANY)
      expect(kinds(events)).toEqual(['upd:obl', 'lock', 'balance', 'upd:tx', 'upd:obl'])
      expect((events[1] as { dbtx: unknown }).dbtx).toBe(dbtx)
      expect((events[2] as { dbtx: unknown }).dbtx).toBe(dbtx)
    })

    it('ADMIN_PERSONAL settle: claim -> flip -> closing link, NO lock and NO balance read', async () => {
      const { svc, events } = build()
      await svc.settleByCompany(OB_ID, accountant, ADMIN_PERSONAL)
      expect(kinds(events)).toEqual(['upd:obl', 'upd:tx', 'upd:obl'])
    })

    it('legacy DROP-debtor obligation without funding never touches the company account', async () => {
      const { svc, events } = build({ obligation: { debtorType: 'DROP' } })
      await svc.settleByCompany(OB_ID, accountant)
      expect(kinds(events)).toEqual(['upd:obl', 'upd:tx', 'upd:obl'])
    })

    it('legacy no-funding COMPANY obligation defaults to a company debit (lock + gate)', async () => {
      const { svc, events } = build()
      await svc.settleByCompany(OB_ID, accountant)
      expect(kinds(events)).toEqual(['upd:obl', 'lock', 'balance', 'upd:tx', 'upd:obl'])
    })
  })

  describe('claim', () => {
    it('is a conditional PENDING -> PAID update keyed on the obligation id, returning {id, amount}', async () => {
      const { svc, events } = build()
      await svc.settleByCompany(OB_ID, accountant, COMPANY)
      const claim = events[0] as Extract<Event, { kind: 'update' }>
      expect(claim.table).toBe(pendingObligations)
      expect(claim.set).toStrictEqual({ status: 'PAID', updatedAt: NOW })
      expect(compile(claim.where)).toStrictEqual({
        sql: '("pending_obligations"."id" = $1 and "pending_obligations"."status" = $2)',
        params: [OB_ID, 'PENDING'],
      })
      expect(claim.ret).toStrictEqual({
        id: pendingObligations.id,
        amount: pendingObligations.amount,
      })
    })

    it('zero claimed rows (loser of a double-settle) aborts BEFORE any lock, balance read or money write', async () => {
      const { svc, events, invoices, inserts } = build({ claimRows: [] })
      await expect(svc.settleByCompany(OB_ID, accountant, COMPANY)).rejects.toMatchObject({
        response: { code: 'FINANCE_OBLIGATION_ALREADY_CLOSED', statusCode: 400 },
      })
      expect(kinds(events)).toEqual(['upd:obl'])
      expect(invoices.autoCreateForSeniorPayout).not.toHaveBeenCalled()
      expect(inserts).toHaveLength(0)
    })
  })

  describe('amount-changed re-check', () => {
    it('a claimed amount that differs from the pre-transaction snapshot aborts right after the claim', async () => {
      const { svc, events } = build({ claimRows: [{ id: OB_ID, amount: '561' }] })
      await expect(svc.settleByCompany(OB_ID, accountant, COMPANY)).rejects.toMatchObject({
        response: { code: 'FINANCE_OBLIGATION_AMOUNT_CHANGED', statusCode: 400 },
      })
      expect(kinds(events)).toEqual(['upd:obl'])
    })

    it('compares at 6 decimals: a 0.000001 drift is a change', async () => {
      const { svc, events } = build({ claimRows: [{ id: OB_ID, amount: '560.000001' }] })
      await expect(svc.settleByCompany(OB_ID, accountant, ADMIN_PERSONAL)).rejects.toMatchObject({
        response: { code: 'FINANCE_OBLIGATION_AMOUNT_CHANGED' },
      })
      expect(kinds(events)).toEqual(['upd:obl'])
    })

    it('equal numerics in a different textual form are NOT a change', async () => {
      const { svc, events } = build({ claimRows: [{ id: OB_ID, amount: '560.000000' }] })
      await svc.settleByCompany(OB_ID, accountant, ADMIN_PERSONAL)
      expect(kinds(events)).toEqual(['upd:obl', 'upd:tx', 'upd:obl'])
    })

    it('runs for ADMIN_PERSONAL too (not only inside the balance-gate branch)', async () => {
      const { svc } = build({ claimRows: [{ id: OB_ID, amount: '1' }] })
      await expect(svc.settleByCompany(OB_ID, accountant, ADMIN_PERSONAL)).rejects.toMatchObject({
        response: { code: 'FINANCE_OBLIGATION_AMOUNT_CHANGED' },
      })
    })
  })

  describe('balance gate (company debit only)', () => {
    it('balance exactly equal to the remainder passes (gate is strict >)', async () => {
      h.balance = 560
      const { svc, events } = build()
      await svc.settleByCompany(OB_ID, accountant, COMPANY)
      expect(kinds(events)).toEqual(['upd:obl', 'lock', 'balance', 'upd:tx', 'upd:obl'])
    })

    it('balance below the remainder refuses; nothing after the gate runs', async () => {
      h.balance = 559.999999
      const { svc, events, invoices } = build()
      await expect(svc.settleByCompany(OB_ID, accountant, COMPANY)).rejects.toMatchObject({
        response: { code: 'FINANCE_COMPANY_ACCOUNT_INSUFFICIENT_FUNDS', statusCode: 400 },
      })
      expect(kinds(events)).toEqual(['upd:obl', 'lock', 'balance'])
      expect(invoices.autoCreateForSeniorPayout).not.toHaveBeenCalled()
    })

    it('gates on the REMAINDER after a partial payment, not the full obligation', async () => {
      const prior = {
        settledAmount: '100.000000',
        settledCurrency: 'USDT',
        fundingSource: 'COMPANY_ACCOUNT',
      }
      h.balance = 460
      const ok = build({ source: prior })
      await ok.svc.settleByCompany(OB_ID, accountant, COMPANY)
      expect(kinds(ok.events)).toEqual(['upd:obl', 'lock', 'balance', 'upd:tx', 'upd:obl'])

      h.events.length = 0
      h.balance = 459.999999
      const bad = build({ source: prior })
      await expect(bad.svc.settleByCompany(OB_ID, accountant, COMPANY)).rejects.toMatchObject({
        response: { code: 'FINANCE_COMPANY_ACCOUNT_INSUFFICIENT_FUNDS' },
      })
    })

    it('ADMIN_PERSONAL ignores the company balance entirely', async () => {
      h.balance = 0
      const { svc, events } = build()
      await svc.settleByCompany(OB_ID, accountant, ADMIN_PERSONAL)
      expect(kinds(events)).toEqual(['upd:obl', 'upd:tx', 'upd:obl'])
    })
  })

  describe('in-place flip of the source IOU', () => {
    it('senior company-funded: exact SET and WHERE', async () => {
      const { svc, events } = build()
      await svc.settleByCompany(OB_ID, accountant, COMPANY)
      const flip = events[3] as Extract<Event, { kind: 'update' }>
      expect(flip.table).toBe(transactions)
      expect(normalise(flip.set)).toStrictEqual({
        type: 'SENIOR_INCOME',
        status: 'PAID',
        currency: 'USDT',
        senderId: null,
        senderLabel: 'COMPANY',
        fundingSource: 'COMPANY_ACCOUNT',
        receiptDocumentId: null,
        receiptExternalUrl: 'https://etherscan.io/tx/0xabc123',
        payoutRequestId: null,
        seniorSharePercent: null,
        seniorSharePercentSource: null,
        dropSharePercent: null,
        dropSharePercentSource: null,
        settledSharePercent: 26,
        settledAmount: { sql: 'coalesce("transactions"."settled_amount", 0) + $1', params: [560] },
        settledCurrency: 'USDT',
        notes: `Закриття зобов’язання сеньйора (${OB_ID})`,
        updatedAt: NOW,
        validatedBy: 'acc-1',
        validatedAt: NOW,
      })
      expect(compile(flip.where)).toStrictEqual({
        sql: '("transactions"."id" = $1 and "transactions"."status" = $2 and "transactions"."settled_amount" IS NOT DISTINCT FROM $3::numeric)',
        params: [SRC_ID, 'PENDING_PAYMENT', null],
      })
      expect(flip.ret).toBeUndefined()
    })

    it('senior ADMIN_PERSONAL: payer stamped as sender, no company marker', async () => {
      const { svc, events } = build()
      await svc.settleByCompany(OB_ID, accountant, ADMIN_PERSONAL)
      const flip = events[1] as Extract<Event, { kind: 'update' }>
      expect(flip.set).toMatchObject({
        senderId: ADMIN_ID,
        senderLabel: 'Admin P',
        fundingSource: null,
      })
    })

    it('where re-asserts the accumulator read before the transaction', async () => {
      const { svc, events } = build({
        source: {
          settledAmount: '100.000000',
          settledCurrency: 'USDT',
          fundingSource: 'COMPANY_ACCOUNT',
        },
      })
      await svc.settleByCompany(OB_ID, accountant, COMPANY)
      const flip = events[3] as Extract<Event, { kind: 'update' }>
      expect(compile(flip.where).params).toStrictEqual([SRC_ID, 'PENDING_PAYMENT', '100.000000'])
      expect(normalise(flip.set)['settledAmount']).toStrictEqual({
        sql: 'coalesce("transactions"."settled_amount", 0) + $1',
        params: [460],
      })
    })

    it('impersonated operator is recorded as the validator (real operator wins)', async () => {
      const { svc, events } = build()
      await svc.settleByCompany(OB_ID, { ...accountant, impersonatorId: 'real-op' }, COMPANY)
      expect((events[3] as Extract<Event, { kind: 'update' }>).set).toMatchObject({
        validatedBy: 'real-op',
      })
    })

    it('selected txDate is written at UTC midnight; absent -> txDate key not written', async () => {
      const a = build()
      await a.svc.settleByCompany(OB_ID, accountant, { ...ADMIN_PERSONAL, txDate: '2026-07-15' })
      expect((a.events[1] as Extract<Event, { kind: 'update' }>).set['txDate']).toStrictEqual(
        new Date('2026-07-15T00:00:00.000Z'),
      )
      h.events.length = 0
      const b = build()
      await b.svc.settleByCompany(OB_ID, accountant, ADMIN_PERSONAL)
      expect('txDate' in (b.events[1] as Extract<Event, { kind: 'update' }>).set).toBe(false)
    })

    it('drop settle: PAYOUT_DROP with accumulating amount/original* stamped, no validator, drop share snapshot', async () => {
      const { svc, events } = build({
        source: {
          type: 'DROP_PENDING_PAYOUT',
          seniorSharePercent: null,
          dropSharePercent: 40,
          dropCascadeOrigin: false,
        },
        obligation: { creditorUserId: DROP_ID },
      })
      await svc.settleByCompany(OB_ID, accountant, COMPANY)
      expect(kinds(events)).toEqual(['upd:obl', 'lock', 'balance', 'upd:tx', 'upd:obl'])
      const set = normalise((events[3] as Extract<Event, { kind: 'update' }>).set)
      const acc = { sql: 'coalesce("transactions"."settled_amount", 0) + $1', params: [560] }
      expect(set).toStrictEqual({
        type: 'PAYOUT_DROP',
        status: 'PAID',
        currency: 'USDT',
        amount: acc,
        originalAmount: '560',
        originalCurrency: 'USDT',
        exchangeRate: set['exchangeRate'],
        senderId: null,
        senderLabel: 'COMPANY',
        fundingSource: 'COMPANY_ACCOUNT',
        receiptDocumentId: null,
        receiptExternalUrl: 'https://etherscan.io/tx/0xabc123',
        payoutRequestId: null,
        seniorSharePercent: null,
        seniorSharePercentSource: null,
        dropSharePercent: null,
        dropSharePercentSource: null,
        settledSharePercent: 40,
        settledAmount: acc,
        settledCurrency: 'USDT',
        notes: `Закриття зобов’язання дропа (${OB_ID})`,
        updatedAt: NOW,
      })
      expect(set['exchangeRate']).toBe('1.00000000')
    })

    it('zero flipped rows aborts: no closing link, no invoice, no audit', async () => {
      const { svc, events, invoices, inserts } = build({ flipRows: [] })
      await expect(svc.settleByCompany(OB_ID, accountant, COMPANY)).rejects.toMatchObject({
        response: { code: 'FINANCE_OBLIGATION_CLOSE_SOURCE_NOT_PENDING', statusCode: 400 },
      })
      expect(kinds(events)).toEqual(['upd:obl', 'lock', 'balance', 'upd:tx'])
      expect(invoices.autoCreateForSeniorPayout).not.toHaveBeenCalled()
      expect(inserts).toHaveLength(0)
    })
  })

  describe('closing link', () => {
    it('points the obligation at the SAME flipped source row, keyed on the obligation id', async () => {
      const { svc, events } = build()
      await svc.settleByCompany(OB_ID, accountant, COMPANY)
      const link = events[4] as Extract<Event, { kind: 'update' }>
      expect(link.table).toBe(pendingObligations)
      expect(link.set).toStrictEqual({ closingTransactionId: SRC_ID, updatedAt: NOW })
      expect(compile(link.where)).toStrictEqual({
        sql: '"pending_obligations"."id" = $1',
        params: [OB_ID],
      })
      expect(link.ret).toBeUndefined()
    })
  })

  describe('result of the committed transaction', () => {
    it('returns the flipped row and triggers the invoice only for SENIOR_INCOME', async () => {
      const s = build()
      const res = await s.svc.settleByCompany(OB_ID, accountant, COMPANY)
      expect(res.created).toHaveLength(1)
      expect(res.created[0]?.id).toBe(SRC_ID)
      expect(s.invoices.autoCreateForSeniorPayout).toHaveBeenCalledWith(SRC_ID)
      expect(s.inserts).toHaveLength(1)

      h.events.length = 0
      const d = build({
        source: { type: 'DROP_PENDING_PAYOUT', seniorSharePercent: null, dropSharePercent: 40 },
      })
      await d.svc.settleByCompany(OB_ID, accountant, COMPANY)
      expect(d.invoices.autoCreateForSeniorPayout).not.toHaveBeenCalled()
    })
  })
})
