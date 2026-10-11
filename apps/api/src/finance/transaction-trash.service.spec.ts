/**
 * Collaborator-level pins for TransactionTrashService: the exact query shapes
 * and the concurrent-write (affected-row-count) branches that the facade specs
 * (transaction-soft-delete.spec.ts) run through a permissive mock and so cannot
 * observe.
 */
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import type { DatabaseService } from '../database/database.service'
import { pendingObligations, transactions } from '../database/schema'
import { TransactionTrashService } from './transaction-trash.service'

const TX_ID = '11111111-1111-4111-8111-111111111111'
const ADMIN = { id: 'admin-1', role: 'ADMIN' } as unknown as SessionUser

function makeDb(opts: {
  txRow?: Record<string, unknown> | undefined
  updatedRows?: Array<{ id: string }>
}) {
  const returning = vi.fn().mockResolvedValue(opts.updatedRows ?? [{ id: TX_ID }])
  const where = vi.fn().mockReturnValue({ returning })
  const set = vi.fn().mockReturnValue({ where })
  const update = vi.fn().mockReturnValue({ set })
  const values = vi.fn().mockResolvedValue([])
  const insert = vi.fn().mockReturnValue({ values })
  const obligationFindFirst = vi.fn().mockResolvedValue(null)
  const txFindFirst = vi.fn().mockResolvedValue(opts.txRow)
  const dbtx = {
    update,
    insert,
    query: { pendingObligations: { findFirst: obligationFindFirst } },
  }
  const db = {
    db: {
      query: { transactions: { findFirst: txFindFirst } },
      transaction: vi.fn((fn: (t: unknown) => Promise<unknown>) => fn(dbtx)),
    },
  } as unknown as DatabaseService
  return { db, txFindFirst, obligationFindFirst, update, where, returning }
}

const LIVE_ROW = { id: TX_ID, type: 'ADMIN_INCOME', amount: '10', currency: 'USD', deletedAt: null }
const DELETED_ROW = { ...LIVE_ROW, deletedAt: new Date(), deletionReason: 'oops' }

describe('TransactionTrashService.adminDeleteTransaction', () => {
  it('looks the row up by id, checks obligations by source id, and guards the update', async () => {
    const m = makeDb({ txRow: LIVE_ROW })
    await new TransactionTrashService(m.db).adminDeleteTransaction(TX_ID, 'reason', ADMIN)

    expect(m.txFindFirst).toHaveBeenCalledWith({ where: eq(transactions.id, TX_ID) })
    expect(m.obligationFindFirst).toHaveBeenCalledWith({
      where: eq(pendingObligations.sourceTransactionId, TX_ID),
    })
    expect(m.where).toHaveBeenCalledWith(
      and(eq(transactions.id, TX_ID), isNull(transactions.deletedAt)),
    )
    expect(m.returning).toHaveBeenCalledWith({ id: transactions.id })
  })

  it('rejects when a concurrent delete already took the row (0 rows updated)', async () => {
    const m = makeDb({ txRow: LIVE_ROW, updatedRows: [] })
    await expect(
      new TransactionTrashService(m.db).adminDeleteTransaction(TX_ID, 'reason', ADMIN),
    ).rejects.toMatchObject({ response: { code: 'FINANCE_TRANSACTION_ALREADY_DELETED' } })
  })
})

describe('TransactionTrashService.restoreTransactionRow', () => {
  it('looks the row up by id and guards the update on deleted_at IS NOT NULL', async () => {
    const m = makeDb({ txRow: DELETED_ROW })
    await new TransactionTrashService(m.db).restoreTransactionRow(TX_ID, 'reason', ADMIN)

    expect(m.txFindFirst).toHaveBeenCalledWith({ where: eq(transactions.id, TX_ID) })
    expect(m.where).toHaveBeenCalledWith(
      and(eq(transactions.id, TX_ID), isNotNull(transactions.deletedAt)),
    )
    expect(m.returning).toHaveBeenCalledWith({ id: transactions.id })
  })

  it('rejects when a concurrent restore already took the row (0 rows updated)', async () => {
    const m = makeDb({ txRow: DELETED_ROW, updatedRows: [] })
    await expect(
      new TransactionTrashService(m.db).restoreTransactionRow(TX_ID, 'reason', ADMIN),
    ).rejects.toMatchObject({ response: { code: 'FINANCE_TRANSACTION_NOT_DELETED' } })
  })
})

describe('TransactionTrashService.getTransactionAuditLog', () => {
  it('fetches only deletedAt for the visibility check, by id', async () => {
    const m = makeDb({ txRow: { deletedAt: null } })
    const select = vi.fn().mockReturnValue({
      from: () => ({
        leftJoin: () => ({ where: () => ({ orderBy: () => Promise.resolve([]) }) }),
      }),
    })
    ;(m.db.db as unknown as { select: unknown }).select = select

    await expect(
      new TransactionTrashService(m.db).getTransactionAuditLog(TX_ID, ADMIN),
    ).resolves.toEqual([])
    expect(m.txFindFirst).toHaveBeenCalledWith({
      where: eq(transactions.id, TX_ID),
      columns: { deletedAt: true },
    })
  })

  it('404s when the transaction does not exist', async () => {
    const m = makeDb({ txRow: undefined })
    await expect(
      new TransactionTrashService(m.db).getTransactionAuditLog(TX_ID, ADMIN),
    ).rejects.toMatchObject({ response: { code: 'FINANCE_TRANSACTION_NOT_FOUND' } })
  })
})
