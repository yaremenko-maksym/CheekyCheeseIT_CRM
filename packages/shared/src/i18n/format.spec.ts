import { afterEach, describe, expect, it, vi } from 'vitest'
import { compareNames, formatDate, formatMoney, formatNumber, formatRelativeTime } from './format'

describe('format', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('formats the same date differently per locale', () => {
    const d = new Date(Date.UTC(2026, 8, 19))
    expect(formatDate(d, 'uk')).toBe(
      new Intl.DateTimeFormat('uk-UA', { timeZone: 'UTC' }).format(d),
    )
    expect(formatDate(d, 'en')).toBe(
      new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC' }).format(d),
    )
  })
  it('accepts an ISO string the same way it accepts a Date', () => {
    const iso = '2026-09-19T00:00:00.000Z'
    expect(formatDate(iso, 'uk')).toBe(formatDate(new Date(iso), 'uk'))
    expect(formatDate(iso, 'uk')).toBe(
      new Intl.DateTimeFormat('uk-UA', { timeZone: 'UTC' }).format(new Date(iso)),
    )
  })
  it('the long style spells out the month, unlike the short default', () => {
    const d = new Date(Date.UTC(2026, 8, 19))
    const long = formatDate(d, 'en', 'long')
    expect(long).toBe(
      new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(d),
    )
    expect(long).not.toBe(formatDate(d, 'en'))
  })
  it("the month style is a short month name with no day/year, unlike 'short'/'long'", () => {
    const d = new Date(Date.UTC(2026, 0, 1))
    const month = formatDate(d, 'uk', 'month')
    expect(month).toBe(
      new Intl.DateTimeFormat('uk-UA', { month: 'short', timeZone: 'UTC' }).format(d),
    )
    expect(month).not.toBe(formatDate(d, 'uk'))
    expect(month).not.toBe(formatDate(d, 'uk', 'long'))
  })
  it("the monthYear style is a full month name + year with no day, unlike 'long'", () => {
    const d = new Date(Date.UTC(2026, 4, 19))
    const monthYear = formatDate(d, 'uk', 'monthYear')
    expect(monthYear).toBe(
      new Intl.DateTimeFormat('uk-UA', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
        d,
      ),
    )
    expect(monthYear).not.toBe(formatDate(d, 'uk', 'long'))
    expect(monthYear).not.toBe(formatDate(d, 'uk', 'month'))
  })
  it('is pinned to UTC regardless of the host timezone', () => {
    // Mutating `process.env.TZ` at runtime and expecting `Intl` to pick up
    // the new zone is not portable: on the Linux CI runner (host TZ already
    // `UTC`, ICU zone data cached) the two comparison strings came out
    // equal and the test stayed green for the wrong reason — see the
    // `Mutation Gate (@crm/shared)` dry-run failure this test replaces.
    // Spying on the `Intl.DateTimeFormat` constructor instead proves
    // `formatDate` always passes `timeZone: 'UTC'` through on the actual
    // call, independent of whatever zone the host happens to be in.
    // `vi.spyOn`'s default call-through does not preserve the internal
    // slots a native `Intl.DateTimeFormat` instance needs (calling it via
    // the spy's wrapper loses `new.target`), so `.format()` on the result
    // throws. Forwarding to the real constructor explicitly via
    // `Reflect.construct` keeps the instance functional while still
    // recording every call the spy sees.
    const RealDateTimeFormat = Intl.DateTimeFormat
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
      // Must be a `function`, not an arrow — vitest's mock requires a real
      // constructor shape to support being invoked with `new`.
      function (this: unknown, ...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
        return Reflect.construct(RealDateTimeFormat, args)
      },
    )
    const d = new Date(Date.UTC(2026, 8, 19, 23, 30))
    formatDate(d, 'en')
    expect(spy).toHaveBeenCalledWith('en-GB', expect.objectContaining({ timeZone: 'UTC' }))
  })
  it('formats money with the currency code, two decimals', () => {
    // Two literal exceptions per task-i18n-stage2-task1-2.md override #4 — every
    // other assertion in this file compares against `Intl` of the same runtime,
    // not a hand-typed literal (uk-UA's grouping separator is U+00A0, not a
    // plain space, so a literal here would be an encoding trap, not a spec).
    expect(formatMoney('1234.5', 'USDT', 'en')).toBe('1,234.50 USDT')
    const ukBody = new Intl.NumberFormat('uk-UA', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(1234.5)
    expect(formatMoney(1234.5, 'UAH', 'uk')).toBe(`${ukBody} UAH`)
  })
  it('compareNames orders Ukrainian letters correctly', () => {
    const sorted = ['Яків', 'Ірина', 'Євген', 'Андрій'].sort(compareNames('uk'))
    expect(sorted).toEqual(['Андрій', 'Євген', 'Ірина', 'Яків'])
  })
  it('compareNames is base-sensitivity — case does not affect ordering', () => {
    // `Intl.Collator` sensitivity: 'base' ranks case variants as equal (0);
    // the locale-aware default sensitivity does not — this is what actually
    // exercises that option rather than just the letter ordering above.
    expect(compareNames('uk')('Андрій', 'андрій')).toBe(0)
  })
  it('formatNumber uses locale separators', () => {
    expect(formatNumber(1000000, 'en')).toBe('1,000,000')
  })

  describe('formatRelativeTime', () => {
    it('renders "X minutes ago" per locale', () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000)
      expect(formatRelativeTime(fiveMinAgo, 'en')).toBe('5 minutes ago')
    })
    it('accepts an ISO string the same way it accepts a Date', () => {
      const tenSecAgo = new Date(Date.now() - 10 * 1000)
      expect(formatRelativeTime(tenSecAgo.toISOString(), 'en')).toBe(
        formatRelativeTime(tenSecAgo, 'en'),
      )
    })
    it('picks the largest whole unit — an hour-old timestamp reports hours, not minutes', () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
      expect(formatRelativeTime(twoHoursAgo, 'en')).toBe('2 hours ago')
    })
    it('a future value reports "in X" rather than "X ago"', () => {
      const inTenMin = new Date(Date.now() + 10 * 60 * 1000)
      expect(formatRelativeTime(inTenMin, 'en')).toBe('in 10 minutes')
    })
    it('under a second reports "now"', () => {
      expect(formatRelativeTime(new Date(), 'en')).toBe('now')
    })
    it('formats per uk locale', () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000)
      expect(formatRelativeTime(fiveMinAgo, 'uk')).toBe(
        new Intl.RelativeTimeFormat('uk-UA', { numeric: 'auto' }).format(-5, 'minute'),
      )
    })

    // CI-2/CR-H-2 (fix-round 2, @crm/shared mutation gate): the unit-picking
    // loop's array literal (`units`), its numeric boundaries
    // (31536000/2592000/86400/3600/60/1), and the `abs >= secondsPerUnit`
    // comparison were exercised only in the middle of each range (5 min, 2h)
    // — never at the EXACT boundary where a mutated `>=`→`>` or a mutated
    // numeric literal would first become observable. Each pair below pins
    // one boundary from both sides: `at - 1` must still resolve to the
    // PREVIOUS (smaller) unit, `at` must resolve to the unit itself.
    const rtfEn = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' })
    const agoMs = (seconds: number) => new Date(Date.now() - seconds * 1000)

    it('day boundary (86400s): 86399s ago is still hours, 86400s ago is a day', () => {
      expect(formatRelativeTime(agoMs(86399), 'en')).toBe(rtfEn.format(-24, 'hour'))
      expect(formatRelativeTime(agoMs(86400), 'en')).toBe(rtfEn.format(-1, 'day'))
    })

    it('month boundary (2592000s): 2591999s ago is still days, 2592000s ago is a month', () => {
      expect(formatRelativeTime(agoMs(2591999), 'en')).toBe(rtfEn.format(-30, 'day'))
      expect(formatRelativeTime(agoMs(2592000), 'en')).toBe(rtfEn.format(-1, 'month'))
    })

    it('year boundary (31536000s): 31535999s ago is still months, 31536000s ago is a year', () => {
      expect(formatRelativeTime(agoMs(31535999), 'en')).toBe(rtfEn.format(-12, 'month'))
      expect(formatRelativeTime(agoMs(31536000), 'en')).toBe(rtfEn.format(-1, 'year'))
    })

    it('hour boundary (3600s): 3599s ago is still minutes, 3600s ago is an hour', () => {
      expect(formatRelativeTime(agoMs(3599), 'en')).toBe(rtfEn.format(-60, 'minute'))
      expect(formatRelativeTime(agoMs(3600), 'en')).toBe(rtfEn.format(-1, 'hour'))
    })

    it('minute boundary (60s): 59s ago is still seconds, 60s ago is a minute', () => {
      expect(formatRelativeTime(agoMs(59), 'en')).toBe(rtfEn.format(-59, 'second'))
      expect(formatRelativeTime(agoMs(60), 'en')).toBe(rtfEn.format(-1, 'minute'))
    })

    it('a future value crosses the same day/month/year boundaries the same way', () => {
      const inMs = (seconds: number) => new Date(Date.now() + seconds * 1000)
      expect(formatRelativeTime(inMs(86400), 'en')).toBe(rtfEn.format(1, 'day'))
      expect(formatRelativeTime(inMs(2592000), 'en')).toBe(rtfEn.format(1, 'month'))
      expect(formatRelativeTime(inMs(31536000), 'en')).toBe(rtfEn.format(1, 'year'))
    })
  })
})
