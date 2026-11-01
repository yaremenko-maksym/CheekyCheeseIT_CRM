import { describe, expect, it } from 'vitest'
import { changedTxDatePayload, storedTxDate } from '../changed-tx-date'

const TX = { txDate: '2026-10-20T00:00:00.000Z', createdAt: '2026-10-20T08:00:00.000Z' }

describe('storedTxDate', () => {
  it('is the UTC day of tx_date', () => {
    expect(storedTxDate(TX)).toBe('2026-10-20')
  })

  it('falls back to the Kyiv day of createdAt when tx_date is missing', () => {
    // 22:30 UTC is already the next day in Kyiv.
    expect(storedTxDate({ txDate: null, createdAt: '2026-10-20T22:30:00.000Z' })).toBe('2026-10-21')
  })
})

describe('changedTxDatePayload', () => {
  it('sends nothing when the day is untouched, even with a reason typed', () => {
    expect(changedTxDatePayload(TX, '2026-10-20', 'because')).toEqual({})
  })

  it('sends nothing for an empty date', () => {
    expect(changedTxDatePayload(TX, '', '')).toEqual({})
  })

  it('sends only the date when no reason was typed', () => {
    expect(changedTxDatePayload(TX, '2026-10-25', '   ')).toEqual({ txDate: '2026-10-25' })
  })

  it('sends the date with the trimmed reason', () => {
    expect(changedTxDatePayload(TX, '2026-08-01', '  late statement ')).toEqual({
      txDate: '2026-08-01',
      backdateReason: 'late statement',
    })
  })
})
