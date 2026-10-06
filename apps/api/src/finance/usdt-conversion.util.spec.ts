import { describe, expect, it } from 'vitest'
import type { CurrencyEnum } from '@crm/shared'

import { convertToUsdtMinor } from './usdt-conversion.util'

// Money math — expected values are hand-computed literals, not recomputed with
// the production formula.
const rates = { usdUah: 40, eurUah: 44 }

describe('convertToUsdtMinor', () => {
  it('USDT is passthrough', () => {
    expect(convertToUsdtMinor(123_456_789, 'USDT', rates)).toBe(123_456_789)
  })

  it('USD is passthrough (USDT pegged 1:1)', () => {
    expect(convertToUsdtMinor(987_654, 'USD', rates)).toBe(987_654)
  })

  it('EUR → amount * eurUah / usdUah (1_000_000 * 44 / 40 = 1_100_000)', () => {
    expect(convertToUsdtMinor(1_000_000, 'EUR', rates)).toBe(1_100_000)
  })

  it('EUR uses eurUah in the numerator and usdUah in the denominator', () => {
    // 10 * 3 / 4 = 7.5 → 8 ; swapped (10 * 4 / 3 = 13.33 → 13) would differ
    expect(convertToUsdtMinor(10, 'EUR', { usdUah: 4, eurUah: 3 })).toBe(8)
  })

  it('EUR rounds half up at .5 and down below it', () => {
    // 5 * 3 / 4 = 3.75 → 4 ; 4 * 3 / 8 = 1.5 → 2 ; 3 * 3 / 8 = 1.125 → 1
    expect(convertToUsdtMinor(5, 'EUR', { usdUah: 4, eurUah: 3 })).toBe(4)
    expect(convertToUsdtMinor(4, 'EUR', { usdUah: 8, eurUah: 3 })).toBe(2)
    expect(convertToUsdtMinor(3, 'EUR', { usdUah: 8, eurUah: 3 })).toBe(1)
  })

  it('UAH → amount / usdUah (4_000_000 / 40 = 100_000)', () => {
    expect(convertToUsdtMinor(4_000_000, 'UAH', rates)).toBe(100_000)
  })

  it('UAH does not involve eurUah', () => {
    expect(convertToUsdtMinor(100, 'UAH', { usdUah: 4, eurUah: 999 })).toBe(25)
  })

  it('UAH rounds half up at .5 (10 / 4 = 2.5 → 3)', () => {
    expect(convertToUsdtMinor(10, 'UAH', { usdUah: 4, eurUah: 1 })).toBe(3)
  })

  it('UAH rounds down below .5 (9 / 4 = 2.25 → 2) and up above (11 / 4 = 2.75 → 3)', () => {
    expect(convertToUsdtMinor(9, 'UAH', { usdUah: 4, eurUah: 1 })).toBe(2)
    expect(convertToUsdtMinor(11, 'UAH', { usdUah: 4, eurUah: 1 })).toBe(3)
  })

  it('zero amount converts to zero', () => {
    expect(convertToUsdtMinor(0, 'EUR', rates)).toBe(0)
    expect(convertToUsdtMinor(0, 'UAH', rates)).toBe(0)
  })

  it('unsupported currency → 400 FINANCE_USDT_CONVERSION_CURRENCY_UNSUPPORTED with currency param', () => {
    expect(() => convertToUsdtMinor(1, 'GBP' as unknown as CurrencyEnum, rates)).toThrowError(
      expect.objectContaining({
        response: expect.objectContaining({
          code: 'FINANCE_USDT_CONVERSION_CURRENCY_UNSUPPORTED',
          statusCode: 400,
          params: { currency: 'GBP' },
        }),
      }),
    )
  })
})
