/**
 * Pins the pure helpers + constants that `CreateTransactionDialog` shares with its
 * extracted subcomponents (`create-transaction/shared.tsx`). Behaviour was moved
 * verbatim out of the dialog; these expectations are hand-computed literals, not
 * re-derived from the code under test.
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  TYPE_ICONS,
  getRate,
  needsConversion,
  type ExchangeRate,
} from '../create-transaction/shared'

const RATES: ExchangeRate = { usdUah: '40', usdtUah: '40.5', eurUah: '44', date: '2025-01-15' }

describe('needsConversion', () => {
  it.each(['EUR', 'UAH', 'USD'] as const)('%s needs an NBU conversion rate', (c) => {
    expect(needsConversion(c)).toBe(true)
  })

  it('USDT does not', () => {
    expect(needsConversion('USDT')).toBe(false)
  })
})

describe('getRate', () => {
  it('returns null while rates have not loaded, for every currency', () => {
    expect(getRate('EUR', undefined)).toBeNull()
    expect(getRate('UAH', undefined)).toBeNull()
    expect(getRate('USD', undefined)).toBeNull()
    expect(getRate('USDT', undefined)).toBeNull()
  })

  it('EUR -> USD is eurUah / usdUah (44 / 40 = 1.1)', () => {
    expect(getRate('EUR', RATES)).toBeCloseTo(1.1, 10)
  })

  it('UAH -> USD is 1 / usdUah (1 / 40 = 0.025)', () => {
    expect(getRate('UAH', RATES)).toBeCloseTo(0.025, 10)
  })

  it('USD is 1:1', () => {
    expect(getRate('USD', RATES)).toBe(1)
  })

  it('USDT has no conversion rate', () => {
    expect(getRate('USDT', RATES)).toBeNull()
  })
})

describe('TYPE_ICONS', () => {
  it('has an icon for every type card the dialog can render', () => {
    for (const key of [
      'ADMIN_INCOME',
      'SENIOR_INCOME',
      'DROP_INCOME',
      'EXPENSE',
      'SALARY',
      'ADMIN_TRANSFER',
      'DIVIDEND',
    ]) {
      expect(TYPE_ICONS[key], key).toBeDefined()
      expect(renderToStaticMarkup(<>{TYPE_ICONS[key]}</>)).toContain('<svg')
    }
  })
})
