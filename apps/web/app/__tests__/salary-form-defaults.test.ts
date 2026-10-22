import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultSalaryMonth,
  resolveSalaryPrefillCurrency,
} from '../routes/_authenticated/finance/components/dialogs/create-transaction/shared'

// The clock is frozen with `vi.setSystemTime` and `defaultSalaryMonth()` is
// called WITHOUT an argument, so these cases are red against the pre-fix
// implementation too (which took no argument and read `new Date()` itself).
// Dates use the LOCAL-time constructor: the default is a browser-local-clock
// value (same basis as the API's previousSalaryMonthKey), so the tests must
// not depend on the runner's TZ.
describe('defaultSalaryMonth (previous calendar month, overflow-safe)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['31 Oct -> September, not October', new Date(2026, 9, 31, 12), '2026-09'],
    ['31 Mar -> February, not March', new Date(2026, 2, 31, 12), '2026-02'],
    ['31 May -> April, not May', new Date(2026, 4, 31, 12), '2026-04'],
    ['31 Dec -> November', new Date(2026, 11, 31, 12), '2026-11'],
    ['1 Jan -> December of the previous year', new Date(2026, 0, 1, 12), '2025-12'],
    ['15 Jun -> May', new Date(2026, 5, 15, 12), '2026-05'],
  ])('%s', (_name, now, expected) => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    expect(defaultSalaryMonth()).toBe(expected)
  })
})

describe('resolveSalaryPrefillCurrency', () => {
  it('prefers the nominal originalCurrency over the settled currency (PAID USDT row, nominal USD)', () => {
    expect(resolveSalaryPrefillCurrency({ currency: 'USDT', originalCurrency: 'USD' })).toBe('USD')
  })
  it('falls back to currency when originalCurrency is null/undefined', () => {
    expect(resolveSalaryPrefillCurrency({ currency: 'EUR', originalCurrency: null })).toBe('EUR')
    expect(resolveSalaryPrefillCurrency({ currency: 'UAH' })).toBe('UAH')
  })
  it('returns undefined for a value outside the currency enum (no blind cast)', () => {
    expect(resolveSalaryPrefillCurrency({ currency: 'XYZ' })).toBeUndefined()
  })
})
