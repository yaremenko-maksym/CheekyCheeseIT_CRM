import { describe, expect, it } from 'vitest'
import { addMonthsUtc, rollWindow } from './meter-window'

/**
 * Expected instants are written out by hand from the calendar, never computed with the helper
 * under test (a test that derives its expectation from the same arithmetic passes by
 * construction).
 */
const at = (iso: string) => new Date(iso)

describe('rollWindow', () => {
  it('never rolls a LIFETIME meter', () => {
    expect(rollWindow('LIFETIME', null, at('2030-01-01T00:00:00Z'))).toBeNull()
  })

  it('never rolls a windowed meter whose reset instant is unknown (NULL)', () => {
    expect(rollWindow('DAY', null, at('2030-01-01T00:00:00Z'))).toBeNull()
  })

  it('does not roll one millisecond BEFORE the reset instant', () => {
    expect(rollWindow('DAY', at('2026-10-23T00:00:00Z'), at('2026-10-22T23:59:59.999Z'))).toBeNull()
  })

  it('rolls EXACTLY at the reset instant: the new window starts at the old reset', () => {
    expect(rollWindow('DAY', at('2026-10-23T00:00:00Z'), at('2026-10-23T00:00:00Z'))).toEqual({
      windowStartedAt: at('2026-10-23T00:00:00Z'),
      resetsAt: at('2026-10-24T00:00:00Z'),
    })
  })

  it('skips whole DAY windows that elapsed while nothing touched the meter', () => {
    // reset was 2026-10-23 00:00; now is 3 days and 5 hours later -> the window of 10-26.
    expect(rollWindow('DAY', at('2026-10-23T06:00:00Z'), at('2026-10-26T11:00:00Z'))).toEqual({
      windowStartedAt: at('2026-10-26T06:00:00Z'),
      resetsAt: at('2026-10-27T06:00:00Z'),
    })
  })

  it('rolls a MONTH window to the next calendar month at the same day and time', () => {
    expect(rollWindow('MONTH', at('2026-10-15T08:00:00Z'), at('2026-10-20T00:00:00Z'))).toEqual({
      windowStartedAt: at('2026-10-15T08:00:00Z'),
      resetsAt: at('2026-11-15T08:00:00Z'),
    })
  })

  it('skips whole MONTH windows, and does not roll one past now', () => {
    // anchor 2026-01-10; now 2026-04-09 is still inside the window that began 03-10.
    expect(rollWindow('MONTH', at('2026-01-10T00:00:00Z'), at('2026-04-09T23:00:00Z'))).toEqual({
      windowStartedAt: at('2026-03-10T00:00:00Z'),
      resetsAt: at('2026-04-10T00:00:00Z'),
    })
  })
})

describe('addMonthsUtc', () => {
  it('adds months across a year boundary', () => {
    expect(addMonthsUtc(at('2026-11-30T12:34:56.789Z'), 2)).toEqual(at('2027-01-30T12:34:56.789Z'))
  })

  it('clamps the 31st to the last day of a 30-day month', () => {
    expect(addMonthsUtc(at('2026-03-31T00:00:00Z'), 1)).toEqual(at('2026-04-30T00:00:00Z'))
  })

  it('clamps the 31st to Feb 28 in a common year and Feb 29 in a leap year', () => {
    expect(addMonthsUtc(at('2027-01-31T00:00:00Z'), 1)).toEqual(at('2027-02-28T00:00:00Z'))
    expect(addMonthsUtc(at('2028-01-31T00:00:00Z'), 1)).toEqual(at('2028-02-29T00:00:00Z'))
  })

  it('adds zero months as the identity', () => {
    expect(addMonthsUtc(at('2026-05-31T23:00:00Z'), 0)).toEqual(at('2026-05-31T23:00:00Z'))
  })
})
