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

  // SR-H-1 (PR #1158): a drop-project payout paid without a date passed `txDate: undefined`,
  // and both IOU rows were written with NULL tx_date. The fallback is the Kyiv business day
  // of "now", as for every other writer (resolveTransactionDate).
  describe('without a txDate', () => {
    const senior = {
      id: 's',
      role: 'SENIOR',
      shareSnapshot: { value: 10, source: 'TEAM' as const },
    }
    const drop = { id: 'd', shareSnapshot: { value: 10, source: 'PROJECT' as const } }

    async function bookAt(now: string) {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(now))
      try {
        const { tx, inserted } = stubTx()
        await bookCompanyObligations(tx, { ...base, payoutRequestId: 'pr1', senior, drop })
        return [inserted[0], inserted[2]].map((row) =>
          (row?.['txDate'] as Date | undefined)?.toISOString(),
        )
      } finally {
        vi.useRealTimers()
      }
    }

    it('dates both IOU rows with the current instant on an ordinary day', async () => {
      expect(await bookAt('2026-10-15T10:00:00.000Z')).toEqual([
        '2026-10-15T10:00:00.000Z',
        '2026-10-15T10:00:00.000Z',
      ])
    })

    it('dates both IOU rows with the Kyiv day when Kyiv is already a day ahead', async () => {
      // 22:30Z on 31 Oct = 00:30 on 1 Nov in Kyiv.
      expect(await bookAt('2026-10-31T22:30:00.000Z')).toEqual([
        '2026-11-01T00:00:00.000Z',
        '2026-11-01T00:00:00.000Z',
      ])
    })
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
