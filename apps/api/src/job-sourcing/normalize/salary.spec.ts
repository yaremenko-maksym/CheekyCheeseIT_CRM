import { describe, expect, it } from 'vitest'
import {
  decodeSalaryClaim,
  encodeSalaryClaim,
  MAX_SALARY_AMOUNT,
  normalizeSalary,
  salaryHashPart,
  salaryMonthlyTop,
} from './salary'

const range = { min: 4000, max: 5500, currency: 'EUR', period: 'MONTH' }

describe('normalizeSalary: a valid statement', () => {
  it('keeps a valid range as is', () => {
    expect(normalizeSalary(range)).toEqual(range)
  })

  it('keeps a single bound, either one, and nulls the missing one', () => {
    expect(normalizeSalary({ ...range, max: undefined })).toEqual({ ...range, max: null })
    expect(normalizeSalary({ ...range, min: null })).toEqual({ ...range, min: null })
  })

  it('upper-cases and trims the currency', () => {
    expect(normalizeSalary({ ...range, currency: ' eur ' })?.currency).toBe('EUR')
  })

  it('rounds each bound to 2 decimals', () => {
    expect(normalizeSalary({ ...range, min: 10.006, max: 20.123 })).toMatchObject({
      min: 10.01,
      max: 20.12,
    })
  })

  it('accepts min equal to max', () => {
    expect(normalizeSalary({ ...range, min: 5000, max: 5000 })).toMatchObject({ min: 5000 })
  })

  it('accepts each of the three periods', () => {
    for (const period of ['HOUR', 'MONTH', 'YEAR'])
      expect(normalizeSalary({ ...range, period })?.period).toBe(period)
  })
})

describe('normalizeSalary: each rule refuses on its own', () => {
  it('no input at all', () => {
    expect(normalizeSalary(null)).toBeNull()
    expect(normalizeSalary(undefined)).toBeNull()
    expect(normalizeSalary('4000 EUR')).toBeNull()
  })

  it('no bound', () => {
    expect(normalizeSalary({ ...range, min: null, max: null })).toBeNull()
  })

  it('a non-finite bound', () => {
    expect(normalizeSalary({ ...range, min: Number.NaN })).toBeNull()
    expect(normalizeSalary({ ...range, max: Number.POSITIVE_INFINITY })).toBeNull()
  })

  it('a bound that is not a number (a free-text figure is never parsed)', () => {
    expect(normalizeSalary({ ...range, min: '4000' })).toBeNull()
  })

  it('a bound <= 0, before or after rounding', () => {
    expect(normalizeSalary({ ...range, min: 0 })).toBeNull()
    expect(normalizeSalary({ ...range, min: -1 })).toBeNull()
    expect(normalizeSalary({ ...range, min: 0.004 })).toBeNull()
  })

  it('a bound >= 1e9', () => {
    expect(MAX_SALARY_AMOUNT).toBe(1e9)
    expect(normalizeSalary({ ...range, max: 1e9 })).toBeNull()
    expect(normalizeSalary({ ...range, min: null, max: 999_999_999 })).not.toBeNull()
  })

  it('a monthly equivalent >= 1e9 (an hourly figure that cannot be stored)', () => {
    // 6_250_000 / hour x 160 h = 1e9 / month: the column holds up to 1e10, the rule caps at 1e9.
    expect(
      normalizeSalary({ min: null, max: 6_250_000, currency: 'EUR', period: 'HOUR' }),
    ).toBeNull()
    expect(
      normalizeSalary({ min: null, max: 6_249_999, currency: 'EUR', period: 'HOUR' }),
    ).not.toBeNull()
  })

  it('min > max', () => {
    expect(normalizeSalary({ ...range, min: 5501, max: 5500 })).toBeNull()
  })

  it('a bad currency', () => {
    for (const currency of ['EU', 'EURO', 'E1R', '€', '', null, 978])
      expect(normalizeSalary({ ...range, currency })).toBeNull()
  })

  it('a period outside HOUR / MONTH / YEAR', () => {
    for (const period of ['DAY', 'WEEK', 'month', '', null])
      expect(normalizeSalary({ ...range, period })).toBeNull()
  })
})

describe('salaryMonthlyTop', () => {
  it('is the top of the range per month, max else min, rounded to 2 decimals', () => {
    expect(salaryMonthlyTop({ min: 4000, max: 5500, currency: 'EUR', period: 'MONTH' })).toBe(5500)
    expect(salaryMonthlyTop({ min: 4000, max: null, currency: 'EUR', period: 'MONTH' })).toBe(4000)
    expect(salaryMonthlyTop({ min: null, max: 100_000, currency: 'USD', period: 'YEAR' })).toBe(
      8333.33,
    )
    expect(salaryMonthlyTop({ min: 120, max: 140, currency: 'PLN', period: 'HOUR' })).toBe(22_400)
  })
})

describe('salaryHashPart', () => {
  it('is a flat array in a fixed order', () => {
    expect(salaryHashPart(range as never)).toEqual(['EUR', 'MONTH', 4000, 5500])
  })
})

describe('encodeSalaryClaim / decodeSalaryClaim', () => {
  it('encodes one atomic string, empty for a null bound', () => {
    expect(encodeSalaryClaim(range as never)).toBe('EUR|MONTH|4000|5500')
    expect(encodeSalaryClaim({ ...range, min: null } as never)).toBe('EUR|MONTH||5500')
  })

  it('round-trips both bounds, either bound null', () => {
    for (const s of [range, { ...range, min: null }, { ...range, max: null }])
      expect(decodeSalaryClaim(encodeSalaryClaim(s as never))).toEqual(s)
  })

  it('decodes anything malformed to null (through the same validation)', () => {
    expect(decodeSalaryClaim('EUR|MONTH||')).toBeNull()
    expect(decodeSalaryClaim('garbage')).toBeNull()
    expect(decodeSalaryClaim('EUR|DAY|1|2')).toBeNull()
  })
})
