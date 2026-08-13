import { describe, it, expect } from 'vitest'
import { MONEY_SCALE, roundShareAmount } from './money'

describe('roundShareAmount', () => {
  it('computes a plain percentage of income', () => {
    expect(roundShareAmount(1000, 26)).toBe(260)
    expect(roundShareAmount(1000, 5)).toBe(50)
  })

  it('matches the exact decimal-safe formula (scale, round once, divide back, 6dp) — not a re-derivation', () => {
    // Regression pin: this test must compute the expected value via the SAME
    // scale/round/divide steps as the function under test, not an independent
    // shortcut (a `toBeCloseTo` against `income * percent / 100` would pass
    // for a plain float division too and never catch a drift in the rounding
    // ORDER, which is the entire reason this helper exists).
    const income = 4708.69
    const percent = 5
    const incomeMinor = Math.round(income * MONEY_SCALE)
    const shareMinor = Math.round((incomeMinor * percent) / 100)
    const expected = Number((shareMinor / MONEY_SCALE).toFixed(6))
    expect(roundShareAmount(income, percent)).toBe(expected)
    expect(roundShareAmount(income, percent)).toBe(235.4345)
  })

  it('reconciles two shares against the gross (senior + drop does not exceed income)', () => {
    const income = 1000
    const senior = roundShareAmount(income, 26)
    const drop = roundShareAmount(income, 5)
    expect(senior + drop).toBeLessThanOrEqual(income)
    expect(senior + drop).toBeCloseTo(310, 6)
  })

  it('returns 0 for a 0% share and the full income for a 100% share', () => {
    expect(roundShareAmount(1000, 0)).toBe(0)
    expect(roundShareAmount(1000, 100)).toBe(1000)
  })

  it('avoids IEEE-754 drift on a fractional income (0.1 + 0.2 class of bug)', () => {
    // A naive `income * percent / 100` on this input drifts in the 15th
    // significant digit; the scale/round/divide pipeline does not.
    expect(roundShareAmount(0.3, 26)).toBe(0.078)
  })
})
