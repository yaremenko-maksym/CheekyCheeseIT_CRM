/**
 * task-money-floor-and-lying-comments (security-review MED-1 + BLOCKER
 * follow-up). Direct, exhaustive unit pins for the shared scale-2
 * money-floor primitives in `./money` — the same discipline the BLOCKER
 * round required for the scale-6 sibling in `finance.ts`
 * (`moneyFloorAndPrecisionError`): every branch of `salaryAmountFloorError`
 * is asserted by EXACT return value, not routed through a schema, so a
 * comparison/logical-operator mutation on the guard is caught regardless of
 * which of the FOUR call sites (`users.ts` ×2, `admin-actions.ts`,
 * `finance.ts`'s `juniorSalaryOverride`) happens to exercise it.
 */
import { describe, expect, it } from 'vitest'
import {
  MIN_SALARY_AMOUNT,
  SALARY_AMOUNT_DECIMAL_PLACES,
  decimalPlacesOf,
  salaryAmountFloorError,
  withSalaryFloor,
} from './money'
import { z } from 'zod'

describe('decimalPlacesOf', () => {
  it('returns 0 for an integer', () => {
    expect(decimalPlacesOf(1500)).toBe(0)
    expect(decimalPlacesOf(0)).toBe(0)
  })

  it('counts fractional digits exactly', () => {
    expect(decimalPlacesOf(1.5)).toBe(1)
    expect(decimalPlacesOf(1.23)).toBe(2)
    expect(decimalPlacesOf(1.123456)).toBe(6)
  })

  it('returns +Infinity for exponential notation (below 1e-6 or astronomically large)', () => {
    expect(decimalPlacesOf(1e-7)).toBe(Number.POSITIVE_INFINITY)
    expect(decimalPlacesOf(1e21)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('salaryAmountFloorError — exact return value per branch (mirrors the BLOCKER-round scale-6 pin)', () => {
  it('returns null for exactly 0 — a deliberate "no salary" override, must not become an error', () => {
    expect(salaryAmountFloorError(0)).toBeNull()
  })

  it("returns null for a negative value (that is `.nonnegative()`'s own job)", () => {
    expect(salaryAmountFloorError(-1)).toBeNull()
    expect(salaryAmountFloorError(-0.001)).toBeNull()
  })

  it('returns null for NaN', () => {
    expect(salaryAmountFloorError(Number.NaN)).toBeNull()
  })

  it('returns null for +Infinity and -Infinity', () => {
    expect(salaryAmountFloorError(Number.POSITIVE_INFINITY)).toBeNull()
    expect(salaryAmountFloorError(Number.NEGATIVE_INFINITY)).toBeNull()
  })

  it('returns the "too small" message for a positive value below MIN_SALARY_AMOUNT (0.001 would round to 0.00)', () => {
    expect(salaryAmountFloorError(0.001)).toContain('слишком мала')
  })

  it('returns null exactly AT the floor boundary — one cent is storable', () => {
    expect(salaryAmountFloorError(MIN_SALARY_AMOUNT)).toBeNull()
  })

  it('returns the "too many decimals" message above SALARY_AMOUNT_DECIMAL_PLACES digits', () => {
    expect(salaryAmountFloorError(1.001)).toContain(
      `${SALARY_AMOUNT_DECIMAL_PLACES} знаков после запятой`,
    )
  })

  it('returns null for exactly SALARY_AMOUNT_DECIMAL_PLACES digits — the boundary is inclusive', () => {
    expect(salaryAmountFloorError(1.5)).toBeNull()
    expect(salaryAmountFloorError(1.55)).toBeNull()
  })

  it('returns null for an ordinary valid salary amount', () => {
    expect(salaryAmountFloorError(30_000)).toBeNull()
  })
})

describe('withSalaryFloor — wiring (a plain schema, independent of users.ts/finance.ts)', () => {
  const nonneg = withSalaryFloor(z.number().nonnegative())

  it('accepts 0 cleanly — success true, not merely "no spurious message"', () => {
    expect(nonneg.safeParse(0).success).toBe(true)
  })

  it('rejects a too-small positive value', () => {
    const result = nonneg.safeParse(0.001)
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toContain('слишком мала')
    // Pins the ISSUE SHAPE, not just the message — a mutant that keeps the
    // message but corrupts `code` ('custom' → '') is otherwise unobserved.
    const code = !result.success ? result.error.issues[0]?.code : undefined
    expect(code).toBe('custom')
  })

  it('accepts the boundary minimum', () => {
    expect(nonneg.safeParse(MIN_SALARY_AMOUNT).success).toBe(true)
  })

  // Same guard, attached to a `.positive()` chain instead — mirrors the
  // finance.ts `moneyFloorAndPrecisionError` scenario exactly: `0` must fail
  // ONLY via `.positive()`'s own issue, never gain a second "слишком мала".
  it('on a .positive() chain, amount:0 fails via .positive() alone — no duplicate message', () => {
    const pos = withSalaryFloor(z.number().positive())
    const result = pos.safeParse(0)
    expect(result.success).toBe(false)
    const messages = !result.success ? result.error.issues.map((i) => i.message) : []
    expect(messages.some((m) => m.includes('слишком мала'))).toBe(false)
  })
})
