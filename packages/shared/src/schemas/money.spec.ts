/**
 * task-money-floor-and-lying-comments (security-review MED-1 + BLOCKER
 * follow-up). Direct, exhaustive unit pins for BOTH shared money-floor
 * primitives in `./money` — scale-6 (`moneyFloorAndPrecisionError`/
 * `withMoneyFloor`, `transactions.amount`) and scale-2
 * (`salaryAmountFloorError`/`withSalaryFloor`, the salary-shaped columns).
 * Every branch is asserted by EXACT return value, not routed through a
 * schema, so a comparison/logical-operator mutation on either guard is
 * caught regardless of which call site (11 for the scale-6 one, 4 for the
 * scale-2 one) happens to exercise it.
 *
 * security-review round 3 (MED-A): `moneyFloorAndPrecisionError`/
 * `withMoneyFloor` moved INTO this file (were in `finance.ts`) specifically
 * so this direct test could exist. `finance.ts` calls `withMoneyFloor` 11
 * times at its OWN module-import time; a mutant emptying the function body
 * makes `finance.ts` crash on import before any test in a `finance.*`
 * spec file can run, which is invisible to Stryker's per-test coverage
 * model (the whole file collects 0 tests, not a per-test failure) — the
 * BLOCKER-round suppression this file's presence now makes unnecessary.
 * This module does not call `withMoneyFloor`/`withSalaryFloor` at its own
 * top level, so a test HERE that imports and calls either function directly
 * is never affected by that crash and fails per-test exactly as expected.
 */
import { describe, expect, it } from 'vitest'
import {
  AMOUNT_DECIMAL_PLACES,
  MIN_SALARY_AMOUNT,
  MIN_TRANSACTION_AMOUNT,
  SALARY_AMOUNT_DECIMAL_PLACES,
  decimalPlacesOf,
  moneyFloorAndPrecisionError,
  salaryAmountFloorError,
  withMoneyFloor,
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

// ── BLOCKER (security-review) — pin `moneyFloorAndPrecisionError`'s EXACT
// return value for every branch, directly — not routed through a schema.
// This is the ONLY test shape that reliably catches a mutation on the guard
// clause regardless of which of the 11 `finance.ts` call sites happens to
// exercise it: a schema-level `.success===false` check cannot tell
// "rejected for being too small" apart from "rejected for being
// non-positive, PLUS a spurious second message" — both parse-fail the same
// way. Lives HERE (not in `finance.money-floor.spec.ts`) because this file
// does not import `finance.ts`, so a mutation that crashes `finance.ts` on
// import cannot affect this test's ability to run and fail cleanly.
describe('moneyFloorAndPrecisionError — exact return value per branch', () => {
  it('returns null for exactly 0 — must NOT add a second "слишком мала" message alongside .positive()\'s own rejection', () => {
    expect(moneyFloorAndPrecisionError(0)).toBeNull()
  })

  it('returns null for a negative value — same reasoning as 0', () => {
    expect(moneyFloorAndPrecisionError(-1)).toBeNull()
    expect(moneyFloorAndPrecisionError(-0.0000001)).toBeNull()
  })

  it('returns null for NaN', () => {
    expect(moneyFloorAndPrecisionError(Number.NaN)).toBeNull()
  })

  it('returns null for +Infinity and -Infinity', () => {
    expect(moneyFloorAndPrecisionError(Number.POSITIVE_INFINITY)).toBeNull()
    expect(moneyFloorAndPrecisionError(Number.NEGATIVE_INFINITY)).toBeNull()
  })

  it('returns the "too small" message for a positive value below MIN_TRANSACTION_AMOUNT', () => {
    expect(moneyFloorAndPrecisionError(1e-7)).toContain('слишком мала')
  })

  it('returns null exactly AT the floor boundary — MIN_TRANSACTION_AMOUNT itself is storable', () => {
    expect(moneyFloorAndPrecisionError(MIN_TRANSACTION_AMOUNT)).toBeNull()
  })

  it('returns the "too many decimals" message above AMOUNT_DECIMAL_PLACES digits', () => {
    expect(moneyFloorAndPrecisionError(1.1234567)).toContain(
      `${AMOUNT_DECIMAL_PLACES} знаков после запятой`,
    )
  })

  it('returns null for exactly AMOUNT_DECIMAL_PLACES digits — the boundary is inclusive', () => {
    expect(moneyFloorAndPrecisionError(1.123456)).toBeNull()
  })

  it('returns null for an ordinary valid amount', () => {
    expect(moneyFloorAndPrecisionError(100.5)).toBeNull()
  })
})

describe('withMoneyFloor — wiring (a plain schema, independent of finance.ts)', () => {
  const positiveCapped = withMoneyFloor(z.number().positive().max(500_000))

  it('rejects a too-small positive value', () => {
    const result = positiveCapped.safeParse(1e-7)
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toContain('слишком мала')
    // Pins the ISSUE SHAPE, not just the message — a mutant that keeps the
    // message but corrupts `code` ('custom' → '') is otherwise unobserved.
    const code = !result.success ? result.error.issues[0]?.code : undefined
    expect(code).toBe('custom')
  })

  it('accepts the boundary minimum', () => {
    expect(positiveCapped.safeParse(MIN_TRANSACTION_AMOUNT).success).toBe(true)
  })

  // `amount: 0` must fail ONLY via `.positive()`'s own issue, never gain a
  // second "слишком мала" — the exact BLOCKER-round regression, now pinned
  // through the REAL wrapper (not just the pure function above).
  it('amount:0 fails via .positive() alone — no duplicate message', () => {
    const result = positiveCapped.safeParse(0)
    expect(result.success).toBe(false)
    const messages = !result.success ? result.error.issues.map((i) => i.message) : []
    expect(messages.some((m) => m.includes('слишком мала'))).toBe(false)
  })

  // Emptying `withMoneyFloor`'s body (the BLOCKER-round BlockStatement
  // mutant) makes it return `undefined` — this schema construction itself
  // would then throw immediately. Asserting the wrapped schema is usable at
  // all is therefore also a (redundant but cheap) kill for that mutant,
  // independent of the two behavioural tests above.
  it('returns a usable schema, not undefined', () => {
    expect(positiveCapped).toBeDefined()
    expect(typeof positiveCapped.safeParse).toBe('function')
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
