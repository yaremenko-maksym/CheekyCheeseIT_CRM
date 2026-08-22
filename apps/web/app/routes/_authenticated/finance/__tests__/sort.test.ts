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
  it('sorts by txDate descending (newest first) — createdAt is reversed to prove txDate drives it', () => {
    const older = tx({
      txDate: '2026-05-26T00:00:00.000Z',
      createdAt: '2026-05-28T10:00:00.000Z', // created later, but happened earlier
    })
    const newer = tx({
      txDate: '2026-05-28T00:00:00.000Z',
      createdAt: '2026-05-26T10:00:00.000Z', // created earlier, but happened later
    })
    const list = [older, newer].sort((a, b) => compareTxByDate(a, b, 'desc'))
    expect(list[0]).toBe(newer)
    expect(list[1]).toBe(older)
  })

  it('sorts by txDate ascending (oldest first) — createdAt is reversed to prove txDate drives it', () => {
    const older = tx({
      txDate: '2026-05-26T00:00:00.000Z',
      createdAt: '2026-05-28T10:00:00.000Z',
    })
    const newer = tx({
      txDate: '2026-05-28T00:00:00.000Z',
      createdAt: '2026-05-26T10:00:00.000Z',
    })
    const list = [newer, older].sort((a, b) => compareTxByDate(a, b, 'asc'))
    expect(list[0]).toBe(older)
    expect(list[1]).toBe(newer)
  })

  it('breaks a same-day txDate tie with createdAt, descending', () => {
    // Two legacy income rows, both parsed to the same midnight-UTC txDate —
    // createdAt (unique, monotonic) must decide the order.
    const sameDay = '2026-05-28T00:00:00.000Z'
    const createdEarlier = tx({ txDate: sameDay, createdAt: '2026-05-28T07:00:00.000Z' })
    const createdLater = tx({ txDate: sameDay, createdAt: '2026-05-28T09:00:00.000Z' })
    const list = [createdEarlier, createdLater].sort((a, b) => compareTxByDate(a, b, 'desc'))
    expect(list[0]).toBe(createdLater)
    expect(list[1]).toBe(createdEarlier)
  })

  it('breaks a same-day txDate tie with createdAt, ascending', () => {
    const sameDay = '2026-05-28T00:00:00.000Z'
    const createdEarlier = tx({ txDate: sameDay, createdAt: '2026-05-28T07:00:00.000Z' })
    const createdLater = tx({ txDate: sameDay, createdAt: '2026-05-28T09:00:00.000Z' })
    const list = [createdLater, createdEarlier].sort((a, b) => compareTxByDate(a, b, 'asc'))
    expect(list[0]).toBe(createdEarlier)
    expect(list[1]).toBe(createdLater)
  })

  it('places a null-txDate row (payout) before a dated row, descending', () => {
    // "Before", not "after": a freshly-created payout (txDate always null,
    // createdAt = now) must stay visible on page 1 without pagination — see
    // the compareTxByDate docblock for the live-verified regression this
    // avoids.
    const dated = tx({ txDate: '2026-06-01T00:00:00.000Z', createdAt: '2026-06-01T00:00:00.000Z' })
    // Undated row has a much EARLIER createdAt — if createdAt still drove
    // placement it would sort AFTER dated in DESC. It must not.
    const undated = tx({ txDate: null, createdAt: '2025-01-01T00:00:00.000Z' })
    const list = [dated, undated].sort((a, b) => compareTxByDate(a, b, 'desc'))
    expect(list[0]).toBe(undated)
    expect(list[1]).toBe(dated)
  })

  it('places a null-txDate row (payout) before a dated row, ascending', () => {
    const dated = tx({ txDate: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
    // Undated row has a much LATER createdAt — if createdAt still drove
    // placement it would sort AFTER dated in ASC. It must not.
    const undated = tx({ txDate: null, createdAt: '2026-06-01T00:00:00.000Z' })
    const list = [dated, undated].sort((a, b) => compareTxByDate(a, b, 'asc'))
    expect(list[0]).toBe(undated)
    expect(list[1]).toBe(dated)
  })

  it('breaks a tie between two null-txDate rows (payouts) with createdAt, descending', () => {
    const earlierCreated = tx({ txDate: null, createdAt: '2026-05-26T10:00:00.000Z' })
    const laterCreated = tx({ txDate: null, createdAt: '2026-05-28T10:00:00.000Z' })
    const list = [earlierCreated, laterCreated].sort((a, b) => compareTxByDate(a, b, 'desc'))
    expect(list[0]).toBe(laterCreated)
    expect(list[1]).toBe(earlierCreated)
  })

  it('returns 0 when txDate and createdAt are both identical', () => {
    const a = tx({ txDate: '2026-05-28T00:00:00.000Z', createdAt: '2026-05-28T05:00:00.000Z' })
    const b = tx({ txDate: '2026-05-28T00:00:00.000Z', createdAt: '2026-05-28T05:00:00.000Z' })
    // `mul * (0 - 0)` can produce -0 in JS; both are "equal" for Array.sort
    // semantics, so we normalise via `+ 0` and assert.
    expect(compareTxByDate(a, b, 'desc') + 0).toBe(0)
    expect(compareTxByDate(a, b, 'asc') + 0).toBe(0)
  })

  it('returns 0 when both rows are null-txDate with identical createdAt', () => {
    const a = tx({ txDate: null, createdAt: '2026-05-28T05:00:00.000Z' })
    const b = tx({ txDate: null, createdAt: '2026-05-28T05:00:00.000Z' })
    expect(compareTxByDate(a, b, 'desc') + 0).toBe(0)
    expect(compareTxByDate(a, b, 'asc') + 0).toBe(0)
  })

  it('treats an undefined txDate the same as null (no date), both directions', () => {
    // `financeApi.getTransactions` types its response `TransactionDto[]` but
    // does not `.parse()` it — a payload that omits `txDate` reaches the
    // comparator as `undefined`, not `null`. It must still land in the
    // "undated" bucket (sorts first, both directions), not get timestamped
    // as epoch-0 and land at the wrong end of a DESC sort.
    const dated = tx({ txDate: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' })
    // Cast: TxSortable's type says `string | null`, but this pins the actual
    // untyped-at-runtime shape described above.
    const undatedViaMissingKey = tx({
      txDate: undefined as unknown as null,
      createdAt: '2025-01-01T00:00:00.000Z', // earlier createdAt — would sort AFTER dated in DESC if mistaken for epoch-0
    })
    const desc = [dated, undatedViaMissingKey].sort((a, b) => compareTxByDate(a, b, 'desc'))
    expect(desc[0]).toBe(undatedViaMissingKey)
    expect(desc[1]).toBe(dated)
    const asc = [dated, undatedViaMissingKey].sort((a, b) => compareTxByDate(a, b, 'asc'))
    expect(asc[0]).toBe(undatedViaMissingKey)
    expect(asc[1]).toBe(dated)
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
