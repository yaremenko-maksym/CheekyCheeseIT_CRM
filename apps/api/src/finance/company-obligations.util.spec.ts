import { describe, expect, it, vi } from 'vitest'
import { bookCompanyObligations } from './company-obligations.util'
import type { DrizzleTx } from '../database/types'

function stubTx() {
  const inserted: Array<Record<string, unknown>> = []
  let n = 0
  const tx = {
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        inserted.push(v)
        const row = { id: `row${++n}` }
        const p = Promise.resolve([row]) as unknown as Promise<unknown[]> & {
          returning: () => unknown
        }
        p.returning = () => Promise.resolve([row])
        return p
      }),
    })),
  } as unknown as DrizzleTx
  return { tx, inserted }
}

const base = { incomeAmount: 100, projectId: 'p1', companyName: 'Acme', createdBy: 'admin' }

describe('bookCompanyObligations', () => {
  it('books senior and drop IOUs with rounded shares', async () => {
    const { tx, inserted } = stubTx()
    const r = await bookCompanyObligations(tx, {
      ...base,
      payoutRequestId: 'pr1',
      incomeTransactionId: 'inc1',
      senior: { id: 's', role: 'SENIOR', shareSnapshot: { value: 33.333, source: 'TEAM' } },
      drop: { id: 'd', shareSnapshot: { value: 10, source: 'PROJECT' } },
    })
    expect(r).toEqual({ seniorAmount: 33.333, dropAmount: 10 })
    expect(inserted).toHaveLength(4)
    expect(inserted[0]).toMatchObject({
      type: 'SENIOR_PENDING_PAYOUT',
      status: 'PENDING_PAYMENT',
      amount: '33.333',
      currency: 'USDT',
      receiverId: 's',
      payoutRequestId: 'pr1',
      seniorSharePercent: 33.333,
      seniorSharePercentSource: 'TEAM',
      notes: 'Company owes — senior IOU (debtor=COMPANY)',
      sourceIncomeTransactionId: 'inc1',
      companyNameSnapshot: 'Acme',
    })
    expect(inserted[1]).toMatchObject({
      creditorUserId: 's',
      debtorType: 'COMPANY',
      debtorUserId: null,
      sourceTransactionId: 'row1',
      amount: '33.333',
      currency: 'USDT',
      status: 'PENDING',
      payoutRequestId: 'pr1',
    })
    expect(inserted[2]).toMatchObject({
      type: 'DROP_PENDING_PAYOUT',
      status: 'PENDING_PAYMENT',
      currency: 'USDT',
      amount: '10',
      dropCascadeOrigin: true,
      dropSharePercent: 10,
      dropSharePercentSource: 'PROJECT',
      notes: 'Company owes — drop IOU (debtor=COMPANY)',
    })
    expect(inserted[3]).toMatchObject({
      creditorUserId: 'd',
      debtorType: 'COMPANY',
      debtorUserId: null,
      sourceTransactionId: 'row3',
      amount: '10',
      currency: 'USDT',
      status: 'PENDING',
      payoutRequestId: 'pr1',
    })
  })

  it('skips the senior IOU for an ADMIN and marks no cascade origin without payoutRequestId', async () => {
    const { tx, inserted } = stubTx()
    const txDate = new Date('2026-01-02')
    const r = await bookCompanyObligations(tx, {
      ...base,
      txDate,
      notePrefix: 'USDT income',
      senior: { id: 'a', role: 'ADMIN', shareSnapshot: { value: 50, source: 'USER_DEFAULT' } },
      drop: { id: 'd', shareSnapshot: { value: 10, source: 'USER_DEFAULT' } },
    })
    expect(r).toEqual({ seniorAmount: null, dropAmount: 10 })
    expect(inserted).toHaveLength(2)
    expect(inserted[0]).toMatchObject({
      dropCascadeOrigin: false,
      payoutRequestId: null,
      sourceIncomeTransactionId: null,
      txDate,
      notes: 'USDT income — drop IOU (debtor=COMPANY)',
    })
    expect(inserted[1]).toMatchObject({ payoutRequestId: null, status: 'PENDING' })
  })

  it('writes no obligation row when the IOU insert returns no row', async () => {
    const inserted: Array<Record<string, unknown>> = []
    const tx = {
      insert: vi.fn(() => ({
        values: vi.fn((v: Record<string, unknown>) => {
          inserted.push(v)
          const p = Promise.resolve([]) as unknown as Promise<unknown[]> & {
            returning: () => unknown
          }
          p.returning = () => Promise.resolve([])
          return p
        }),
      })),
    } as unknown as DrizzleTx
    await bookCompanyObligations(tx, {
      ...base,
      senior: { id: 's', role: 'SENIOR', shareSnapshot: { value: 10, source: 'TEAM' } },
      drop: { id: 'd', shareSnapshot: { value: 10, source: 'PROJECT' } },
    })
    expect(inserted).toHaveLength(2)
  })

  it('books nothing without senior or drop', async () => {
    const { tx, inserted } = stubTx()
    expect(await bookCompanyObligations(tx, base)).toEqual({
      seniorAmount: null,
      dropAmount: null,
    })
    expect(inserted).toHaveLength(0)
  })
})
