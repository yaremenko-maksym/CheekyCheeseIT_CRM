import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultSalaryMonth,
  resolveSalaryPrefillCurrency,
} from '../routes/_authenticated/finance/components/dialogs/create-transaction/shared'

// The clock is frozen with `vi.setSystemTime` and `defaultSalaryMonth()` is
// called WITHOUT an argument, so these cases are red against the pre-fix
// implementation too (which took no argument and read `new Date()` itself).
// Instants are explicit UTC and the default is on the KYIV business-day clock,
// so the tests do not depend on the runner's TZ (run under TZ=America/Los_Angeles
// and TZ=Europe/Kyiv).
describe('defaultSalaryMonth (previous calendar month, overflow-safe)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['31 Oct -> September, not October', new Date(Date.UTC(2026, 9, 31, 12)), '2026-09'],
    ['31 Mar -> February, not March', new Date(Date.UTC(2026, 2, 31, 12)), '2026-02'],
    ['31 May -> April, not May', new Date(Date.UTC(2026, 4, 31, 12)), '2026-04'],
    ['31 Dec -> November', new Date(Date.UTC(2026, 11, 31, 12)), '2026-11'],
    ['1 Jan -> December of the previous year', new Date(Date.UTC(2026, 0, 1, 12)), '2025-12'],
    ['15 Jun -> May', new Date(Date.UTC(2026, 5, 15, 12)), '2026-05'],
    // 22:30Z on 31 Oct = 1 Nov 00:30 Kyiv (UTC+2) / 31 Oct in Los Angeles: Kyiv month wins.
    [
      'Kyiv already in November (22:30Z 31 Oct) -> October',
      new Date(Date.UTC(2026, 9, 31, 22, 30)),
      '2026-10',
    ],
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
