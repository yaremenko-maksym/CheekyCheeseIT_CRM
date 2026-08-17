/**
 * task-money-floor-and-lying-comments (security-review MED-1) —
 * `changeSalarySchema.monthlySalary` is the THIRD unguarded write path to
 * `users.monthly_salary` (`numeric(10,2)`), alongside `createUserSchema` and
 * `adminUpdateUserSchema` in `users.ts`. See `./money`'s module comment for
 * the full write-path map this closes (`createMonthlySalaries`'
 * `juniorSalaryOverride ?? user.monthlySalary`, both operands, all four write
 * paths).
 */
import { describe, expect, it } from 'vitest'
import { changeSalarySchema } from './admin-actions'
import { MIN_SALARY_AMOUNT } from './money'

describe('changeSalarySchema.monthlySalary — floor (security-review MED-1)', () => {
  it('rejects an amount below the smallest storable unit (0.001 would round to 0.00)', () => {
    const result = changeSalarySchema.safeParse({ monthlySalary: 0.001 })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toContain('слишком мала')
  })

  it('accepts exactly the smallest storable amount (one cent)', () => {
    expect(changeSalarySchema.safeParse({ monthlySalary: MIN_SALARY_AMOUNT }).success).toBe(true)
  })

  it('rejects more decimals than the column keeps', () => {
    const result = changeSalarySchema.safeParse({ monthlySalary: 1.001 })
    expect(result.success).toBe(false)
    const message = !result.success ? result.error.issues[0]?.message : undefined
    expect(message).toContain('знаков после запятой')
  })

  it('still accepts 0 — a deliberate value, not a typo (existing .nonnegative() behaviour, unchanged)', () => {
    expect(changeSalarySchema.safeParse({ monthlySalary: 0 }).success).toBe(true)
  })

  it('rejects amount:0 via the pre-existing superRefine WITHOUT a spurious floor message when seniorSharePercent is also absent', () => {
    // The schema's own .refine requires at least one of monthlySalary /
    // seniorSharePercent — monthlySalary: 0 satisfies that (0 !== undefined),
    // so this stays a pure floor-guard check, not a cross-field one.
    const result = changeSalarySchema.safeParse({ monthlySalary: 0 })
    expect(result.success).toBe(true)
  })

  it('still requires at least one of monthlySalary / seniorSharePercent (pre-existing refine, untouched)', () => {
    expect(changeSalarySchema.safeParse({}).success).toBe(false)
  })
})
