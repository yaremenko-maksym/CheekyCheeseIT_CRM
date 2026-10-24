import { describe, expect, it } from 'vitest'
import { periodToDates } from './period'

/**
 * CR-867-M-1 / CR-867-L-1: period filter keys are built from the Kyiv business-day
 * KEY's calendar parts — never from `toISOString()` of a local-midnight Date and
 * never from `Date#setMonth` (which overflows on the 29th-31st).
 */
describe('periodToDates', () => {
  it("'all' has no bounds", () => {
    expect(periodToDates('all', '2026-10-24')).toEqual({})
  })

  it("'current' starts on the 1st of the business month", () => {
    expect(periodToDates('current', '2026-10-24')).toEqual({ from: '2026-10-01' })
    expect(periodToDates('current', '2026-08-01')).toEqual({ from: '2026-08-01' })
  })

  it("'prev' spans the whole previous month, including across a year boundary", () => {
    expect(periodToDates('prev', '2026-10-24')).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(periodToDates('prev', '2026-01-05')).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(periodToDates('prev', '2024-03-31')).toEqual({ from: '2024-02-01', to: '2024-02-29' })
  })

  it("'3m' goes back three calendar months and never overflows past a short month", () => {
    expect(periodToDates('3m', '2026-10-24')).toEqual({ from: '2026-07-24' })
    // setMonth(-3) from 31 May would land on 3 Mar; the key must stay in February.
    expect(periodToDates('3m', '2026-05-31')).toEqual({ from: '2026-02-28' })
    expect(periodToDates('3m', '2026-01-31')).toEqual({ from: '2025-10-31' })
  })
})
