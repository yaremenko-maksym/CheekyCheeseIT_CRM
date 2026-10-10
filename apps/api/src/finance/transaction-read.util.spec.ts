import { ForbiddenException } from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { SessionUser } from '@crm/shared'
import type * as schema from '../database/schema'
import { loadTransactionForViewer } from './transaction-read.util'

const ME = 'me-1'
const OTHER = 'other-1'

function user(role: string): SessionUser {
  return { id: ME, role } as unknown as SessionUser
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    type: 'INCOME',
    status: 'COMPLETED',
    senderId: OTHER,
    receiverId: ME,
    senderLabel: null,
    receiverLabel: null,
    fundingSource: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    payoutRequestId: null,
    payoutRequest: null,
    sender: { displayName: 'Boss', role: 'ADMIN' },
    receiver: { displayName: 'Me', role: 'SENIOR' },
    project: { name: 'P' },
    ...over,
  }
}

/** Stub db: first findFirst -> the tx row, second -> the first SENIOR_INCOME. */
function stubDb(txRow: unknown, income?: unknown) {
  const findFirst = vi.fn().mockResolvedValueOnce(txRow).mockResolvedValueOnce(income)
  const db = { query: { transactions: { findFirst } } } as unknown as NodePgDatabase<typeof schema>
  return { db, findFirst }
}

describe('loadTransactionForViewer', () => {
  it('throws NOT_FOUND when the row is missing, before any enrichment query', async () => {
    const { db, findFirst } = stubDb(undefined)
    await expect(loadTransactionForViewer(db, 'x', user('ADMIN'))).rejects.toMatchObject({
      status: 404,
    })
    expect(findFirst).toHaveBeenCalledTimes(1)
  })

  it('runs the visibility guard BEFORE read-access: a deleted foreign row is 404, not 403', async () => {
    const { db } = stubDb(row({ deletedAt: new Date(), senderId: OTHER, receiverId: OTHER }))
    await expect(loadTransactionForViewer(db, 'tx-1', user('JUNIOR'))).rejects.toMatchObject({
      status: 404,
    })
  })

  it('denies a live foreign row with 403 (read-access guard)', async () => {
    const { db, findFirst } = stubDb(row({ senderId: OTHER, receiverId: OTHER }))
    await expect(loadTransactionForViewer(db, 'tx-1', user('JUNIOR'))).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    expect(findFirst).toHaveBeenCalledTimes(1)
  })

  it('lets ADMIN read a soft-deleted row', async () => {
    const { db } = stubDb(row({ deletedAt: new Date() }))
    await expect(loadTransactionForViewer(db, 'tx-1', user('ADMIN'))).resolves.toMatchObject({
      id: 'tx-1',
    })
  })

  it('masks the internal ADMIN counterparty for a non-privileged viewer only', async () => {
    const masked = await loadTransactionForViewer(stubDb(row()).db, 'tx-1', user('SENIOR'))
    const open = await loadTransactionForViewer(stubDb(row()).db, 'tx-1', user('ADMIN'))
    expect(open.senderId).toBe(OTHER)
    expect(masked.senderId).toBeNull()
    expect(masked.senderLabel).toBe('CheekyCheeseIT')
  })

  it('enriches payoutRequest with the first SENIOR_INCOME share and source', async () => {
    const pr = { seniorId: ME, incomeAmount: 10, payableAmount: 9 }
    const { db, findFirst } = stubDb(row({ payoutRequestId: 'pr-1', payoutRequest: pr }), {
      seniorSharePercent: 70,
      seniorSharePercentSource: 'TEAM',
    })
    const out = await loadTransactionForViewer(db, 'tx-1', user('ADMIN'))
    expect(findFirst).toHaveBeenCalledTimes(2)
    expect(out.payoutRequest).toEqual({
      ...pr,
      seniorSharePercent: 70,
      seniorSharePercentSource: 'TEAM',
    })
  })

  it('defaults a missing share source to null and leaves payoutRequest alone without an income', async () => {
    const pr = { seniorId: ME, incomeAmount: 10, payableAmount: 9 }
    const a = await loadTransactionForViewer(
      stubDb(row({ payoutRequestId: 'pr-1', payoutRequest: pr }), { seniorSharePercent: 60 }).db,
      'tx-1',
      user('ADMIN'),
    )
    expect(a.payoutRequest).toMatchObject({
      seniorSharePercent: 60,
      seniorSharePercentSource: null,
    })
    const b = await loadTransactionForViewer(
      stubDb(row({ payoutRequestId: 'pr-1', payoutRequest: pr }), undefined).db,
      'tx-1',
      user('ADMIN'),
    )
    expect(b.payoutRequest).toEqual(pr)
  })

  it('skips the enrichment query when there is no payoutRequest', async () => {
    const { db, findFirst } = stubDb(row({ payoutRequestId: 'pr-1', payoutRequest: null }))
    await loadTransactionForViewer(db, 'tx-1', user('ADMIN'))
    expect(findFirst).toHaveBeenCalledTimes(1)
  })
})
