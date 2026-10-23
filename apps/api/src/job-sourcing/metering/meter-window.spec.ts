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

  /**
   * CR-M-1 / CR-M-2. A month-end anchor, rolled through February — the case where the day of
   * month cannot survive as a number. Every instant below is read off a calendar: 2027 is a
   * common year, so February ends on the 28th; March has 31 days and April 30.
   *
   * The claim under test is the one the finding was about: the bounds a meter lands on do not
   * depend on how often it was read. The two histories are run separately and then compared.
   */
  describe('a MONTH anchor on the last day of the month (CR-M-1)', () => {
    it('steps Jan 31 -> Feb 28 -> Mar 31 -> Apr 30, one window at a time', () => {
      const first = rollWindow('MONTH', at('2027-01-31T00:00:00Z'), at('2027-02-01T09:00:00Z'))
      expect(first).toEqual({
        windowStartedAt: at('2027-01-31T00:00:00Z'),
        resetsAt: at('2027-02-28T00:00:00Z'),
      })

      // The SECOND reset — the one nothing covered before, and the one that used to drift.
      const second = rollWindow('MONTH', at('2027-02-28T00:00:00Z'), at('2027-03-01T09:00:00Z'))
      expect(second).toEqual({
        windowStartedAt: at('2027-02-28T00:00:00Z'),
        resetsAt: at('2027-03-31T00:00:00Z'),
      })

      const third = rollWindow('MONTH', at('2027-03-31T00:00:00Z'), at('2027-04-01T09:00:00Z'))
      expect(third).toEqual({
        windowStartedAt: at('2027-03-31T00:00:00Z'),
        resetsAt: at('2027-04-30T00:00:00Z'),
      })
    })

    it('reaches the SAME bounds when the windows elapsed untouched (no traffic dependence)', () => {
      // Jan 31 straight to Mar 5, skipping two resets in one step.
      const skipped = rollWindow('MONTH', at('2027-01-31T00:00:00Z'), at('2027-03-05T09:00:00Z'))
      expect(skipped).toEqual({
        windowStartedAt: at('2027-02-28T00:00:00Z'),
        resetsAt: at('2027-03-31T00:00:00Z'),
      })

      // The stepped history, replayed: Jan 31 -> Feb 28, then Feb 28 read on Mar 5.
      const stepped = rollWindow('MONTH', at('2027-02-28T00:00:00Z'), at('2027-03-05T09:00:00Z'))
      expect(stepped).toEqual(skipped)
      // Stated as the property, not only as two equal literals: an early local reset (Mar 28)
      // would zero `used` while the provider still counted the old window.
      expect(stepped?.resetsAt.toISOString()).toBe('2027-03-31T00:00:00.000Z')
    })

    it('a leap February ends on the 29th and still returns to Mar 31', () => {
      expect(rollWindow('MONTH', at('2028-01-31T00:00:00Z'), at('2028-02-01T00:00:00Z'))).toEqual({
        windowStartedAt: at('2028-01-31T00:00:00Z'),
        resetsAt: at('2028-02-29T00:00:00Z'),
      })
      expect(rollWindow('MONTH', at('2028-02-29T00:00:00Z'), at('2028-03-01T00:00:00Z'))).toEqual({
        windowStartedAt: at('2028-02-29T00:00:00Z'),
        resetsAt: at('2028-03-31T00:00:00Z'),
      })
    })

    /**
     * The documented residual. A 30th is NOT its month's end, so February clamps it onto
     * month-end once and it sticks there afterwards. The stepped history then resets a day
     * LATER than the skipped one for exactly one window, and they converge on Apr 30. Later
     * under-admits; it is the direction that cannot overspend. Pinned so that a future change
     * of direction has to change this test and say why.
     */
    it('a 29th/30th anchor diverges by one day for one window, late, then converges', () => {
      expect(rollWindow('MONTH', at('2027-01-30T00:00:00Z'), at('2027-02-01T00:00:00Z'))).toEqual({
        windowStartedAt: at('2027-01-30T00:00:00Z'),
        resetsAt: at('2027-02-28T00:00:00Z'),
      })
      // Stepped: base Feb 28 is month-end, so the next reset is Mar 31.
      const stepped = rollWindow('MONTH', at('2027-02-28T00:00:00Z'), at('2027-03-05T00:00:00Z'))
      // Skipped: base Jan 30 is not month-end, so the next reset is Mar 30 — one day earlier.
      const skipped = rollWindow('MONTH', at('2027-01-30T00:00:00Z'), at('2027-03-05T00:00:00Z'))
      expect(stepped?.resetsAt).toEqual(at('2027-03-31T00:00:00Z'))
      expect(skipped?.resetsAt).toEqual(at('2027-03-30T00:00:00Z'))

      // ... and the two agree again at the next reset.
      expect(
        rollWindow('MONTH', at('2027-03-31T00:00:00Z'), at('2027-04-01T00:00:00Z'))?.resetsAt,
      ).toEqual(at('2027-04-30T00:00:00Z'))
      expect(
        rollWindow('MONTH', at('2027-03-30T00:00:00Z'), at('2027-04-01T00:00:00Z'))?.resetsAt,
      ).toEqual(at('2027-04-30T00:00:00Z'))
    })
  })
})

describe('addMonthsUtc', () => {
  it('adds months across a year boundary', () => {
    // The 15th is not a month end, so it is carried as a number.
    expect(addMonthsUtc(at('2026-11-15T12:34:56.789Z'), 2)).toEqual(at('2027-01-15T12:34:56.789Z'))
  })

  /**
   * CR-M-1. Nov 30 IS the last day of November, so it is read as the month-end anchor and lands
   * on Jan 31, not Jan 30. This expectation CHANGED in the fix round: before it, repeatedly
   * adding one month decayed the day downwards (Jan 31 -> Feb 28 -> Mar 28), which moved the
   * reset EARLIER than the provider's and re-admitted spend. Month-end is a fixed point instead.
   */
  it('treats the last day of the month as the anchor, across a year boundary', () => {
    expect(addMonthsUtc(at('2026-11-30T12:34:56.789Z'), 2)).toEqual(at('2027-01-31T12:34:56.789Z'))
  })

  it('keeps a month-end anchor on month-end when added one month at a time', () => {
    const feb = addMonthsUtc(at('2027-01-31T00:00:00Z'), 1)
    expect(feb).toEqual(at('2027-02-28T00:00:00Z'))
    // The composition that used to lose the anchor.
    expect(addMonthsUtc(feb, 1)).toEqual(at('2027-03-31T00:00:00Z'))
  })

  it('carries a mid-month day unchanged and never promotes it to month-end', () => {
    expect(addMonthsUtc(at('2027-01-15T00:00:00Z'), 1)).toEqual(at('2027-02-15T00:00:00Z'))
    expect(addMonthsUtc(at('2027-02-15T00:00:00Z'), 1)).toEqual(at('2027-03-15T00:00:00Z'))
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
