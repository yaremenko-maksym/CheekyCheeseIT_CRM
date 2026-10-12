/**
 * PayoutConfirmationService — unit net for validate / reject of income rows and the
 * manual payout confirmation (moved verbatim out of TransactionsService).
 *
 * The collaborator is built directly over a recording Drizzle double: every
 * `update(...).set(...).where(...).returning(...)` and `insert(...).values(...)` the
 * service issues is captured so the tests assert the WRITTEN payloads, the compiled
 * WHERE predicates (via `PgDialect`, the real Drizzle SQL — never a hand-typed
 * restatement) and the target tables, not just that "something resolved".
 */
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { payoutRequests, transactionAuditLog, transactions } from '../database/schema'
import type { DatabaseService } from '../database/database.service'
import { PayoutConfirmationService } from './payout-confirmation.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import type { TransactionLifecycleService } from './transaction-lifecycle.service'

const NOW = new Date('2026-10-12T10:00:00.000Z')
const NOW_ISO = NOW.toISOString()

function user(role: SessionUser['role'], id: string, extra: Partial<SessionUser> = {}) {
  return {
    id,
    role,
    displayName: id,
    email: `${id}@x.com`,
    avatarUrl: null,
    avatarDocumentId: null,
    seniorSharePercent: 26,
    ...extra,
  } as SessionUser
}
const ADMIN = user('ADMIN', 'admin-actor')
const ACCOUNTANT = user('ACCOUNTANT', 'accountant-1')
const SENIOR = user('SENIOR', 'senior-1')
const HR = user('HR', 'hr-1')

function compiled(where: unknown) {
  return new PgDialect().sqlToQuery(where as SQL)
}

interface UpdateCall {
  table: unknown
  set: Record<string, unknown>
  where: unknown
  returning: unknown
}
interface InsertCall {
  table: unknown
  values: Record<string, unknown>
}

function makeHarness(opts: {
  /** Rows returned by successive `transactions.findFirst` calls. */
  txRows?: unknown[]
  user?: unknown
  /** Rows returned by successive `update().returning()` calls; default one row. */
  updateReturns?: unknown[][]
}) {
  const updates: UpdateCall[] = []
  const inserts: InsertCall[] = []
  const txQueue = [...(opts.txRows ?? [])]
  const updateQueue = [...(opts.updateReturns ?? [])]
  const txFindFirst = vi.fn(async () => txQueue.shift())
  const usersFindFirst = vi.fn(async () => opts.user)
  const dbtx = {
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: unknown) => ({
          returning: async (returning: unknown) => {
            updates.push({ table, set, where, returning })
            return updateQueue.length > 0 ? updateQueue.shift() : [{ id: 'updated' }]
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        inserts.push({ table, values })
      },
    }),
  }
  const transaction = vi.fn(async (cb: (tx: typeof dbtx) => Promise<unknown>) => cb(dbtx))
  const db = {
    db: {
      query: {
        transactions: { findFirst: txFindFirst },
        users: { findFirst: usersFindFirst },
      },
      transaction,
    },
  } as unknown as DatabaseService
  const notify = vi.fn().mockResolvedValue(undefined)
  const lifecycle = {
    notifyTransactionStatusChanged: notify,
  } as unknown as TransactionLifecycleService
  const svc = new PayoutConfirmationService(db, lifecycle)
  return { svc, updates, inserts, txFindFirst, usersFindFirst, transaction, notify }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

// ── validateTransaction ────────────────────────────────────────────────────

const INCOME = {
  id: 'inc-1',
  type: 'SENIOR_INCOME',
  status: 'PENDING',
  amount: '1000',
  currency: 'USD',
  deletedAt: null,
}

describe('validateTransaction — guards', () => {
  it.each([SENIOR, HR])(
    'refuses %# non-finance role with 403 before touching the db',
    async (u) => {
      const h = makeHarness({ txRows: [INCOME] })
      await expect(h.svc.validateTransaction('inc-1', 'validate', null, u)).rejects.toMatchObject({
        status: 403,
      })
      expect(h.txFindFirst).not.toHaveBeenCalled()
    },
  )

  it.each([ADMIN, ACCOUNTANT])('lets %# through the role gate', async (u) => {
    const h = makeHarness({ txRows: [INCOME] })
    await expect(h.svc.validateTransaction('inc-1', 'validate', null, u)).resolves.toBeUndefined()
  })

  it('looks the row up by id', async () => {
    const h = makeHarness({ txRows: [INCOME] })
    await h.svc.validateTransaction('inc-1', 'validate', null, ADMIN)
    const arg = h.txFindFirst.mock.calls[0] as unknown as [{ where: unknown }]
    expect(compiled(arg[0].where).params).toEqual(['inc-1'])
  })

  it('404 when the row does not exist', async () => {
    const h = makeHarness({ txRows: [undefined] })
    await expect(
      h.svc.validateTransaction('missing', 'validate', null, ADMIN),
    ).rejects.toMatchObject({
      status: 404,
      response: { code: 'FINANCE_TRANSACTION_NOT_FOUND' },
    })
  })

  it('refuses a soft-deleted row (assertTransactionWritable) before any write', async () => {
    const h = makeHarness({ txRows: [{ ...INCOME, deletedAt: new Date('2026-01-01') }] })
    await expect(h.svc.validateTransaction('inc-1', 'validate', null, ADMIN)).rejects.toBeDefined()
    expect(h.transaction).not.toHaveBeenCalled()
  })

  it.each(['PAYOUT', 'EXPENSE'])('400 FINANCE_VALIDATE_WRONG_TYPE for a %s row', async (type) => {
    const h = makeHarness({ txRows: [{ ...INCOME, type }] })
    await expect(h.svc.validateTransaction('inc-1', 'validate', null, ADMIN)).rejects.toMatchObject(
      {
        status: 400,
        response: { code: 'FINANCE_VALIDATE_WRONG_TYPE' },
      },
    )
    expect(h.transaction).not.toHaveBeenCalled()
  })

  it('accepts DROP_INCOME as well as SENIOR_INCOME', async () => {
    const h = makeHarness({ txRows: [{ ...INCOME, type: 'DROP_INCOME' }] })
    await expect(
      h.svc.validateTransaction('inc-1', 'validate', null, ADMIN),
    ).resolves.toBeUndefined()
  })

  it.each(['VALIDATED', 'REJECTED', 'PAID'])(
    '400 FINANCE_TRANSACTION_NOT_PENDING when the row is %s',
    async (status) => {
      const h = makeHarness({ txRows: [{ ...INCOME, status }] })
      await expect(
        h.svc.validateTransaction('inc-1', 'validate', null, ADMIN),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'FINANCE_TRANSACTION_NOT_PENDING' },
      })
      expect(h.transaction).not.toHaveBeenCalled()
    },
  )
})

describe('validateTransaction — validate', () => {
  it('flips to VALIDATED, journals VALIDATE and notifies after commit', async () => {
    const h = makeHarness({ txRows: [INCOME] })
    await h.svc.validateTransaction('inc-1', 'validate', null, ADMIN)

    expect(h.updates).toHaveLength(1)
    const [upd] = h.updates
    expect(upd?.table).toBe(transactions)
    expect(upd?.set).toEqual({
      status: 'VALIDATED',
      validatedBy: 'admin-actor',
      validatedAt: NOW,
      updatedAt: NOW,
    })
    const q = compiled(upd?.where)
    expect(q.params).toEqual(['inc-1'])
    expect(q.sql).toContain('is null')
    expect(upd?.returning).toHaveProperty('id')

    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0]?.table).toBe(transactionAuditLog)
    expect(h.inserts[0]?.values).toEqual({
      actorId: 'admin-actor',
      targetId: 'inc-1',
      action: 'VALIDATE',
      metadata: { type: 'SENIOR_INCOME', amount: '1000', currency: 'USD' },
    })
    expect(h.notify).toHaveBeenCalledTimes(1)
    expect(h.notify).toHaveBeenCalledWith('inc-1', 'VALIDATED', null, ADMIN)
  })

  it('stamps the REAL operator (impersonator) on validatedBy and the journal', async () => {
    const h = makeHarness({ txRows: [INCOME] })
    const session = { ...ADMIN, impersonatorId: 'real-admin' } as SessionUser
    await h.svc.validateTransaction('inc-1', 'validate', null, session)
    expect(h.updates[0]?.set).toMatchObject({ validatedBy: 'real-admin' })
    expect(h.inserts[0]?.values).toMatchObject({ actorId: 'real-admin' })
  })

  it('aborts with 400 when the row was deleted in flight: no journal, no notification', async () => {
    const h = makeHarness({ txRows: [INCOME], updateReturns: [[]] })
    await expect(h.svc.validateTransaction('inc-1', 'validate', null, ADMIN)).rejects.toMatchObject(
      {
        status: 400,
        response: { code: 'FINANCE_TRANSACTION_DELETED_RESTORE_FIRST' },
      },
    )
    expect(h.inserts).toHaveLength(0)
    expect(h.notify).not.toHaveBeenCalled()
  })
})

describe('validateTransaction — reject', () => {
  it.each([null, undefined, ''])(
    '400 FINANCE_REJECTION_REASON_REQUIRED for reason %j',
    async (r) => {
      const h = makeHarness({ txRows: [INCOME] })
      await expect(h.svc.validateTransaction('inc-1', 'reject', r, ADMIN)).rejects.toMatchObject({
        status: 400,
        response: { code: 'FINANCE_REJECTION_REASON_REQUIRED' },
      })
      expect(h.transaction).not.toHaveBeenCalled()
    },
  )

  it('flips to REJECTED with the reason, journals REJECT and notifies with the reason', async () => {
    const h = makeHarness({ txRows: [INCOME] })
    await h.svc.validateTransaction('inc-1', 'reject', 'blurry receipt', ACCOUNTANT)

    expect(h.updates).toHaveLength(1)
    const [upd] = h.updates
    expect(upd?.table).toBe(transactions)
    expect(upd?.set).toEqual({
      status: 'REJECTED',
      validatedBy: 'accountant-1',
      validatedAt: NOW,
      rejectionReason: 'blurry receipt',
      updatedAt: NOW,
    })
    const q = compiled(upd?.where)
    expect(q.params).toEqual(['inc-1'])
    expect(q.sql).toContain('is null')
    expect(upd?.returning).toHaveProperty('id')

    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0]?.table).toBe(transactionAuditLog)
    expect(h.inserts[0]?.values).toEqual({
      actorId: 'accountant-1',
      targetId: 'inc-1',
      action: 'REJECT',
      metadata: {
        type: 'SENIOR_INCOME',
        amount: '1000',
        currency: 'USD',
        rejectionReason: 'blurry receipt',
      },
    })
    expect(h.notify).toHaveBeenCalledWith('inc-1', 'REJECTED', 'blurry receipt', ACCOUNTANT)
  })

  it('stamps the REAL operator (impersonator) on a reject', async () => {
    const h = makeHarness({ txRows: [INCOME] })
    const session = { ...ADMIN, impersonatorId: 'real-admin' } as SessionUser
    await h.svc.validateTransaction('inc-1', 'reject', 'no', session)
    expect(h.updates[0]?.set).toMatchObject({ validatedBy: 'real-admin' })
    expect(h.inserts[0]?.values).toMatchObject({ actorId: 'real-admin' })
  })

  it('aborts with 400 when the row was deleted in flight: no journal, no notification', async () => {
    const h = makeHarness({ txRows: [INCOME], updateReturns: [[]] })
    await expect(h.svc.validateTransaction('inc-1', 'reject', 'no', ADMIN)).rejects.toMatchObject({
      status: 400,
      response: { code: 'FINANCE_TRANSACTION_DELETED_RESTORE_FIRST' },
    })
    expect(h.inserts).toHaveLength(0)
    expect(h.notify).not.toHaveBeenCalled()
  })
})

// ── confirmPayout ──────────────────────────────────────────────────────────

const HASH = '0xabcdef1234567890'
const RECIPIENT = { id: 'recipient-admin', role: 'ADMIN', archivedAt: null }

function payoutRow(over: Record<string, unknown> = {}) {
  return {
    id: 'payout-1',
    type: 'PAYOUT',
    status: 'PENDING_PAYMENT',
    amount: '740',
    currency: 'USDT',
    senderId: 'senior-1',
    projectId: 'project-1',
    payoutRequestId: 'req-1',
    txDate: new Date('2026-10-10T00:00:00.000Z'),
    createdAt: new Date('2026-10-09T12:00:00.000Z'),
    ...over,
  }
}

const readBack = vi.fn(async (id: string) => `dto:${id}`)

function confirmHarness(over: { payout?: Record<string, unknown>; user?: unknown } = {}) {
  return makeHarness({
    txRows: [payoutRow(over.payout), { id: 'credit-1' }],
    user: 'user' in over ? over.user : RECIPIENT,
  })
}

describe('confirmPayout — guards', () => {
  it.each([SENIOR, HR])('403 for %# non-finance role before touching the db', async (u) => {
    const h = confirmHarness()
    await expect(
      h.svc.confirmPayout('payout-1', 'recipient-admin', u, { txHash: HASH }, readBack),
    ).rejects.toMatchObject({ status: 403 })
    expect(h.txFindFirst).not.toHaveBeenCalled()
  })

  it.each([ADMIN, ACCOUNTANT])('lets %# through the role gate', async (u) => {
    const h = confirmHarness()
    await expect(
      h.svc.confirmPayout('payout-1', 'recipient-admin', u, { txHash: HASH }, readBack),
    ).resolves.toBeDefined()
  })

  it('defaults to CRYPTO: no options → 400 FINANCE_CRYPTO_TX_HASH_TOO_SHORT', async () => {
    const h = confirmHarness()
    await expect(
      h.svc.confirmPayout('payout-1', 'recipient-admin', ADMIN, undefined, readBack),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'FINANCE_CRYPTO_TX_HASH_TOO_SHORT' },
    })
    expect(h.txFindFirst).not.toHaveBeenCalled()
  })

  it('CRYPTO with a 9-character hash is too short', async () => {
    const h = confirmHarness()
    await expect(
      h.svc.confirmPayout('payout-1', 'recipient-admin', ADMIN, { txHash: '123456789' }, readBack),
    ).rejects.toMatchObject({ response: { code: 'FINANCE_CRYPTO_TX_HASH_TOO_SHORT' } })
  })

  it('CRYPTO with an EXACTLY 10-character hash is accepted', async () => {
    const h = confirmHarness()
    await expect(
      h.svc.confirmPayout('payout-1', 'recipient-admin', ADMIN, { txHash: '1234567890' }, readBack),
    ).resolves.toBeDefined()
  })

  it('a whitespace-only hash is trimmed away and rejected', async () => {
    const h = confirmHarness()
    await expect(
      h.svc.confirmPayout(
        'payout-1',
        'recipient-admin',
        ADMIN,
        { txHash: '              ' },
        readBack,
      ),
    ).rejects.toMatchObject({ response: { code: 'FINANCE_CRYPTO_TX_HASH_TOO_SHORT' } })
  })

  it('records the TRIMMED hash', async () => {
    const h = confirmHarness()
    await h.svc.confirmPayout(
      'payout-1',
      'recipient-admin',
      ADMIN,
      { txHash: `  ${HASH}  ` },
      readBack,
    )
    expect(h.updates[0]?.set).toMatchObject({ txHash: HASH })
    expect(h.inserts[0]?.values).toMatchObject({ txHash: HASH })
  })

  it('looks the PAYOUT up by id', async () => {
    const h = confirmHarness()
    await h.svc.confirmPayout('payout-1', 'recipient-admin', ADMIN, { txHash: HASH }, readBack)
    const arg = h.txFindFirst.mock.calls[0] as unknown as [{ where: unknown }]
    expect(compiled(arg[0].where).params).toEqual(['payout-1'])
  })

  it('404 when the PAYOUT does not exist', async () => {
    const h = makeHarness({ txRows: [undefined], user: RECIPIENT })
    await expect(
      h.svc.confirmPayout('nope', 'recipient-admin', ADMIN, { txHash: HASH }, readBack),
    ).rejects.toMatchObject({ status: 404, response: { code: 'FINANCE_TRANSACTION_NOT_FOUND' } })
  })

  it('400 FINANCE_CONFIRM_PAYOUT_ONLY for a non-PAYOUT row', async () => {
    const h = confirmHarness({ payout: { type: 'SENIOR_INCOME' } })
    await expect(
      h.svc.confirmPayout('payout-1', 'recipient-admin', ADMIN, { txHash: HASH }, readBack),
    ).rejects.toMatchObject({ status: 400, response: { code: 'FINANCE_CONFIRM_PAYOUT_ONLY' } })
  })

  it('400 FINANCE_PAYOUT_NOT_PENDING_PAYMENT for an already-PAID PAYOUT', async () => {
    const h = confirmHarness({ payout: { status: 'PAID' } })
    await expect(
      h.svc.confirmPayout('payout-1', 'recipient-admin', ADMIN, { txHash: HASH }, readBack),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'FINANCE_PAYOUT_NOT_PENDING_PAYMENT' },
    })
    expect(h.transaction).not.toHaveBeenCalled()
  })

  it('400 when the confirmation date precedes the obligation date (txDate)', async () => {
    const h = confirmHarness()
    await expect(
      h.svc.confirmPayout(
        'payout-1',
        'recipient-admin',
        ADMIN,
        { txHash: HASH, txDate: '2026-10-09' },
        readBack,
      ),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION' },
    })
    expect(h.transaction).not.toHaveBeenCalled()
  })

  it('a confirmation date EQUAL to the obligation date is allowed', async () => {
    const h = confirmHarness()
    await expect(
      h.svc.confirmPayout(
        'payout-1',
        'recipient-admin',
        ADMIN,
        { txHash: HASH, txDate: '2026-10-10' },
        readBack,
      ),
    ).resolves.toBeDefined()
  })

  it('falls back to createdAt as the obligation date when txDate is null', async () => {
    const h = confirmHarness({
      payout: { txDate: null, createdAt: new Date('2026-10-11T08:00:00.000Z') },
    })
    await expect(
      h.svc.confirmPayout(
        'payout-1',
        'recipient-admin',
        ADMIN,
        { txHash: HASH, txDate: '2026-10-10' },
        readBack,
      ),
    ).rejects.toMatchObject({ response: { code: 'FINANCE_PAYOUT_DATE_BEFORE_OBLIGATION' } })
  })

  it('looks the recipient up by id', async () => {
    const h = confirmHarness()
    await h.svc.confirmPayout('payout-1', 'recipient-admin', ADMIN, { txHash: HASH }, readBack)
    const arg = h.usersFindFirst.mock.calls[0] as unknown as [{ where: unknown }]
    expect(compiled(arg[0].where).params).toEqual(['recipient-admin'])
  })

  it('400 FINANCE_RECIPIENT_ADMIN_NOT_FOUND when the recipient is missing', async () => {
    const h = confirmHarness({ user: undefined })
    await expect(
      h.svc.confirmPayout('payout-1', 'ghost', ADMIN, { txHash: HASH }, readBack),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'FINANCE_RECIPIENT_ADMIN_NOT_FOUND' },
    })
  })

  it('400 FINANCE_RECIPIENT_MUST_BE_ADMIN for a non-ADMIN recipient', async () => {
    const h = confirmHarness({ user: { ...RECIPIENT, role: 'SENIOR' } })
    await expect(
      h.svc.confirmPayout('payout-1', 'recipient-admin', ADMIN, { txHash: HASH }, readBack),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'FINANCE_RECIPIENT_MUST_BE_ADMIN' },
    })
  })

  it('400 FINANCE_RECIPIENT_ADMIN_ARCHIVED for an archived admin recipient', async () => {
    const h = confirmHarness({ user: { ...RECIPIENT, archivedAt: new Date('2026-01-01') } })
    await expect(
      h.svc.confirmPayout('payout-1', 'recipient-admin', ADMIN, { txHash: HASH }, readBack),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'FINANCE_RECIPIENT_ADMIN_ARCHIVED' },
    })
  })

  it('400 (self-pay) when the PAYOUT sender is the recipient; nothing is written', async () => {
    const h = confirmHarness({ payout: { senderId: 'recipient-admin' } })
    await expect(
      h.svc.confirmPayout('payout-1', 'recipient-admin', ADMIN, { txHash: HASH }, readBack),
    ).rejects.toMatchObject({ status: 400 })
    expect(h.transaction).not.toHaveBeenCalled()
  })
})

describe('confirmPayout — writes', () => {
  const NOTE = `Manual payout confirmation by admin-actor at ${NOW_ISO} (method=CRYPTO)`

  it('CRYPTO: claims the PAYOUT, flips the payout request, inserts the credit row', async () => {
    const h = confirmHarness()
    await h.svc.confirmPayout(
      'payout-1',
      'recipient-admin',
      ADMIN,
      { method: 'CRYPTO', txHash: HASH },
      readBack,
    )

    expect(h.updates).toHaveLength(2)
    const [claim, request] = h.updates
    expect(claim?.table).toBe(transactions)
    expect(claim?.set).toEqual({
      status: 'PAID',
      validatedBy: 'admin-actor',
      validatedAt: NOW,
      txDate: NOW,
      updatedAt: NOW,
      txHash: HASH,
    })
    expect(compiled(claim?.where).params).toEqual(['payout-1', 'PENDING_PAYMENT'])
    expect(claim?.returning).toHaveProperty('id')

    expect(request?.table).toBe(payoutRequests)
    expect(request?.set).toEqual({ status: 'PAID', updatedAt: NOW })
    expect(compiled(request?.where).params).toEqual(['req-1', 'PENDING'])
    expect(request?.returning).toHaveProperty('id')

    expect(h.inserts).toHaveLength(1)
    expect(h.inserts[0]?.table).toBe(transactions)
    expect(h.inserts[0]?.values).toEqual({
      type: 'PAYOUT_CONFIRMED',
      status: 'PAID',
      amount: '740',
      currency: 'USDT',
      senderId: 'senior-1',
      senderLabel: 'PAYOUT_METHOD:CRYPTO',
      receiverId: 'recipient-admin',
      recipientId: 'recipient-admin',
      projectId: 'project-1',
      payoutRequestId: 'req-1',
      txHash: HASH,
      notes: NOTE,
      txDate: NOW,
      createdBy: 'admin-actor',
    })
  })

  it('CASH: no txHash on the claim or the credit row, CASH marker and note', async () => {
    const h = confirmHarness()
    await h.svc.confirmPayout('payout-1', 'recipient-admin', ADMIN, { method: 'CASH' }, readBack)

    expect(h.updates[0]?.set).not.toHaveProperty('txHash')
    expect(h.inserts[0]?.values).toMatchObject({
      senderLabel: 'PAYOUT_METHOD:CASH',
      txHash: null,
      notes: `Manual payout confirmation by admin-actor at ${NOW_ISO} (method=CASH)`,
    })
  })

  it('CASH ignores a supplied hash (never recorded)', async () => {
    const h = confirmHarness()
    await h.svc.confirmPayout(
      'payout-1',
      'recipient-admin',
      ADMIN,
      { method: 'CASH', txHash: HASH },
      readBack,
    )
    expect(h.updates[0]?.set).not.toHaveProperty('txHash')
    expect(h.inserts[0]?.values).toMatchObject({ txHash: null })
  })

  it('uses the supplied txDate (resolved) on the claim and the credit row', async () => {
    const h = confirmHarness()
    await h.svc.confirmPayout(
      'payout-1',
      'recipient-admin',
      ADMIN,
      { txHash: HASH, txDate: '2026-10-11' },
      readBack,
    )
    const expected = new Date('2026-10-11T00:00:00.000Z')
    expect(h.updates[0]?.set).toMatchObject({ txDate: expected })
    expect(h.inserts[0]?.values).toMatchObject({ txDate: expected })
  })

  it('no payout request linked: only the PAYOUT is claimed', async () => {
    const h = confirmHarness({ payout: { payoutRequestId: null } })
    await h.svc.confirmPayout('payout-1', 'recipient-admin', ADMIN, { txHash: HASH }, readBack)
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0]?.table).toBe(transactions)
    expect(h.inserts[0]?.values).toMatchObject({ payoutRequestId: null })
  })

  it('attributes the claim and the note to the REAL operator under impersonation', async () => {
    const h = confirmHarness()
    const session = { ...ADMIN, impersonatorId: 'real-admin' } as SessionUser
    await h.svc.confirmPayout('payout-1', 'recipient-admin', session, { txHash: HASH }, readBack)
    expect(h.updates[0]?.set).toMatchObject({ validatedBy: 'real-admin' })
    expect(h.inserts[0]?.values).toMatchObject({
      createdBy: 'admin-actor',
      notes: `Manual payout confirmation by real-admin at ${NOW_ISO} (method=CRYPTO)`,
    })
  })

  it('lost the claim race (0 rows): 400, no request flip, no credit insert', async () => {
    const h = makeHarness({
      txRows: [payoutRow(), { id: 'credit-1' }],
      user: RECIPIENT,
      updateReturns: [[]],
    })
    await expect(
      h.svc.confirmPayout('payout-1', 'recipient-admin', ADMIN, { txHash: HASH }, readBack),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'FINANCE_PAYOUT_NOT_PENDING_PAYMENT' },
    })
    expect(h.updates).toHaveLength(1)
    expect(h.inserts).toHaveLength(0)
  })
})

describe('confirmPayout — read-back', () => {
  it('reads the PAYOUT then the credit row through the facade callback', async () => {
    readBack.mockClear()
    const h = confirmHarness()
    const result = await h.svc.confirmPayout(
      'payout-1',
      'recipient-admin',
      ADMIN,
      { txHash: HASH },
      readBack,
    )
    expect(result).toEqual({ payout: 'dto:payout-1', confirmed: 'dto:credit-1' })
    expect(readBack.mock.calls.map((c) => c[0])).toEqual(['payout-1', 'credit-1'])
  })

  it('locates the credit row by type, request, recipient and note, newest first', async () => {
    const h = confirmHarness()
    await h.svc.confirmPayout('payout-1', 'recipient-admin', ADMIN, { txHash: HASH }, readBack)
    const arg = h.txFindFirst.mock.calls[1] as unknown as [{ where: unknown; orderBy: unknown[] }]
    expect(compiled(arg[0].where).params).toEqual([
      'PAYOUT_CONFIRMED',
      'req-1',
      'recipient-admin',
      `Manual payout confirmation by admin-actor at ${NOW_ISO} (method=CRYPTO)`,
    ])
    expect(arg[0].orderBy).toHaveLength(1)
  })

  it('without a payout request the lookup omits the request predicate (no empty uuid)', async () => {
    const h = confirmHarness({ payout: { payoutRequestId: null } })
    await h.svc.confirmPayout('payout-1', 'recipient-admin', ADMIN, { txHash: HASH }, readBack)
    const arg = h.txFindFirst.mock.calls[1] as unknown as [{ where: unknown }]
    expect(compiled(arg[0].where).params).toEqual([
      'PAYOUT_CONFIRMED',
      'recipient-admin',
      `Manual payout confirmation by admin-actor at ${NOW_ISO} (method=CRYPTO)`,
    ])
  })

  it('confirmed is null when the credit row cannot be found', async () => {
    const h = makeHarness({ txRows: [payoutRow(), undefined], user: RECIPIENT })
    const result = await h.svc.confirmPayout(
      'payout-1',
      'recipient-admin',
      ADMIN,
      { txHash: HASH },
      readBack,
    )
    expect(result.confirmed).toBeNull()
  })
})

// ── TransactionsService facade wiring ──────────────────────────────────────

describe('TransactionsService facade — viewer-scoped read-back stays on the facade', () => {
  function makeFacade() {
    const svc = makeTransactionsService({ db: {} as DatabaseService })
    const findOne = vi.spyOn(svc, 'findOne').mockImplementation(async (id: string) => {
      return `facade:${id}` as never
    })
    const collaborator = (
      svc as unknown as {
        payoutConfirmation: {
          validateTransaction: (...args: unknown[]) => Promise<void>
          confirmPayout: (...args: unknown[]) => Promise<unknown>
        }
      }
    ).payoutConfirmation
    return { svc, findOne, collaborator }
  }

  it('validateTransaction commits via the collaborator, then reads back with findOne', async () => {
    const { svc, findOne, collaborator } = makeFacade()
    const validate = vi.spyOn(collaborator, 'validateTransaction').mockResolvedValue(undefined)

    const result = await svc.validateTransaction('inc-1', 'reject', 'why', ADMIN)

    expect(validate).toHaveBeenCalledWith('inc-1', 'reject', 'why', ADMIN)
    expect(findOne).toHaveBeenCalledWith('inc-1', ADMIN)
    expect(result).toBe('facade:inc-1')
  })

  it('confirmPayout hands the collaborator a readBack that is the facade findOne', async () => {
    const { svc, findOne, collaborator } = makeFacade()
    const options = { method: 'CASH' as const }
    const confirm = vi
      .spyOn(collaborator, 'confirmPayout')
      .mockImplementation(async (...args: unknown[]) => {
        const back = args[4] as (id: string) => Promise<unknown>
        return { payout: await back('payout-1'), confirmed: null }
      })

    const result = await svc.confirmPayout('payout-1', 'recipient-admin', ADMIN, options)

    expect(confirm).toHaveBeenCalledWith(
      'payout-1',
      'recipient-admin',
      ADMIN,
      options,
      expect.any(Function),
    )
    expect(findOne).toHaveBeenCalledWith('payout-1', ADMIN)
    expect(result).toEqual({ payout: 'facade:payout-1', confirmed: null })
  })
})
