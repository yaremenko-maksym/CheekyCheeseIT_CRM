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

  /**
   * The LIFETIME clause pinned on its OWN, with a reset instant that is both non-null and long
   * past. The case above passes a NULL `resetsAt`, so the second clause of the guard carries it
   * and the LIFETIME test is never the reason the function returns null — which is why removing
   * the LIFETIME clause entirely left the whole suite green (mutation gate, two survivors on that
   * one line). A LIFETIME row with a stale `resetsAt` is reachable: the schema forbids the
   * combination, but `rollWindow` is a pure function that does not see the schema, and a meter
   * whose window kind is changed from DAY to LIFETIME carries its old instants until something
   * clears them. Rolling it would zero a lifetime quota's `used` — spend the provider never
   * forgives.
   */
  it('never rolls a LIFETIME meter even when its reset instant is non-null and long past', () => {
    expect(
      rollWindow('LIFETIME', at('2020-01-01T00:00:00Z'), at('2030-06-15T12:00:00Z')),
    ).toBeNull()
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

  /**
   * The month count across a YEAR boundary, with a span big enough to tell `* 12` from `/ 12`.
   * Every other month case spans less than a year, so the year term is zero and the multiplication
   * is unexercised (mutation gate: `(nowYear - resetYear) * 12` -> `/ 12` survived). 14 months is
   * past the first year, and the 15th is not a month end, so nothing clamps and the expected
   * instants are plain calendar arithmetic: the window containing 2027-03-20 is the one that began
   * on 2027-03-15.
   */
  it('counts whole months across a year boundary (a span of 14 months)', () => {
    expect(rollWindow('MONTH', at('2026-01-15T00:00:00Z'), at('2027-03-20T00:00:00Z'))).toEqual({
      windowStartedAt: at('2027-03-15T00:00:00Z'),
      resetsAt: at('2027-04-15T00:00:00Z'),
    })
  })

  /**
   * THE AT-LIMIT CASE of the "not past now" correction, and the one past it on either side
   * (backlog 284: every bound gets a case AT it and one PAST it).
   *
   * The specification the expectation comes from, not the function's output: a reset is due AT
   * `resetsAt`, INCLUSIVE, and the returned window always CONTAINS `now`. So at the exact instant
   * a window's reset falls due, the window that contains `now` is the one that STARTS there.
   * Shifting the comparison to `>=` returns the previous window instead, whose `resetsAt` equals
   * `now` — a window already due at the moment it is handed back, which contradicts both halves of
   * the specification. That mutant survived the suite before these three cases.
   */
  it('at the exact instant a month window falls due, the new window STARTS at now', () => {
    expect(rollWindow('MONTH', at('2026-01-15T00:00:00Z'), at('2026-03-15T00:00:00Z'))).toEqual({
      windowStartedAt: at('2026-03-15T00:00:00Z'),
      resetsAt: at('2026-04-15T00:00:00Z'),
    })
  })

  it('one millisecond after that instant gives the same window', () => {
    expect(rollWindow('MONTH', at('2026-01-15T00:00:00Z'), at('2026-03-15T00:00:00.001Z'))).toEqual(
      {
        windowStartedAt: at('2026-03-15T00:00:00Z'),
        resetsAt: at('2026-04-15T00:00:00Z'),
      },
    )
  })

  it('one millisecond before it, the window is still the previous one', () => {
    expect(rollWindow('MONTH', at('2026-01-15T00:00:00Z'), at('2026-03-14T23:59:59.999Z'))).toEqual(
      {
        windowStartedAt: at('2026-02-15T00:00:00Z'),
        resetsAt: at('2026-03-15T00:00:00Z'),
      },
    )
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
     * THE RESIDUAL, pinned as measured (R2-CR-M-1). A previous edition of this test asserted that
     * a 29th/30th anchor diverges for "one window, then converges". It does not: February captures
     * any 28th/29th/30th anchor onto month-end — Feb 28 IS month-end in a common year — and it
     * stays there for as long as it keeps being stepped.
     *
     * Each row below is the stepped sequence for one January anchor in 2027, with the provider's
     * own un-decaying schedule beside it, read off a calendar rather than produced by the helper.
     * The 28th is the worst case and the one this round made worse: under plain clamping it
     * tracked the provider exactly, and it is now up to three days late.
     */
    const steppedSchedules = [
      {
        anchorDay: 28,
        // local reset, then the provider's reset for the same window
        windows: [
          ['2027-02-28', '2027-02-28'],
          ['2027-03-31', '2027-03-28'],
          ['2027-04-30', '2027-04-28'],
          ['2027-05-31', '2027-05-28'],
        ],
      },
      {
        anchorDay: 30,
        windows: [
          ['2027-02-28', '2027-02-28'],
          ['2027-03-31', '2027-03-30'],
          ['2027-04-30', '2027-04-30'],
          ['2027-05-31', '2027-05-30'],
        ],
      },
      {
        anchorDay: 31,
        windows: [
          ['2027-02-28', '2027-02-28'],
          ['2027-03-31', '2027-03-31'],
          ['2027-04-30', '2027-04-30'],
          ['2027-05-31', '2027-05-31'],
        ],
      },
    ]

    it.each(steppedSchedules)(
      'a Jan $anchorDay anchor, stepped, resets on month-end and NEVER before the provider',
      ({ anchorDay, windows }) => {
        let base = at(`2027-01-${anchorDay}T00:00:00Z`)
        for (const [expectedLocal, providerReset] of windows) {
          // An hour after the reset falls due — the first operation of the new window.
          const rolled = rollWindow('MONTH', base, new Date(base.getTime() + 3_600_000))
          expect(rolled?.resetsAt).toEqual(at(`${expectedLocal}T00:00:00Z`))
          // The property that closes the finding: never EARLIER than the provider's own reset.
          // An early local reset zeroes `used` while the provider still counts the old window.
          expect(rolled!.resetsAt.getTime()).toBeGreaterThanOrEqual(
            at(`${providerReset}T00:00:00Z`).getTime(),
          )
          base = rolled!.resetsAt
        }
      },
    )

    it('the 28th is up to three days late — the cost of closing the early 31st', () => {
      // Jan 28 -> Feb 28 (month-end in a common year) -> Mar 31, where the provider says Mar 28.
      const feb = rollWindow('MONTH', at('2027-01-28T00:00:00Z'), at('2027-01-28T01:00:00Z'))
      expect(feb?.resetsAt).toEqual(at('2027-02-28T00:00:00Z'))
      const mar = rollWindow('MONTH', at('2027-02-28T00:00:00Z'), at('2027-02-28T01:00:00Z'))
      expect(mar?.resetsAt).toEqual(at('2027-03-31T00:00:00Z'))
      const lateDays = (mar!.resetsAt.getTime() - at('2027-03-28T00:00:00Z').getTime()) / 86_400_000
      expect(lateDays).toBe(3)
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
