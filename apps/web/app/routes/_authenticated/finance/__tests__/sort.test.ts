import { describe, expect, it } from 'vitest'
import { compareTxByAmount, compareTxByDate, type TxSortable } from '../sort'

// Minimal factory — only fields used by the comparator.
const tx = (overrides: Partial<TxSortable>): TxSortable => ({
  txDate: null,
  createdAt: '2026-05-28T00:00:00.000Z',
  amount: '0',
  ...overrides,
})

describe('compareTxByDate', () => {
  it('sorts by createdAt descending (newest first)', () => {
    const older = tx({ createdAt: '2026-05-26T10:00:00.000Z' })
    const newer = tx({ createdAt: '2026-05-28T10:00:00.000Z' })
    const list = [older, newer].sort((a, b) => compareTxByDate(a, b, 'desc'))
    expect(list[0]).toBe(newer)
    expect(list[1]).toBe(older)
  })

  it('sorts by createdAt ascending (oldest first)', () => {
    const older = tx({ createdAt: '2026-05-26T10:00:00.000Z' })
    const newer = tx({ createdAt: '2026-05-28T10:00:00.000Z' })
    const list = [newer, older].sort((a, b) => compareTxByDate(a, b, 'asc'))
    expect(list[0]).toBe(older)
    expect(list[1]).toBe(newer)
  })

  it('ignores txDate — legacy income (midnight) vs payout same day, DESC by createdAt', () => {
    // Real bug scenario from PR #59 user testing:
    // - Payout: txDate=null, createdAt=07:37
    // - Income: txDate=midnight (00:00), createdAt=08:17 (created later)
    // Before fix: primary key `txDate ?? createdAt` made payout (07:37) sort
    // above income (00:00). After fix: createdAt only → income wins (08:17 > 07:37).
    const payout = tx({
      txDate: null,
      createdAt: '2026-05-28T07:37:20.000Z',
      amount: '8222.14',
    })
    const income = tx({
      txDate: '2026-05-28T00:00:00.000Z',
      createdAt: '2026-05-28T08:17:00.000Z',
      amount: '4000',
    })
    const list = [payout, income].sort((a, b) => compareTxByDate(a, b, 'desc'))
    expect(list[0]).toBe(income)
    expect(list[1]).toBe(payout)
  })

  it('ignores txDate even when one row has a later txDate but earlier createdAt', () => {
    // Defensive: txDate must never influence ordering. A row created earlier
    // but bearing a future txDate must still sort below a later-created row.
    const earlierCreatedFutureTxDate = tx({
      txDate: '2026-06-30T10:00:00.000Z', // far in the future
      createdAt: '2026-05-28T05:00:00.000Z',
    })
    const laterCreated = tx({
      txDate: '2026-05-28T00:00:00.000Z',
      createdAt: '2026-05-28T08:17:00.000Z',
    })
    const list = [earlierCreatedFutureTxDate, laterCreated].sort((a, b) =>
      compareTxByDate(a, b, 'desc'),
    )
    expect(list[0]).toBe(laterCreated)
    expect(list[1]).toBe(earlierCreatedFutureTxDate)
  })

  it('returns 0 when createdAt is identical', () => {
    const a = tx({ createdAt: '2026-05-28T05:00:00.000Z' })
    const b = tx({ createdAt: '2026-05-28T05:00:00.000Z' })
    // `mul * (0 - 0)` can produce -0 in JS; both are "equal" for Array.sort
    // semantics, so we normalise via `+ 0` and assert.
    expect(compareTxByDate(a, b, 'desc') + 0).toBe(0)
    expect(compareTxByDate(a, b, 'asc') + 0).toBe(0)
  })
})

describe('compareTxByAmount', () => {
  it('sorts numerically by amount (DESC)', () => {
    const small = tx({ amount: '100' })
    const big = tx({ amount: '9999.99' })
    const list = [small, big].sort((a, b) => compareTxByAmount(a, b, 'desc'))
    expect(list[0]).toBe(big)
    expect(list[1]).toBe(small)
  })

  it('sorts numerically by amount (ASC)', () => {
    const small = tx({ amount: '100' })
    const big = tx({ amount: '9999.99' })
    const list = [big, small].sort((a, b) => compareTxByAmount(a, b, 'asc'))
    expect(list[0]).toBe(small)
    expect(list[1]).toBe(big)
  })
})
