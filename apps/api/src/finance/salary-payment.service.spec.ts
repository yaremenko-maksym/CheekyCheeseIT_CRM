/**
 * SalaryPaymentService — unit-level (doubles for db, salary collaborator,
 * lifecycle, receipt and company-balance helpers).
 *
 * `paySalary` returns the paid row id; the viewer-scoped read-back stays on
 * TransactionsService. This file pins what is observable at the collaborator
 * seam: the ADMIN gates, the pre-write refusals, the exact row written by the
 * PENDING to PAID flip (both funding paths), the company-account balance gate,
 * the post-commit invoice / audit side effects, the monthly accrual claim and
 * its per-receiver failure isolation, and the backfill that re-runs it.
 */
import { ForbiddenException, Logger } from '@nestjs/common'
import { PgDialect } from 'drizzle-orm/pg-core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { COMPANY_ACCOUNT_LABEL } from '@crm/shared'
import { SalaryPaymentService } from './salary-payment.service'

const assertBindableMock = vi.hoisted(() => vi.fn())
const lockMock = vi.hoisted(() => vi.fn())
const balanceMock = vi.hoisted(() => vi.fn())
const txDateMock = vi.hoisted(() => vi.fn())

vi.mock('./receipt.util', () => ({ assertReceiptDocumentBindable: assertBindableMock }))
vi.mock('./company-account-balance', () => ({
  lockCompanyAccount: lockMock,
  computeCompanyAccountBalanceFromLedger: balanceMock,
}))
vi.mock('./transaction-date.util', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./transaction-date.util')>()),
  resolveTransactionDate: txDateMock,
}))

const dialect = new PgDialect()
/** Renders a drizzle `where` to its bound parameters (independent of the code under test). */
function paramsOf(where: unknown): unknown[] {
  return dialect.sqlToQuery(where as never).params
}

const ADMIN: SessionUser = {
  id: 'admin-caller',
  role: 'ADMIN',
  displayName: 'Admin Caller',
  email: 'admin@x.com',
  avatarUrl: null,
  seniorSharePercent: 0,
}
const IMPERSONATED: SessionUser = { ...ADMIN, id: 'target', impersonatorId: 'real-admin' }
const ACCOUNTANT: SessionUser = { ...ADMIN, id: 'acc', role: 'ACCOUNTANT' }
const SENIOR: SessionUser = { ...ADMIN, id: 'sen', role: 'SENIOR' }

const TX_DATE = new Date('2026-10-01T10:00:00.000Z')
const SALARY_ID = 'salary-1'
const HASH = '0x' + 'ab'.repeat(32)
const EXPLORER_URL = `https://etherscan.io/tx/${HASH}`
const NOT_ARCHIVED = { archivedFilter: true }

function pendingSalary(over: Record<string, unknown> = {}) {
  return {
    id: SALARY_ID,
    type: 'SALARY',
    status: 'PENDING',
    amount: '100.000000',
    currency: 'USD',
    receiverId: 'emp-1',
    notes: 'row-notes',
    txDate: new Date('2026-09-30T00:00:00.000Z'),
    createdAt: new Date('2026-09-30T00:00:00.000Z'),
    deletedAt: null,
    ...over,
  }
}

interface Harness {
  svc: SalaryPaymentService
  setCalls: Array<Record<string, unknown>>
  updateWheres: unknown[]
  auditRows: Array<Record<string, unknown>>
  inserts: Array<{ table: unknown; row: Record<string, unknown> }>
  txFindFirst: ReturnType<typeof vi.fn>
  usersFindFirst: ReturnType<typeof vi.fn>
  transaction: ReturnType<typeof vi.fn>
  freshSelectWheres: unknown[]
  selectArgs: unknown[]
  returningArgs: unknown[]
  salary: {
    assertSalaryReceiverNotArchived: ReturnType<typeof vi.fn>
    salaryReceiverNotArchivedFilter: ReturnType<typeof vi.fn>
    resolveHrAccountantSalaryReceivers: ReturnType<typeof vi.fn>
    resolveJuniorSalaryReceivers: ReturnType<typeof vi.fn>
    resolveSalaryMonthGap: ReturnType<typeof vi.fn>
  }
  lifecycle: {
    safeAutoCreateInvoice: ReturnType<typeof vi.fn>
    afterTransactionCreated: ReturnType<typeof vi.fn>
  }
  dbtx: unknown
}

function make(
  opts: {
    tx?: Record<string, unknown> | undefined | null
    payer?: Record<string, unknown> | undefined
    admin?: Record<string, unknown> | undefined
    /** rows returned by the flip UPDATE ... RETURNING */
    flipRows?: Array<{ id: string }>
    /** status seen by the in-lock re-read (company path) */
    freshStatus?: string | null
    /**
     * Row seen by the post-claim re-read that names WHY the flip matched zero
     * rows (CR-M-1). `null` = the row is gone. Default: still PENDING, i.e. a
     * snapshot predicate is what rejected the write.
     */
    postClaimRow?: { status: string; deletedAt: Date | null } | null
    auditError?: Error
    /** claim INSERT results, one per createAutomaticSalary call */
    claims?: Array<Array<{ id: string }>>
    existingAutomatic?: Array<Record<string, unknown> | undefined>
    insertedSalaryIds?: Array<string | undefined>
    hr?: Array<Record<string, unknown>>
    junior?: Array<Record<string, unknown>>
  } = {},
): Harness {
  const setCalls: Array<Record<string, unknown>> = []
  const updateWheres: unknown[] = []
  const auditRows: Array<Record<string, unknown>> = []
  const inserts: Array<{ table: unknown; row: Record<string, unknown> }> = []
  const freshSelectWheres: unknown[] = []
  const selectArgs: unknown[] = []
  const returningArgs: unknown[] = []
  const claimQueue = [...(opts.claims ?? [])]
  const existingQueue = [...(opts.existingAutomatic ?? [])]
  const insertedQueue = [...(opts.insertedSalaryIds ?? [])]
  const flipRows = opts.flipRows ?? [{ id: SALARY_ID }]

  const updateChain = () => ({
    set: (v: Record<string, unknown>) => {
      setCalls.push(v)
      return {
        where: (w: unknown) => {
          updateWheres.push(w)
          return {
            returning: async (arg: unknown) => {
              returningArgs.push(arg)
              return flipRows
            },
          }
        },
      }
    },
  })

  // The post-claim re-read (CR-M-1) is the only one that projects `deletedAt`,
  // which is what tells the two reads apart here.
  const isPostClaimRead = (arg: unknown) =>
    typeof arg === 'object' && arg !== null && 'deletedAt' in arg
  const postClaimRows = () =>
    opts.postClaimRow === null ? [] : [opts.postClaimRow ?? { status: 'PENDING', deletedAt: null }]

  const dbtx = {
    select: (arg: unknown) => {
      selectArgs.push(arg)
      return {
        from: () => ({
          where: async (w: unknown) => {
            freshSelectWheres.push(w)
            if (isPostClaimRead(arg)) return postClaimRows()
            return opts.freshStatus === null ? [] : [{ status: opts.freshStatus ?? 'PENDING' }]
          },
        }),
      }
    },
    update: updateChain,
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        inserts.push({ table, row })
        const isClaim = 'initializedBy' in row
        return {
          onConflictDoNothing: () => ({
            returning: async () => (isClaim ? (claimQueue.shift() ?? [{ id: 'claim' }]) : []),
          }),
          returning: async (arg: unknown) => {
            returningArgs.push(arg)
            const id = insertedQueue.length ? insertedQueue.shift() : 'new-salary'
            return id === undefined ? [] : [{ id }]
          },
        }
      },
    }),
    query: { transactions: { findFirst: vi.fn(async () => existingQueue.shift()) } },
  }

  const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(dbtx))
  const txFindFirst = vi.fn(async (_arg?: unknown) =>
    opts.tx === null ? undefined : (opts.tx ?? pendingSalary()),
  )
  const usersFindFirst = vi.fn(async (arg: { where: unknown }) => {
    const params = paramsOf(arg.where)
    if (params.includes('ADMIN') && !params.some((p) => typeof p === 'string' && p !== 'ADMIN')) {
      return opts.admin
    }
    return 'payer' in opts
      ? opts.payer
      : { id: ADMIN.id, role: 'ADMIN', displayName: 'Admin Caller' }
  })
  const dbInner = {
    transaction,
    update: updateChain,
    select: (arg: unknown) => {
      selectArgs.push(arg)
      return {
        from: () => ({
          where: async (w: unknown) => {
            freshSelectWheres.push(w)
            return postClaimRows()
          },
        }),
      }
    },
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        if (opts.auditError) throw opts.auditError
        auditRows.push(row)
      },
    }),
    query: {
      transactions: { findFirst: txFindFirst },
      users: { findFirst: usersFindFirst },
    },
  }
  const db = { db: dbInner }

  const salary = {
    assertSalaryReceiverNotArchived: vi.fn(async () => undefined),
    salaryReceiverNotArchivedFilter: vi.fn(() => NOT_ARCHIVED),
    resolveHrAccountantSalaryReceivers: vi.fn(async () => opts.hr ?? []),
    resolveJuniorSalaryReceivers: vi.fn(async () => opts.junior ?? []),
    resolveSalaryMonthGap: vi.fn(async (month: string) => ({ month, gap: true })),
  }
  const lifecycle = {
    safeAutoCreateInvoice: vi.fn(async () => undefined),
    afterTransactionCreated: vi.fn(async () => undefined),
  }
  const svc = new SalaryPaymentService(db as never, salary as never, lifecycle as never)
  return {
    svc,
    setCalls,
    updateWheres,
    auditRows,
    inserts,
    txFindFirst,
    usersFindFirst,
    transaction,
    freshSelectWheres,
    selectArgs,
    returningArgs,
    salary,
    lifecycle,
    dbtx,
  }
}

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  assertBindableMock.mockReset()
  lockMock.mockReset()
  balanceMock.mockReset()
  balanceMock.mockResolvedValue(1000)
  txDateMock.mockReset()
  txDateMock.mockReturnValue(TX_DATE)
  errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

const personal = {
  fundingSource: 'ADMIN_PERSONAL' as const,
  currency: 'EUR' as const,
  receiptExternalUrl: 'https://x.io/r',
}
const company = {
  fundingSource: 'COMPANY_ACCOUNT' as const,
  currency: 'UAH' as const,
  receiptExternalUrl: EXPLORER_URL,
  txHash: HASH,
}

describe('SalaryPaymentService.paySalary — gates and refusals', () => {
  it('refuses every non-ADMIN role before reading the db', async () => {
    for (const user of [ACCOUNTANT, SENIOR]) {
      const h = make()
      await expect(h.svc.paySalary(SALARY_ID, personal, user)).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      expect(h.txFindFirst).not.toHaveBeenCalled()
    }
  })

  it('404s a missing transaction', async () => {
    const h = make({ tx: null })
    await expect(h.svc.paySalary(SALARY_ID, personal, ADMIN)).rejects.toMatchObject({
      response: { code: 'FINANCE_TRANSACTION_NOT_FOUND' },
      status: 404,
    })
  })

  it('refuses a soft-deleted row', async () => {
    const h = make({ tx: pendingSalary({ deletedAt: new Date() }) })
    await expect(h.svc.paySalary(SALARY_ID, personal, ADMIN)).rejects.toBeDefined()
    expect(h.setCalls).toHaveLength(0)
  })

  it('refuses a non-SALARY row', async () => {
    const h = make({ tx: pendingSalary({ type: 'EXPENSE' }) })
    await expect(h.svc.paySalary(SALARY_ID, personal, ADMIN)).rejects.toMatchObject({
      response: { code: 'FINANCE_PAY_SALARY_ONLY' },
      status: 400,
    })
  })

  it('refuses a row that is not PENDING', async () => {
    const h = make({ tx: pendingSalary({ status: 'PAID' }) })
    await expect(h.svc.paySalary(SALARY_ID, personal, ADMIN)).rejects.toMatchObject({
      response: { code: 'FINANCE_TRANSACTION_NOT_PENDING' },
      status: 400,
    })
    expect(h.setCalls).toHaveLength(0)
  })

  // The lower bound is checked on the RESOLVED date (PR #868), so these cases
  // let the date resolve for real instead of returning the fixed TX_DATE.
  let realResolve: (typeof import('./transaction-date.util'))['resolveTransactionDate']
  beforeAll(async () => {
    realResolve = (
      await vi.importActual<typeof import('./transaction-date.util')>('./transaction-date.util')
    ).resolveTransactionDate
  })
  const resolveForReal = () =>
    txDateMock.mockImplementation((raw: string | null | undefined, now?: Date) =>
      realResolve(raw, now),
    )

  it('refuses a payment date before the obligation date (calendar-day granularity)', async () => {
    resolveForReal()
    const h = make()
    await expect(
      h.svc.paySalary(SALARY_ID, { ...personal, txDate: '2026-09-29' }, ADMIN),
    ).rejects.toMatchObject({
      response: { code: 'FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION' },
      status: 400,
    })
    expect(h.setCalls).toHaveLength(0)
  })

  it('accepts a payment dated on the obligation day, and falls back to createdAt when txDate is null', async () => {
    resolveForReal()
    const h = make()
    await h.svc.paySalary(SALARY_ID, { ...personal, txDate: '2026-09-30' }, ADMIN)
    expect(h.setCalls).toHaveLength(1)

    const h2 = make({ tx: pendingSalary({ txDate: null }) })
    await expect(
      h2.svc.paySalary(SALARY_ID, { ...personal, txDate: '2026-09-29' }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION' } })
  })

  // Backlog 338 / QA-LOW-1: a NULL-txDate row floors on the KYIV day of
  // createdAt — the same day the dialog shows and offers — not its UTC day.
  it('floors a NULL-txDate row on the Kyiv day of createdAt, incl. the 21:00-24:00 UTC window', async () => {
    resolveForReal()
    const lateUtc = () =>
      make({
        tx: pendingSalary({ txDate: null, createdAt: new Date('2026-10-20T21:30:00.000Z') }),
      })
    const before = lateUtc()
    await expect(
      before.svc.paySalary(SALARY_ID, { ...personal, txDate: '2026-10-20' }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION' } })
    expect(before.setCalls).toHaveLength(0)

    const onDay = lateUtc()
    await onDay.svc.paySalary(SALARY_ID, { ...personal, txDate: '2026-10-21' }, ADMIN)
    expect(onDay.setCalls).toHaveLength(1)

    const morning = make({
      tx: pendingSalary({ txDate: null, createdAt: new Date('2026-10-20T05:00:00.000Z') }),
    })
    await morning.svc.paySalary(SALARY_ID, { ...personal, txDate: '2026-10-20' }, ADMIN)
    expect(morning.setCalls).toHaveLength(1)
  })

  // SR-809-M-1 (PR #868): omitting the date resolves to "now", and "now" is
  // still bound by the obligation date — it cannot predate a future-dated row.
  it('refuses an omitted payment date when today is before the obligation date', async () => {
    txDateMock.mockReturnValue(new Date('2026-09-29T12:00:00.000Z'))
    const h = make()
    await expect(h.svc.paySalary(SALARY_ID, personal, ADMIN)).rejects.toMatchObject({
      response: { code: 'FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION' },
      status: 400,
    })
    expect(txDateMock).toHaveBeenCalledWith(undefined, expect.any(Date))
    expect(h.setCalls).toHaveLength(0)
  })

  it('asserts the receiver is not archived against the base connection, before writing', async () => {
    const h = make()
    h.salary.assertSalaryReceiverNotArchived.mockRejectedValueOnce(new Error('archived'))
    await expect(h.svc.paySalary(SALARY_ID, personal, ADMIN)).rejects.toThrow('archived')
    expect(h.salary.assertSalaryReceiverNotArchived).toHaveBeenCalledWith(
      expect.objectContaining({ transaction: h.transaction }),
      'emp-1',
    )
    expect(h.setCalls).toHaveLength(0)
  })

  it('re-checks the mandatory receipt for the effective currency (company-funded is USDT: explorer only)', async () => {
    const h = make()
    await expect(
      h.svc.paySalary(
        SALARY_ID,
        { fundingSource: 'COMPANY_ACCOUNT', currency: 'UAH', receiptExternalUrl: 'https://x.io/r' },
        ADMIN,
      ),
    ).rejects.toBeDefined()
    expect(h.setCalls).toHaveLength(0)

    const h2 = make()
    await expect(
      h2.svc.paySalary(SALARY_ID, { fundingSource: 'ADMIN_PERSONAL', currency: 'EUR' }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'RECEIPT_REQUIRED' } })
  })

  it('validates the receipt document binding only when a document is supplied', async () => {
    const h = make()
    await h.svc.paySalary(SALARY_ID, personal, ADMIN)
    expect(assertBindableMock).not.toHaveBeenCalled()

    const h2 = make()
    await h2.svc.paySalary(
      SALARY_ID,
      { fundingSource: 'ADMIN_PERSONAL', currency: 'EUR', receiptDocumentId: 'doc-1' },
      ADMIN,
    )
    expect(assertBindableMock).toHaveBeenCalledWith(expect.anything(), 'doc-1', ADMIN)
  })

  it('requires the explicit payer to be an ADMIN', async () => {
    for (const payer of [undefined, { id: 'p', role: 'SENIOR', displayName: 'P' }]) {
      const h = make({ payer })
      await expect(
        h.svc.paySalary(SALARY_ID, { ...personal, payerAdminId: 'p' }, ADMIN),
      ).rejects.toMatchObject({
        response: { code: 'FINANCE_PAYER_ACCOUNT_MUST_BE_ADMIN' },
        status: 400,
      })
      expect(h.setCalls).toHaveLength(0)
    }
  })

  it('refuses a payer who is also the receiver (friendly 400 before the DB CHECK)', async () => {
    const h = make({
      tx: pendingSalary({ receiverId: 'p' }),
      payer: { id: 'p', role: 'ADMIN', displayName: 'P' },
    })
    await expect(
      h.svc.paySalary(SALARY_ID, { ...personal, payerAdminId: 'p' }, ADMIN),
    ).rejects.toBeDefined()
    expect(h.setCalls).toHaveLength(0)
  })

  it('rejects an unstorable paidAmount through the shared amount rule', async () => {
    for (const paidAmount of [0, -5, Number.NaN, 1e-7]) {
      const h = make({ payer: { id: ADMIN.id, role: 'ADMIN', displayName: 'Admin Caller' } })
      await expect(
        h.svc.paySalary(SALARY_ID, { ...personal, paidAmount }, ADMIN),
      ).rejects.toBeDefined()
      expect(h.setCalls).toHaveLength(0)
    }
  })
})

describe('SalaryPaymentService.paySalary — ADMIN_PERSONAL flip', () => {
  const payer = { id: 'payer-1', role: 'ADMIN', displayName: 'Payer One' }

  it('defaults the payer to the caller and writes the exact PAID row; legacy amount untouched', async () => {
    const h = make({ payer: { id: ADMIN.id, role: 'ADMIN', displayName: 'Admin Caller' } })
    const res = await h.svc.paySalary(
      SALARY_ID,
      { ...personal, txHash: 'h', notes: 'pay-notes', txDate: '2026-10-01' },
      ADMIN,
    )

    expect(res).toEqual({ id: SALARY_ID })
    expect(h.transaction).not.toHaveBeenCalled()
    expect(txDateMock).toHaveBeenCalledWith('2026-10-01', expect.any(Date))
    const set = h.setCalls[0]!
    expect(set).toMatchObject({
      status: 'PAID',
      fundingSource: 'ADMIN_PERSONAL',
      currency: 'EUR',
      originalAmount: '100.000000',
      originalCurrency: 'USD',
      exchangeRate: '1.00000000',
      senderId: ADMIN.id,
      senderLabel: 'Admin Caller',
      txHash: 'h',
      receiptDocumentId: null,
      receiptExternalUrl: 'https://x.io/r',
      notes: 'pay-notes',
      txDate: TX_DATE,
    })
    expect(set).not.toHaveProperty('amount')
    expect(set.updatedAt).toBeInstanceOf(Date)
    expect(h.lifecycle.safeAutoCreateInvoice).toHaveBeenCalledWith('SALARY', SALARY_ID)
  })

  it('uses the named payer, keeps the row notes and nulls absent proof fields', async () => {
    const h = make({ payer })
    await h.svc.paySalary(SALARY_ID, { ...personal, payerAdminId: 'payer-1' }, ADMIN)
    expect(h.setCalls[0]).toMatchObject({
      senderId: 'payer-1',
      senderLabel: 'Payer One',
      notes: 'row-notes',
      txHash: null,
    })
  })

  it('writes the paid FACT and snapshots the obligation with the derived rate', async () => {
    const h = make({ payer })
    await h.svc.paySalary(
      SALARY_ID,
      { ...personal, payerAdminId: 'payer-1', paidAmount: 250 },
      ADMIN,
    )
    expect(h.setCalls[0]).toMatchObject({
      amount: '250',
      originalAmount: '100.000000',
      originalCurrency: 'USD',
      exchangeRate: '2.50000000',
    })
    expect(h.auditRows[0]).toMatchObject({
      metadata: { amount: '250', exchangeRate: '2.50000000' },
    })
  })

  it('records a NULL rate when the ratio is unrepresentable, instead of refusing the payment', async () => {
    const h = make({ payer, tx: pendingSalary({ amount: '5000000.000000' }) })
    await h.svc.paySalary(
      SALARY_ID,
      { ...personal, payerAdminId: 'payer-1', paidAmount: 0.000001 },
      ADMIN,
    )
    expect(h.setCalls[0]).toMatchObject({ amount: '0.000001', exchangeRate: null })
  })

  it('records a NULL rate when the obligation is unusable as a divisor', async () => {
    const h = make({ payer, tx: pendingSalary({ amount: '0' }) })
    await h.svc.paySalary(SALARY_ID, { ...personal, payerAdminId: 'payer-1' }, ADMIN)
    expect(h.setCalls[0]).toMatchObject({ exchangeRate: null })
  })

  it('loads the salary row by its id', async () => {
    const h = make({ payer })
    await h.svc.paySalary(SALARY_ID, { ...personal, payerAdminId: 'payer-1' }, ADMIN)
    const arg = h.txFindFirst.mock.calls[0]![0] as { where: unknown }
    expect(paramsOf(arg.where)).toEqual([SALARY_ID])
  })

  it('looks the payer up by the named id, or by the caller when none is named', async () => {
    const named = make({ payer })
    await named.svc.paySalary(SALARY_ID, { ...personal, payerAdminId: 'payer-1' }, ADMIN)
    const namedArg = named.usersFindFirst.mock.calls[0]![0] as { where: unknown }
    expect(paramsOf(namedArg.where)).toEqual(['payer-1'])

    const dflt = make()
    await dflt.svc.paySalary(SALARY_ID, personal, ADMIN)
    const dfltArg = dflt.usersFindFirst.mock.calls[0]![0] as { where: unknown }
    expect(paramsOf(dfltArg.where)).toEqual([ADMIN.id])
  })

  it('selects only the id of the flipped row', async () => {
    const h = make({ payer })
    await h.svc.paySalary(SALARY_ID, { ...personal, payerAdminId: 'payer-1' }, ADMIN)
    expect(Object.keys(h.returningArgs[0] as object)).toEqual(['id'])
  })

  it('records a NULL rate for a negative obligation instead of a bogus positive ratio', async () => {
    const h = make({ payer, tx: pendingSalary({ amount: '-5' }) })
    await h.svc.paySalary(SALARY_ID, { ...personal, payerAdminId: 'payer-1' }, ADMIN)
    expect(h.setCalls[0]).toMatchObject({ exchangeRate: null })
  })

  it('guards the flip with id, PENDING, not-deleted and the archived-receiver filter', async () => {
    const h = make({ payer })
    await h.svc.paySalary(SALARY_ID, { ...personal, payerAdminId: 'payer-1' }, ADMIN)
    const params = paramsOf(h.updateWheres[0])
    expect(params).toEqual(expect.arrayContaining([SALARY_ID, 'PENDING']))
    expect(h.salary.salaryReceiverNotArchivedFilter).toHaveBeenCalledTimes(1)
  })

  // SR-795-M-4 (PR #868): the flip binds the snapshot `paidSet` was derived
  // from, so a concurrent edit of the PENDING obligation makes it match zero.
  it('binds the read amount, currency and (copied) notes into the flip', async () => {
    const h = make({ payer })
    await h.svc.paySalary(SALARY_ID, { ...personal, payerAdminId: 'payer-1' }, ADMIN)
    expect(paramsOf(h.updateWheres[0])).toEqual(
      expect.arrayContaining([SALARY_ID, 'PENDING', '100.000000', 'USD', 'row-notes']),
    )
  })

  it('does not bind the old notes when the payment supplies its own', async () => {
    const h = make({ payer })
    await h.svc.paySalary(
      SALARY_ID,
      { ...personal, payerAdminId: 'payer-1', notes: 'new note' },
      ADMIN,
    )
    const params = paramsOf(h.updateWheres[0])
    expect(params).toEqual(expect.arrayContaining(['100.000000', 'USD']))
    expect(params).not.toContain('row-notes')
  })

  it('refuses when a concurrent flip won the race (zero rows), after naming an archive cause first', async () => {
    // "a concurrent flip won" means the row is no longer PENDING by the time we
    // look, which is what makes NOT_PENDING the true cause here (CR-M-1).
    const h = make({
      payer,
      flipRows: [],
      postClaimRow: { status: 'PAID', deletedAt: null },
    })
    await expect(
      h.svc.paySalary(SALARY_ID, { ...personal, payerAdminId: 'payer-1' }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'FINANCE_TRANSACTION_NOT_PENDING' } })
    expect(h.salary.assertSalaryReceiverNotArchived).toHaveBeenCalledTimes(2)
    expect(h.lifecycle.safeAutoCreateInvoice).not.toHaveBeenCalled()
    expect(h.auditRows).toHaveLength(0)
  })

  // CR-M-1: a pay racing an AMOUNT EDIT must not claim the row is not pending —
  // it is pending, its snapshot moved. Same code AdminEditService uses.
  it('names a moved snapshot, not a status change, when the row is still PENDING', async () => {
    const h = make({
      payer,
      flipRows: [],
      postClaimRow: { status: 'PENDING', deletedAt: null },
    })
    const error = (await h.svc
      .paySalary(SALARY_ID, { ...personal, payerAdminId: 'payer-1' }, ADMIN)
      .catch((reason: unknown) => reason)) as { response: { code: string; message: string } }
    expect(error.response.code).toBe('FINANCE_ROW_STATE_CHANGED_WHILE_EDITING')
    // QA-MED-2: the right code is not enough — its MESSAGE must also be true here.
    // In this race the row was neither paid nor deleted: it is still PENDING and was
    // merely edited, so a message claiming "paid or deleted" would be a false
    // statement delivered by the very fix that exists to stop one.
    expect(error.response.message).toMatch(/changed while you were working with it/)
    expect(error.response.message).not.toMatch(/paid or deleted/)
    expect(h.lifecycle.safeAutoCreateInvoice).not.toHaveBeenCalled()
  })

  it('names a deleted row as not-pending rather than a moved snapshot', async () => {
    const h = make({
      payer,
      flipRows: [],
      postClaimRow: { status: 'PENDING', deletedAt: new Date('2026-10-01T00:00:00.000Z') },
    })
    await expect(
      h.svc.paySalary(SALARY_ID, { ...personal, payerAdminId: 'payer-1' }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'FINANCE_TRANSACTION_NOT_PENDING' } })
  })

  it('names a vanished row as not-pending', async () => {
    const h = make({ payer, flipRows: [], postClaimRow: null })
    await expect(
      h.svc.paySalary(SALARY_ID, { ...personal, payerAdminId: 'payer-1' }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'FINANCE_TRANSACTION_NOT_PENDING' } })
  })

  it('refuses when more than one row would be flipped', async () => {
    // More than one row flipped means the write DID land, so the row reads back
    // PAID and NOT_PENDING stays the true cause (CR-M-1).
    const h = make({
      payer,
      flipRows: [{ id: 'a' }, { id: 'b' }],
      postClaimRow: { status: 'PAID', deletedAt: null },
    })
    await expect(
      h.svc.paySalary(SALARY_ID, { ...personal, payerAdminId: 'payer-1' }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'FINANCE_TRANSACTION_NOT_PENDING' } })
  })

  it('writes a PAY audit row attributed to the real operator under impersonation', async () => {
    const h = make({ payer })
    await h.svc.paySalary(SALARY_ID, { ...personal, payerAdminId: 'payer-1' }, IMPERSONATED)
    expect(h.auditRows).toEqual([
      {
        actorId: 'real-admin',
        targetId: SALARY_ID,
        action: 'PAY',
        metadata: {
          type: 'SALARY',
          amount: '100.000000',
          currency: 'EUR',
          originalAmount: '100.000000',
          originalCurrency: 'USD',
          exchangeRate: '1.00000000',
          fundingSource: 'ADMIN_PERSONAL',
        },
      },
    ])
  })

  it('attributes the audit row to the caller when not impersonating', async () => {
    const h = make({ payer })
    await h.svc.paySalary(SALARY_ID, { ...personal, payerAdminId: 'payer-1' }, ADMIN)
    expect(h.auditRows[0]).toMatchObject({ actorId: ADMIN.id })
  })

  it('swallows an audit-write failure: logs it and still returns the paid id', async () => {
    const h = make({ payer, auditError: new Error('audit down') })
    const res = await h.svc.paySalary(SALARY_ID, { ...personal, payerAdminId: 'payer-1' }, ADMIN)
    expect(res).toEqual({ id: SALARY_ID })
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        `paySalary: failed to persist audit record for transaction=${SALARY_ID}`,
      ),
      expect.anything(),
    )
  })
})

describe('SalaryPaymentService.paySalary — COMPANY_ACCOUNT flip', () => {
  it('forces USDT with the company label, no personal sender, under the account lock', async () => {
    const h = make()
    const res = await h.svc.paySalary(SALARY_ID, company, ADMIN)

    expect(res).toEqual({ id: SALARY_ID })
    expect(h.transaction).toHaveBeenCalledTimes(1)
    expect(lockMock).toHaveBeenCalledWith(h.dbtx)
    expect(balanceMock).toHaveBeenCalledWith(h.dbtx)
    expect(h.setCalls[0]).toMatchObject({
      status: 'PAID',
      fundingSource: 'COMPANY_ACCOUNT',
      currency: 'USDT',
      senderId: null,
      senderLabel: COMPANY_ACCOUNT_LABEL,
      originalCurrency: 'USD',
      txHash: HASH,
    })
    expect(h.lifecycle.safeAutoCreateInvoice).toHaveBeenCalledWith('SALARY', SALARY_ID)
    expect(h.auditRows[0]).toMatchObject({
      metadata: { currency: 'USDT', fundingSource: 'COMPANY_ACCOUNT' },
    })
  })

  it('re-asserts PENDING and not-deleted inside the lock before reading the balance', async () => {
    const h = make({ freshStatus: 'PAID' })
    await expect(h.svc.paySalary(SALARY_ID, company, ADMIN)).rejects.toMatchObject({
      response: { code: 'FINANCE_TRANSACTION_NOT_PENDING' },
    })
    expect(balanceMock).not.toHaveBeenCalled()
    expect(h.setCalls).toHaveLength(0)
    expect(paramsOf(h.freshSelectWheres[0])).toContain(SALARY_ID)

    const h2 = make({ freshStatus: null })
    await expect(h2.svc.paySalary(SALARY_ID, company, ADMIN)).rejects.toMatchObject({
      response: { code: 'FINANCE_TRANSACTION_NOT_PENDING' },
    })
  })

  it('re-reads only the status of the row, by id, inside the lock', async () => {
    const h = make()
    await h.svc.paySalary(SALARY_ID, company, ADMIN)
    expect(Object.keys(h.selectArgs[0] as object)).toEqual(['status'])
    expect(h.freshSelectWheres).toHaveLength(1)
  })

  it('selects only the id of the flipped row under the lock', async () => {
    const h = make()
    await h.svc.paySalary(SALARY_ID, company, ADMIN)
    expect(Object.keys(h.returningArgs[0] as object)).toEqual(['id'])
  })

  it('gates on the amount actually being paid, not on the obligation', async () => {
    balanceMock.mockResolvedValue(150)
    const ok = make()
    await ok.svc.paySalary(SALARY_ID, { ...company, paidAmount: 150 }, ADMIN)
    expect(ok.setCalls).toHaveLength(1)

    const tooBig = make()
    await expect(
      tooBig.svc.paySalary(SALARY_ID, { ...company, paidAmount: 150.5 }, ADMIN),
    ).rejects.toMatchObject({
      response: { code: 'FINANCE_COMPANY_ACCOUNT_INSUFFICIENT_FUNDS' },
      status: 400,
    })
    expect(tooBig.setCalls).toHaveLength(0)
    expect(tooBig.lifecycle.safeAutoCreateInvoice).not.toHaveBeenCalled()
  })

  it('falls back to the obligation amount for the gate when no paidAmount is given', async () => {
    balanceMock.mockResolvedValue(99.9)
    const h = make()
    await expect(h.svc.paySalary(SALARY_ID, company, ADMIN)).rejects.toMatchObject({
      response: { code: 'FINANCE_COMPANY_ACCOUNT_INSUFFICIENT_FUNDS' },
    })
  })

  it('consults the archive assertion first when the guarded write matches zero rows', async () => {
    // The archival assertion is CALLED first (that is this test's subject); the
    // stub lets it pass, so the row is re-read and — still PENDING — the refusal
    // names the moved snapshot rather than a status change (CR-M-1).
    const h = make({ flipRows: [] })
    await expect(h.svc.paySalary(SALARY_ID, company, ADMIN)).rejects.toMatchObject({
      response: { code: 'FINANCE_ROW_STATE_CHANGED_WHILE_EDITING' },
    })
    expect(h.salary.assertSalaryReceiverNotArchived).toHaveBeenCalledTimes(2)
    expect(h.salary.assertSalaryReceiverNotArchived).toHaveBeenLastCalledWith(h.dbtx, 'emp-1')
    expect(h.salary.salaryReceiverNotArchivedFilter).toHaveBeenCalledTimes(1)
    expect(paramsOf(h.updateWheres[0])).toEqual(expect.arrayContaining([SALARY_ID, 'PENDING']))
  })

  it('binds the read amount, currency and copied notes into the company-funded flip (SR-795-M-4)', async () => {
    const h = make()
    await h.svc.paySalary(SALARY_ID, company, ADMIN)
    expect(paramsOf(h.updateWheres[0])).toEqual(
      expect.arrayContaining([SALARY_ID, 'PENDING', '100.000000', 'USD', 'row-notes']),
    )
  })
})

describe('SalaryPaymentService.backfillSalaryMonth', () => {
  it('refuses non-ADMIN callers with the backfill-specific code, running nothing', async () => {
    const h = make()
    await expect(h.svc.backfillSalaryMonth(ACCOUNTANT, '2026-10')).rejects.toMatchObject({
      response: { code: 'FINANCE_SALARY_MONTH_BACKFILL_FORBIDDEN' },
      status: 403,
    })
    expect(h.salary.resolveHrAccountantSalaryReceivers).not.toHaveBeenCalled()
    expect(h.salary.resolveSalaryMonthGap).not.toHaveBeenCalled()
  })

  it('re-runs the accrual attributed to the real actor, then returns the post-backfill gap', async () => {
    const h = make({
      hr: [{ id: 'hr-1', email: 'hr@x', monthlySalary: '300' }],
      insertedSalaryIds: ['sal-1'],
    })
    const gap = await h.svc.backfillSalaryMonth(IMPERSONATED, '2026-10')

    expect(gap).toEqual({ month: '2026-10', gap: true })
    expect(h.salary.resolveSalaryMonthGap).toHaveBeenCalledWith('2026-10')
    expect(h.inserts.find((i) => 'initializedBy' in i.row)?.row).toMatchObject({
      initializedBy: 'real-admin',
      salaryMonth: '2026-10',
    })
    expect(h.lifecycle.afterTransactionCreated).toHaveBeenCalledWith(
      'sal-1',
      { type: 'SALARY', amount: '300', currency: 'USD' },
      IMPERSONATED,
    )
    expect(h.usersFindFirst).not.toHaveBeenCalled()
  })
})

describe('SalaryPaymentService.createMonthlySalaries', () => {
  const hr = [{ id: 'hr-1', email: 'hr@x', monthlySalary: '300' }]
  const jr = [{ id: 'jr-1', email: 'jr@x', monthlySalary: '120', projectId: 'proj-1' }]

  it('cron path: logs and stops when no ADMIN exists', async () => {
    const h = make({ hr, admin: undefined })
    await expect(h.svc.createMonthlySalaries('2026-10')).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledWith(
      'createMonthlySalaries: no ADMIN user found — cannot create salary reminders (skipping)',
    )
    expect(h.transaction).not.toHaveBeenCalled()
    expect(h.salary.resolveJuniorSalaryReceivers).not.toHaveBeenCalled()
  })

  it('cron path: attributes to any admin, mints PENDING rows and passes a null actor to the hook', async () => {
    const h = make({
      admin: { id: 'some-admin' },
      hr,
      junior: jr,
      insertedSalaryIds: ['sal-hr', 'sal-jr'],
    })
    await h.svc.createMonthlySalaries('2026-10')
    // SR-H-1 (PR #1158): the cron rows used to be written with NULL tx_date. They now carry
    // `resolveTransactionDate(null)` — the Kyiv business day of the run (mocked here to
    // TX_DATE; its Kyiv semantics are covered by transaction-date.util.spec.ts).
    expect(txDateMock).toHaveBeenCalledWith(null)
    const kyivDay = TX_DATE

    const claims = h.inserts.filter((i) => 'initializedBy' in i.row).map((i) => i.row)
    expect(claims).toEqual([
      { receiverId: 'hr-1', salaryMonth: '2026-10', initializedBy: 'some-admin' },
      { receiverId: 'jr-1', salaryMonth: '2026-10', initializedBy: 'some-admin' },
    ])
    const rows = h.inserts.filter((i) => !('initializedBy' in i.row)).map((i) => i.row)
    expect(rows).toEqual([
      {
        type: 'SALARY',
        status: 'PENDING',
        amount: '300',
        currency: 'USD',
        senderId: null,
        senderLabel: 'CheekyCheeseIT',
        receiverId: 'hr-1',
        salaryMonth: '2026-10',
        salaryOrigin: 'CRON',
        fundingSource: null,
        createdBy: 'some-admin',
        txDate: kyivDay,
      },
      {
        type: 'SALARY',
        status: 'PENDING',
        amount: '120',
        currency: 'USD',
        senderId: null,
        senderLabel: 'CheekyCheeseIT',
        receiverId: 'jr-1',
        projectId: 'proj-1',
        salaryMonth: '2026-10',
        salaryOrigin: 'CRON',
        fundingSource: null,
        createdBy: 'some-admin',
        txDate: kyivDay,
      },
    ])
    expect(h.lifecycle.afterTransactionCreated).toHaveBeenNthCalledWith(
      1,
      'sal-hr',
      { type: 'SALARY', amount: '300', currency: 'USD' },
      null,
    )
    expect(h.lifecycle.afterTransactionCreated).toHaveBeenNthCalledWith(
      2,
      'sal-jr',
      { type: 'SALARY', amount: '120', currency: 'USD' },
      null,
    )
  })

  it('attributes to the real operator when an actor is passed (and never looks up an admin)', async () => {
    const h = make({ hr, insertedSalaryIds: ['sal-1'] })
    await h.svc.createMonthlySalaries('2026-10', ACCOUNTANT)
    expect(h.usersFindFirst).not.toHaveBeenCalled()
    expect(h.inserts[0]!.row).toMatchObject({ initializedBy: ACCOUNTANT.id })
    expect(h.inserts[1]!.row).toMatchObject({ createdBy: ACCOUNTANT.id })

    const imp = make({ hr, insertedSalaryIds: ['sal-1'] })
    await imp.svc.createMonthlySalaries('2026-10', IMPERSONATED)
    expect(imp.inserts[1]!.row).toMatchObject({ createdBy: 'real-admin' })
  })

  it('is idempotent: an already-claimed month inserts nothing and fires no hook', async () => {
    const h = make({ admin: { id: 'a' }, hr, junior: jr, claims: [[], []] })
    await h.svc.createMonthlySalaries('2026-10')
    expect(h.inserts.filter((i) => !('initializedBy' in i.row))).toHaveLength(0)
    expect(h.lifecycle.afterTransactionCreated).not.toHaveBeenCalled()
  })

  it('does not resurrect a legacy / cron salary that already exists for the receiver and month', async () => {
    const h = make({ admin: { id: 'a' }, hr, existingAutomatic: [{ id: 'old' }] })
    await h.svc.createMonthlySalaries('2026-10')
    expect(h.inserts.filter((i) => !('initializedBy' in i.row))).toHaveLength(0)
    expect(h.lifecycle.afterTransactionCreated).not.toHaveBeenCalled()
  })

  it('fires no hook when the insert returns no row', async () => {
    const h = make({ admin: { id: 'a' }, hr, insertedSalaryIds: [undefined] })
    await h.svc.createMonthlySalaries('2026-10')
    expect(h.lifecycle.afterTransactionCreated).not.toHaveBeenCalled()
    // An empty RETURNING is a normal outcome, not a failure to log.
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('selects only the id of the inserted salary row', async () => {
    const h = make({ admin: { id: 'a' }, hr, insertedSalaryIds: ['s1'] })
    await h.svc.createMonthlySalaries('2026-10')
    expect(Object.keys(h.returningArgs[0] as object)).toEqual(['id'])
  })

  it('isolates a per-receiver failure: logs it, continues, then logs the aggregate', async () => {
    const hrTwo = [
      { id: 'hr-1', email: 'hr1@x', monthlySalary: '300' },
      { id: 'hr-2', email: 'hr2@x', monthlySalary: '310' },
    ]
    const h = make({
      admin: { id: 'a' },
      hr: hrTwo,
      junior: jr,
      insertedSalaryIds: ['s1', 's2', 's3'],
    })
    h.lifecycle.afterTransactionCreated
      .mockRejectedValueOnce(new Error('hook boom'))
      .mockRejectedValueOnce(new Error('hook boom 2'))
    await h.svc.createMonthlySalaries('2026-10')

    expect(h.lifecycle.afterTransactionCreated).toHaveBeenCalledTimes(3)
    expect(errorSpy).toHaveBeenCalledWith(
      'createMonthlySalaries: failed for employee hr-1 (hr1@x) month=2026-10 — hook boom',
      expect.any(String),
    )
    expect(errorSpy).toHaveBeenCalledWith(
      'createMonthlySalaries: 2 HR/ACCOUNTANT salary(ies) failed for month=2026-10. Failed employee ids: hr-1, hr-2',
    )
  })

  it('isolates a junior failure and aggregates it with the project in the per-row message', async () => {
    const jrTwo = [...jr, { id: 'jr-2', email: 'jr2@x', monthlySalary: '130', projectId: 'proj-2' }]
    const h = make({ admin: { id: 'a' }, junior: jrTwo, insertedSalaryIds: ['s1', 's2'] })
    h.lifecycle.afterTransactionCreated
      .mockRejectedValueOnce('plain string')
      .mockRejectedValueOnce('second')
    await h.svc.createMonthlySalaries('2026-10')

    expect(errorSpy).toHaveBeenCalledWith(
      'createMonthlySalaries: failed for junior jr-1 (jr@x) project=proj-1 month=2026-10 — plain string',
      undefined,
    )
    expect(errorSpy).toHaveBeenCalledWith(
      'createMonthlySalaries: 2 JUNIOR salary(ies) failed for month=2026-10. Failed employee ids: jr-1, jr-2',
    )
  })

  it('logs no aggregate error when nothing failed', async () => {
    const h = make({ admin: { id: 'a' }, hr, junior: jr, insertedSalaryIds: ['s1', 's2'] })
    await h.svc.createMonthlySalaries('2026-10')
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
