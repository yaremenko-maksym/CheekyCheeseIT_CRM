/**
 * TransactionEntryService — unit-level (doubles for db, lifecycle, receipt and
 * company-balance helpers).
 *
 * The collaborator returns the created / replayed row id; the viewer-scoped
 * read-back stays on TransactionsService (covered by the specs that spy on the
 * facade's `findOne`). This file pins what is observable only at the
 * collaborator seam: the role gates, the receipt rules, the exact inserted row,
 * the company-account balance gate and its lock/executor wiring, the
 * idempotency lookups, the after-create lifecycle call and the returned id.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { COMPANY_ACCOUNT_LABEL } from '@crm/shared'
import { salaryMonthInitializations } from '../database/schema'
import { TransactionEntryService } from './transaction-entry.service'

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
const ACCOUNTANT: SessionUser = { ...ADMIN, id: 'accountant-caller', role: 'ACCOUNTANT' }
const JUNIOR: SessionUser = { ...ADMIN, id: 'junior-caller', role: 'JUNIOR' }
const SENIOR: SessionUser = { ...ADMIN, id: 'senior-caller', role: 'SENIOR' }

const TX_DATE = new Date('2026-10-01T10:00:00.000Z')
const HASH = '0x' + 'ab'.repeat(32)
const EXPLORER_URL = `https://etherscan.io/tx/${HASH}`
const KEY = 'a1a2a3a4-0000-4000-8000-000000000001'

interface Harness {
  svc: TransactionEntryService
  inserted: Array<Record<string, unknown>>
  txInserted: Array<Record<string, unknown>>
  markerClaims: Array<Record<string, unknown>>
  readonly markerConflictArgs: Record<string, unknown> | undefined
  readonly markerReturningProjection: Record<string, unknown> | undefined
  usersFindFirst: ReturnType<typeof vi.fn>
  txFindFirst: ReturnType<typeof vi.fn>
  transaction: ReturnType<typeof vi.fn>
  lifecycle: { afterTransactionCreated: ReturnType<typeof vi.fn> }
  db: { db: unknown }
  dbtx: unknown
}

function make(
  opts: {
    users?: Array<Record<string, unknown> | undefined>
    txLookups?: Array<Record<string, unknown> | undefined>
    insertError?: unknown
    /** SR-795-M-1: false = the month marker was already taken (cron or a sibling part). */
    markerClaimed?: boolean
  } = {},
): Harness {
  const inserted: Array<Record<string, unknown>> = []
  const txInserted: Array<Record<string, unknown>> = []
  const markerClaims: Array<Record<string, unknown>> = []
  let markerConflictArgs: Record<string, unknown> | undefined
  let markerReturningProjection: Record<string, unknown> | undefined
  const userQueue = [...(opts.users ?? [])]
  const lookupQueue = [...(opts.txLookups ?? [])]
  const dbtx = {
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        // SR-795-M-1: the manual salary write claims the receiver/month cron
        // marker in the same transaction as the row, so this double has to
        // tell the two inserts apart by table identity.
        if (table === salaryMonthInitializations) {
          markerClaims.push(row)
          return {
            onConflictDoNothing: (args: Record<string, unknown>) => {
              markerConflictArgs = args
              return {
                returning: async (projection?: Record<string, unknown>) => {
                  markerReturningProjection = projection
                  return opts.markerClaimed === false ? [] : [{ id: 'marker-1' }]
                },
              }
            },
          }
        }
        const withId = { id: 'new-tx-id', ...row }
        return {
          returning: async () => {
            if (opts.insertError) throw opts.insertError
            txInserted.push(withId)
            return [withId]
          },
        }
      },
    }),
  }
  const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(dbtx))
  const usersFindFirst = vi.fn(async () => userQueue.shift())
  const txFindFirst = vi.fn(async () => lookupQueue.shift())
  const dbInner = {
    transaction,
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        returning: async () => {
          if (opts.insertError) throw opts.insertError
          const withId = { id: 'new-tx-id', ...row }
          inserted.push(withId)
          return [withId]
        },
      }),
    }),
    query: {
      users: { findFirst: usersFindFirst },
      transactions: { findFirst: txFindFirst },
    },
  }
  const db = { db: dbInner }
  const lifecycle = { afterTransactionCreated: vi.fn(async () => undefined) }
  const svc = new TransactionEntryService(db as never, lifecycle as never)
  return {
    svc,
    inserted,
    txInserted,
    markerClaims,
    get markerConflictArgs() {
      return markerConflictArgs
    },
    get markerReturningProjection() {
      return markerReturningProjection
    },
    usersFindFirst,
    txFindFirst,
    transaction,
    lifecycle,
    db,
    dbtx,
  }
}

beforeEach(() => {
  assertBindableMock.mockReset()
  lockMock.mockReset()
  balanceMock.mockReset()
  balanceMock.mockResolvedValue(1000)
  txDateMock.mockReset()
  txDateMock.mockReturnValue(TX_DATE)
})

describe('TransactionEntryService.createExpense', () => {
  const base = {
    amount: 50,
    currency: 'EUR',
    category: 'Hosting',
    receiptExternalUrl: 'https://x.io/r',
  }

  it('rejects any role other than ADMIN / ACCOUNTANT before touching the db', async () => {
    for (const user of [JUNIOR, SENIOR]) {
      const h = make()
      await expect(h.svc.createExpense(base, user)).rejects.toBeInstanceOf(ForbiddenException)
      expect(h.inserted).toHaveLength(0)
      expect(h.transaction).not.toHaveBeenCalled()
      expect(h.lifecycle.afterTransactionCreated).not.toHaveBeenCalled()
    }
  })

  it('requires a receipt (re-checked on the service, not only at the controller)', async () => {
    const h = make()
    await expect(
      h.svc.createExpense({ amount: 50, currency: 'EUR', category: 'Hosting' }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'RECEIPT_REQUIRED' } })
    expect(h.inserted).toHaveLength(0)
  })

  it('books a legacy expense: caller is sender, supplied currency, PAID, no funding source', async () => {
    const h = make()
    const res = await h.svc.createExpense({ ...base, notes: 'n1', txDate: '2026-10-01' }, ADMIN)

    expect(res).toEqual({ id: 'new-tx-id' })
    expect(h.transaction).not.toHaveBeenCalled()
    expect(lockMock).not.toHaveBeenCalled()
    expect(txDateMock).toHaveBeenCalledWith('2026-10-01')
    const expected = {
      type: 'EXPENSE',
      status: 'PAID',
      amount: '50',
      currency: 'EUR',
      senderId: ADMIN.id,
      senderLabel: null,
      receiverLabel: 'Hosting',
      notes: 'n1',
      receiptDocumentId: null,
      receiptExternalUrl: 'https://x.io/r',
      fundingSource: null,
      txDate: TX_DATE,
      createdBy: ADMIN.id,
    }
    expect(h.inserted).toEqual([{ id: 'new-tx-id', ...expected }])
    expect(h.lifecycle.afterTransactionCreated).toHaveBeenCalledWith('new-tx-id', expected, ADMIN)
  })

  it('ACCOUNTANT books the expense with its own id as sender/creator; absent notes become null', async () => {
    const h = make()
    await h.svc.createExpense(base, ACCOUNTANT)
    expect(h.inserted[0]).toMatchObject({
      senderId: ACCOUNTANT.id,
      createdBy: ACCOUNTANT.id,
      notes: null,
    })
  })

  it('treats ADMIN_PERSONAL funding like the legacy path', async () => {
    const h = make()
    await h.svc.createExpense({ ...base, fundingSource: 'ADMIN_PERSONAL' }, ADMIN)
    expect(h.transaction).not.toHaveBeenCalled()
    expect(h.inserted[0]).toMatchObject({
      currency: 'EUR',
      senderId: ADMIN.id,
      senderLabel: null,
      fundingSource: null,
    })
  })

  it('validates a file receipt binding (with the db, the doc id and the caller) for a non-USDT expense', async () => {
    const h = make()
    await h.svc.createExpense(
      { amount: 5, currency: 'EUR', category: 'c', receiptDocumentId: 'doc-1' },
      ADMIN,
    )
    expect(assertBindableMock).toHaveBeenCalledWith(h.db.db, 'doc-1', ADMIN)
    expect(h.inserted[0]).toMatchObject({ receiptDocumentId: 'doc-1', receiptExternalUrl: null })
  })

  it('does not run the document-binding check when no document is attached', async () => {
    const h = make()
    await h.svc.createExpense(base, ADMIN)
    expect(assertBindableMock).not.toHaveBeenCalled()
  })

  it('a company-funded expense is USDT: a file receipt is refused even if the supplied currency is EUR', async () => {
    const h = make()
    await expect(
      h.svc.createExpense(
        {
          amount: 5,
          currency: 'EUR',
          category: 'c',
          receiptDocumentId: 'doc-1',
          fundingSource: 'COMPANY_ACCOUNT',
        },
        ADMIN,
      ),
    ).rejects.toMatchObject({ response: { code: 'RECEIPT_USDT_LINK_ONLY' } })
    expect(h.transaction).not.toHaveBeenCalled()
    expect(h.txInserted).toHaveLength(0)
  })

  it('a company-funded expense debits the company account inside the locked transaction', async () => {
    const h = make()
    const order: string[] = []
    lockMock.mockImplementation(async () => {
      order.push('lock')
    })
    balanceMock.mockImplementation(async () => {
      order.push('balance')
      return 50
    })

    const res = await h.svc.createExpense(
      {
        amount: 50,
        currency: 'EUR',
        category: 'Hosting',
        receiptExternalUrl: EXPLORER_URL,
        fundingSource: 'COMPANY_ACCOUNT',
      },
      ADMIN,
    )

    expect(res).toEqual({ id: 'new-tx-id' })
    expect(order).toEqual(['lock', 'balance'])
    expect(lockMock).toHaveBeenCalledWith(h.dbtx)
    expect(balanceMock).toHaveBeenCalledWith(h.dbtx)
    expect(h.inserted).toHaveLength(0)
    const expected = {
      type: 'EXPENSE',
      status: 'PAID',
      amount: '50',
      currency: 'USDT',
      senderId: null,
      senderLabel: COMPANY_ACCOUNT_LABEL,
      receiverLabel: 'Hosting',
      notes: null,
      receiptDocumentId: null,
      receiptExternalUrl: EXPLORER_URL,
      fundingSource: 'COMPANY_ACCOUNT',
      txDate: TX_DATE,
      createdBy: ADMIN.id,
    }
    expect(h.txInserted).toHaveLength(1)
    expect(h.txInserted[0]).toMatchObject({ id: 'new-tx-id', ...expected })
    expect(h.lifecycle.afterTransactionCreated).toHaveBeenCalledWith(
      'new-tx-id',
      expect.objectContaining({
        currency: 'USDT',
        senderId: null,
        fundingSource: 'COMPANY_ACCOUNT',
      }),
      ADMIN,
    )
  })

  it('refuses a company-funded expense above the live company balance and writes nothing', async () => {
    const h = make()
    balanceMock.mockResolvedValue(49.99)
    await expect(
      h.svc.createExpense(
        {
          amount: 50,
          currency: 'USDT',
          category: 'c',
          receiptExternalUrl: EXPLORER_URL,
          fundingSource: 'COMPANY_ACCOUNT',
        },
        ADMIN,
      ),
    ).rejects.toMatchObject({
      response: { code: 'FINANCE_COMPANY_ACCOUNT_INSUFFICIENT_FUNDS' },
      status: 400,
    })
    expect(h.txInserted).toHaveLength(0)
    expect(h.lifecycle.afterTransactionCreated).not.toHaveBeenCalled()
  })
})

describe('TransactionEntryService.createSalary', () => {
  const base = { receiverId: 'recv-1', amount: 100, salaryMonth: '2026-09', idempotencyKey: KEY }
  const employee = { id: 'recv-1', role: 'JUNIOR', archivedAt: null }
  // The persisted meaning of `base` (PR #868, SR-795-M-2), written out by hand.
  const BASE_INTENT = {
    version: 1,
    operation: 'MANUAL_SALARY_CREATE',
    receiverId: 'recv-1',
    amount: '100.000000',
    currency: 'USD',
    salaryMonth: '2026-09',
    notes: null,
    txDate: 'AUTO',
  }

  it('rejects any role other than ADMIN / ACCOUNTANT before touching the db', async () => {
    const h = make()
    await expect(h.svc.createSalary(base, JUNIOR)).rejects.toBeInstanceOf(ForbiddenException)
    expect(h.txFindFirst).not.toHaveBeenCalled()
  })

  it('requires an idempotency key', async () => {
    const h = make()
    await expect(h.svc.createSalary({ ...base, idempotencyKey: '' }, ADMIN)).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(h.txFindFirst).not.toHaveBeenCalled()
    expect(h.inserted).toHaveLength(0)
  })

  it('replays a prior SALARY with the same key: returns its id, writes nothing', async () => {
    const h = make({ txLookups: [{ id: 'old-salary', salaryCreationIntent: BASE_INTENT }] })
    const res = await h.svc.createSalary(base, ADMIN)
    expect(res).toEqual({ id: 'old-salary' })
    const [args] = h.txFindFirst.mock.calls[0] as unknown as [{ where: unknown }]
    expect(paramsOf(args.where)).toEqual(['SALARY', KEY])
    expect(h.usersFindFirst).not.toHaveBeenCalled()
    expect(h.inserted).toHaveLength(0)
    expect(h.lifecycle.afterTransactionCreated).not.toHaveBeenCalled()
  })

  it('looks the receiver up by id and 404s when missing', async () => {
    const h = make({ users: [undefined] })
    await expect(h.svc.createSalary(base, ADMIN)).rejects.toMatchObject({
      response: { code: 'USER_NOT_FOUND' },
      status: 404,
    })
    const [args] = h.usersFindFirst.mock.calls[0] as unknown as [{ where: unknown }]
    expect(paramsOf(args.where)).toEqual(['recv-1'])
  })

  it('refuses an ADMIN receiver', async () => {
    const h = make({ users: [{ ...employee, role: 'ADMIN' }] })
    await expect(h.svc.createSalary(base, ADMIN)).rejects.toMatchObject({
      response: { code: 'FINANCE_ADMIN_NO_SALARY' },
      status: 400,
    })
    expect(h.inserted).toHaveLength(0)
  })

  it('refuses a role outside the salary allow-list', async () => {
    const h = make({ users: [{ ...employee, role: 'GUEST' }] })
    await expect(h.svc.createSalary(base, ADMIN)).rejects.toMatchObject({
      response: { code: 'FINANCE_SALARY_ROLE_NOT_ELIGIBLE' },
      status: 400,
    })
  })

  it('refuses an archived receiver', async () => {
    const h = make({ users: [{ ...employee, archivedAt: new Date('2026-01-01') }] })
    await expect(h.svc.createSalary(base, ADMIN)).rejects.toMatchObject({
      response: { code: 'FINANCE_SALARY_RECEIVER_ARCHIVED' },
      status: 400,
    })
    expect(h.inserted).toHaveLength(0)
  })

  it.each(['JUNIOR', 'HR', 'ACCOUNTANT', 'SENIOR', 'DROP'])(
    'accepts a %s receiver',
    async (role) => {
      const h = make({ users: [{ ...employee, role }] })
      await expect(h.svc.createSalary(base, ACCOUNTANT)).resolves.toEqual({ id: 'new-tx-id' })
    },
  )

  it('inserts a neutral PENDING manual salary (default USD) and fires the lifecycle hook', async () => {
    const h = make({ users: [employee] })
    const res = await h.svc.createSalary({ ...base, notes: 'part 1', txDate: '2026-10-01' }, ADMIN)

    expect(res).toEqual({ id: 'new-tx-id' })
    expect(txDateMock).toHaveBeenCalledWith('2026-10-01')
    const expected = {
      type: 'SALARY',
      status: 'PENDING',
      amount: '100',
      currency: 'USD',
      senderId: null,
      senderLabel: 'CheekyCheeseIT',
      receiverId: 'recv-1',
      salaryMonth: '2026-09',
      salaryOrigin: 'MANUAL',
      salaryCreationIntent: { ...BASE_INTENT, notes: 'part 1', txDate: '2026-10-01' },
      idempotencyKey: KEY,
      notes: 'part 1',
      fundingSource: null,
      txDate: TX_DATE,
      createdBy: ADMIN.id,
    }
    // SR-795-M-1: the row is written inside the transaction that claims the
    // month marker, so it lands in the in-transaction insert log.
    expect(h.txInserted).toEqual([{ id: 'new-tx-id', ...expected }])
    expect(h.lifecycle.afterTransactionCreated).toHaveBeenCalledWith(
      'new-tx-id',
      { id: 'new-tx-id', ...expected },
      ADMIN,
    )
  })

  it('keeps the supplied currency and defaults absent notes to null', async () => {
    const h = make({ users: [employee] })
    await h.svc.createSalary({ ...base, currency: 'UAH' }, ADMIN)
    expect(h.txInserted[0]).toMatchObject({ currency: 'UAH', notes: null })
  })

  describe('concurrent idempotency race', () => {
    const race = Object.assign(new Error('dup'), {
      code: '23505',
      constraint: 'uq_transactions_salary_idempotency_key',
    })

    it('returns the id of the row that won the race', async () => {
      const h = make({
        users: [employee],
        txLookups: [undefined, { id: 'winner', salaryCreationIntent: BASE_INTENT }],
        insertError: race,
      })
      await expect(h.svc.createSalary(base, ADMIN)).resolves.toEqual({ id: 'winner' })
      const [args] = h.txFindFirst.mock.calls[1] as unknown as [{ where: unknown }]
      expect(paramsOf(args.where)).toEqual(['SALARY', KEY])
      expect(h.lifecycle.afterTransactionCreated).not.toHaveBeenCalled()
    })

    it('rethrows the violation when the winner cannot be found', async () => {
      const h = make({ users: [employee], txLookups: [undefined, undefined], insertError: race })
      await expect(h.svc.createSalary(base, ADMIN)).rejects.toBe(race)
    })

    it('rethrows a unique violation of a different constraint without a lookup', async () => {
      const other = Object.assign(new Error('dup'), { code: '23505', constraint: 'other_idx' })
      const h = make({ users: [employee], txLookups: [undefined, { id: 'x' }], insertError: other })
      await expect(h.svc.createSalary(base, ADMIN)).rejects.toBe(other)
      expect(h.txFindFirst).toHaveBeenCalledTimes(1)
    })

    it('rethrows a non-unique error', async () => {
      const boom = new Error('boom')
      const h = make({ users: [employee], insertError: boom })
      await expect(h.svc.createSalary(base, ADMIN)).rejects.toBe(boom)
    })
  })

  // SR-795-M-1 / owner decision D-3 (task-retro-salary-ledger-integrity). A
  // manual part used to leave `salary_month_initializations` alone, so a month
  // recorded by hand stayed unclaimed and the next cron run — or an ADMIN
  // pressing Backfill — minted a SECOND payable salary for the same person and
  // month. Manual QA measured it on a real stack. Under D-3 the first part
  // recorded for a receiver/month claims the marker, whoever recorded it.
  describe('claims the month marker (SR-795-M-1)', () => {
    it('claims receiver/month in the same transaction as the row, attributing the real operator', async () => {
      const h = make({ users: [employee] })
      await h.svc.createSalary(base, ADMIN)

      expect(h.transaction).toHaveBeenCalledTimes(1)
      expect(h.markerClaims).toEqual([
        { receiverId: 'recv-1', salaryMonth: '2026-09', initializedBy: ADMIN.id },
      ])
      expect(h.markerConflictArgs).toEqual({
        target: [salaryMonthInitializations.receiverId, salaryMonthInitializations.salaryMonth],
      })
      // The id is what tells a claim from a no-op, so the projection asking for
      // it is load-bearing: an empty `returning()` would make `claimed[0]`
      // undefined-shaped and the branch below it unreadable.
      expect(h.markerReturningProjection).toEqual({ id: salaryMonthInitializations.id })
      expect(h.txInserted).toHaveLength(1)
      // CR-M-3: "one transaction was opened and both writes happened" does not
      // say they happened in the SAME one — moving the row insert back onto the
      // pool would satisfy every assertion above. The harness logs pool-level
      // inserts separately, so an empty pool log is what actually pins it.
      expect(h.inserted).toHaveLength(0)
    })

    it('attributes the marker to the impersonator, not the impersonated admin', async () => {
      const h = make({ users: [employee] })
      await h.svc.createSalary(base, { ...ADMIN, impersonatorId: 'real-admin' })

      expect(h.markerClaims[0]).toMatchObject({ initializedBy: 'real-admin' })
    })

    it('still records the part when the month was already claimed (cron or a sibling part)', async () => {
      const h = make({ users: [employee], markerClaimed: false })
      await expect(h.svc.createSalary(base, ADMIN)).resolves.toEqual({ id: 'new-tx-id' })

      expect(h.markerClaims).toHaveLength(1)
      expect(h.txInserted).toHaveLength(1)
      expect(h.lifecycle.afterTransactionCreated).toHaveBeenCalledTimes(1)
    })
  })

  // SR-795-L-2. The idempotency index has no `deleted_at` term and the replay
  // lookup reads the raw table on purpose, so a deleted part kept answering
  // retries with HTTP 200 and its own id — a transaction every list endpoint
  // hides. The operator was told "saved" about a row that is not there.
  describe('a replay that lands on a soft-deleted part (SR-795-L-2)', () => {
    const DELETED = {
      id: 'tx-gone',
      deletedAt: new Date('2026-10-20T10:00:00Z'),
      salaryCreationIntent: BASE_INTENT,
    }

    it('refuses on the pre-insert lookup instead of reporting success', async () => {
      const h = make({ txLookups: [DELETED] })

      await expect(h.svc.createSalary(base, ADMIN)).rejects.toMatchObject({
        response: {
          code: 'FINANCE_SALARY_IDEMPOTENCY_CONFLICT',
          reason: 'DELETED_PART',
          existingTransactionId: 'tx-gone',
        },
      })
      expect(h.txInserted).toHaveLength(0)
      expect(h.markerClaims).toHaveLength(0)
    })

    it('refuses on the conflict-recovery lookup too', async () => {
      const h = make({
        users: [employee],
        txLookups: [undefined, DELETED],
        insertError: Object.assign(new Error('dup'), {
          code: '23505',
          constraint: 'uq_transactions_salary_idempotency_key',
        }),
      })

      await expect(h.svc.createSalary(base, ADMIN)).rejects.toMatchObject({
        response: { reason: 'DELETED_PART', existingTransactionId: 'tx-gone' },
      })
      expect(h.lifecycle.afterTransactionCreated).not.toHaveBeenCalled()
    })

    it('a live row with the same key still replays as before', async () => {
      const h = make({
        txLookups: [{ id: 'old-salary', deletedAt: null, salaryCreationIntent: BASE_INTENT }],
      })
      await expect(h.svc.createSalary(base, ADMIN)).resolves.toEqual({ id: 'old-salary' })
    })
  })
})

describe('TransactionEntryService.createAdminTransfer', () => {
  const partner = { id: 'partner-1', role: 'ADMIN', archivedAt: null }
  const base = { receiverId: 'partner-1', amount: 25, receiptExternalUrl: EXPLORER_URL }

  it('rejects any role other than ADMIN / ACCOUNTANT before touching the db', async () => {
    const h = make()
    await expect(h.svc.createAdminTransfer(base, SENIOR)).rejects.toBeInstanceOf(ForbiddenException)
    expect(h.usersFindFirst).not.toHaveBeenCalled()
  })

  it('an ACCOUNTANT must name the sender', async () => {
    const h = make()
    await expect(h.svc.createAdminTransfer(base, ACCOUNTANT)).rejects.toMatchObject({
      response: { code: 'FINANCE_TRANSFER_SENDER_ID_REQUIRED' },
      status: 400,
    })
    expect(h.usersFindFirst).not.toHaveBeenCalled()
  })

  it('an ACCOUNTANT-named sender must resolve to an ADMIN', async () => {
    const h = make({ users: [{ id: 's1', role: 'SENIOR' }] })
    await expect(
      h.svc.createAdminTransfer({ ...base, senderId: 's1' }, ACCOUNTANT),
    ).rejects.toMatchObject({
      response: { code: 'FINANCE_TRANSFER_SENDER_MUST_BE_ADMIN' },
      status: 400,
    })
    const [args] = h.usersFindFirst.mock.calls[0] as unknown as [{ where: unknown }]
    expect(paramsOf(args.where)).toEqual(['s1'])
  })

  it('an ACCOUNTANT-named sender that does not exist is refused', async () => {
    const h = make({ users: [undefined] })
    await expect(
      h.svc.createAdminTransfer({ ...base, senderId: 's1' }, ACCOUNTANT),
    ).rejects.toMatchObject({ response: { code: 'FINANCE_TRANSFER_SENDER_MUST_BE_ADMIN' } })
  })

  it('an ACCOUNTANT books a transfer between two admins, recording itself as creator', async () => {
    const h = make({ users: [{ id: 'sender-admin', role: 'ADMIN' }, partner] })
    const res = await h.svc.createAdminTransfer({ ...base, senderId: 'sender-admin' }, ACCOUNTANT)
    expect(res).toEqual({ id: 'new-tx-id' })
    expect(h.inserted[0]).toMatchObject({ senderId: 'sender-admin', createdBy: ACCOUNTANT.id })
  })

  it('an ADMIN always sends from self, ignoring a supplied senderId (no sender lookup)', async () => {
    const h = make({ users: [partner] })
    await h.svc.createAdminTransfer({ ...base, senderId: 'other-partner' }, ADMIN)
    expect(h.usersFindFirst).toHaveBeenCalledTimes(1)
    const [args] = h.usersFindFirst.mock.calls[0] as unknown as [{ where: unknown }]
    expect(paramsOf(args.where)).toEqual(['partner-1'])
    expect(h.inserted[0]).toMatchObject({ senderId: ADMIN.id })
  })

  it('404s on a missing receiver', async () => {
    const h = make({ users: [undefined] })
    await expect(h.svc.createAdminTransfer(base, ADMIN)).rejects.toMatchObject({
      response: { code: 'USER_NOT_FOUND' },
      status: 404,
    })
  })

  it('refuses a non-ADMIN receiver', async () => {
    const h = make({ users: [{ ...partner, role: 'SENIOR' }] })
    await expect(h.svc.createAdminTransfer(base, ADMIN)).rejects.toMatchObject({
      response: { code: 'FINANCE_TRANSFER_RECIPIENT_MUST_BE_ADMIN' },
      status: 400,
    })
  })

  it('refuses a transfer to oneself', async () => {
    const h = make({ users: [{ ...partner, id: ADMIN.id }] })
    await expect(
      h.svc.createAdminTransfer({ ...base, receiverId: ADMIN.id }, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(h.inserted).toHaveLength(0)
  })

  it('refuses an archived receiver', async () => {
    const h = make({ users: [{ ...partner, archivedAt: new Date('2026-01-01') }] })
    await expect(h.svc.createAdminTransfer(base, ADMIN)).rejects.toMatchObject({
      response: { code: 'FINANCE_TRANSFER_RECEIVER_ARCHIVED' },
      status: 400,
    })
    expect(h.inserted).toHaveLength(0)
  })

  it('requires a receipt', async () => {
    const h = make({ users: [partner] })
    await expect(
      h.svc.createAdminTransfer({ receiverId: 'partner-1', amount: 25 }, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'RECEIPT_REQUIRED' } })
    expect(h.inserted).toHaveLength(0)
  })

  it('defaults to USDT, so a file receipt is refused', async () => {
    const h = make({ users: [partner] })
    await expect(
      h.svc.createAdminTransfer(
        { receiverId: 'partner-1', amount: 25, receiptDocumentId: 'doc-1' },
        ADMIN,
      ),
    ).rejects.toMatchObject({ response: { code: 'RECEIPT_USDT_LINK_ONLY' } })
  })

  it('validates a file receipt binding for a non-USDT transfer', async () => {
    const h = make({ users: [partner] })
    await h.svc.createAdminTransfer(
      { receiverId: 'partner-1', amount: 25, currency: 'EUR', receiptDocumentId: 'doc-1' },
      ADMIN,
    )
    expect(assertBindableMock).toHaveBeenCalledWith(h.db.db, 'doc-1', ADMIN)
    expect(h.inserted[0]).toMatchObject({ currency: 'EUR', receiptDocumentId: 'doc-1' })
  })

  it('does not run the document-binding check for a link receipt', async () => {
    const h = make({ users: [partner] })
    await h.svc.createAdminTransfer(base, ADMIN)
    expect(assertBindableMock).not.toHaveBeenCalled()
  })

  it('inserts a PAID ADMIN_TRANSFER (default USDT) and fires the lifecycle hook', async () => {
    const h = make({ users: [partner] })
    const res = await h.svc.createAdminTransfer(
      { ...base, notes: 'settle', txDate: '2026-10-01' },
      ADMIN,
    )

    expect(res).toEqual({ id: 'new-tx-id' })
    expect(txDateMock).toHaveBeenCalledWith('2026-10-01')
    const expected = {
      id: 'new-tx-id',
      type: 'ADMIN_TRANSFER',
      status: 'PAID',
      amount: '25',
      currency: 'USDT',
      senderId: ADMIN.id,
      receiverId: 'partner-1',
      receiptDocumentId: null,
      receiptExternalUrl: EXPLORER_URL,
      notes: 'settle',
      txDate: TX_DATE,
      createdBy: ADMIN.id,
    }
    expect(h.inserted).toEqual([expected])
    expect(h.lifecycle.afterTransactionCreated).toHaveBeenCalledWith('new-tx-id', expected, ADMIN)
  })

  it('defaults absent notes to null', async () => {
    const h = make({ users: [partner] })
    await h.svc.createAdminTransfer(base, ADMIN)
    expect(h.inserted[0]).toMatchObject({ notes: null })
  })
})
