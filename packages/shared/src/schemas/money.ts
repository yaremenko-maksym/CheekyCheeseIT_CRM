import { z } from 'zod'

/**
 * task-money-floor-and-lying-comments (security-review MED-1 follow-up).
 *
 * Shared money-floor primitives — factored out into their own module once
 * the "obligation recorded as zero" bug (PR #485) turned out to have a
 * SECOND, cross-file home. `TransactionsService.createMonthlySalaries`
 * resolves the JUNIOR salary reminder as
 * `salaryAmount = project.financeSettings?.juniorSalaryOverride ??
 * user.monthlySalary` and inserts WHICHEVER operand is set directly into
 * `transactions.amount` — bypassing `createSalarySchema` entirely. Flooring
 * only `juniorSalaryOverride` (in `finance.ts`) left the exact same bug
 * reachable through `monthlySalary` (defined in `users.ts`, read by the SAME
 * expression, written via `createUserSchema` / `adminUpdateUserSchema` /
 * `changeSalarySchema` in `admin-actions.ts`) — three more unguarded write
 * paths for the identical column scale. Living here (not in `finance.ts` or
 * `users.ts`) avoids an arbitrary cross-file dependency between two schema
 * files that otherwise import from each other for no other reason.
 */

/**
 * Decimal places a JS number would need to be written out exactly. Shared by
 * every money-floor check in this package (the scale-6 one in `finance.ts`
 * and the scale-2 one below) so "how many digits does this literally have"
 * can never drift between them.
 */
export function decimalPlacesOf(value: number): number {
  const s = String(value)
  // Exponential notation means the value is outside the plain-decimal range
  // JS prints literally (a sub-scale value, or an astronomically large one).
  // Either way it cannot be written to a bounded numeric column as-is.
  if (s.includes('e') || s.includes('E')) return Number.POSITIVE_INFINITY
  const dot = s.indexOf('.')
  return dot === -1 ? 0 : s.length - dot - 1
}

/**
 * Scale of every `numeric(10,2)` salary-shaped column in this monorepo:
 * `users.monthly_salary` and `project_finance_settings.junior_salary_override`
 * (an override OF the former — see the module comment above for the shared
 * write path that makes them the SAME bug surface). DIFFERENT from the
 * scale-6 `transactions.amount` columns (`MIN_TRANSACTION_AMOUNT`/
 * `AMOUNT_DECIMAL_PLACES` in `finance.ts`) — reusing those here would be
 * wrong in the OPPOSITE direction: they would happily accept e.g. `0.001`,
 * which THIS column still cannot store without loss.
 */
export const SALARY_AMOUNT_DECIMAL_PLACES = 2
export const MIN_SALARY_AMOUNT = 0.01 // one cent at scale 2

/**
 * Floor + precision ONLY — deliberately does NOT reject non-finite /
 * non-positive values itself (returns `null` for those); the field's own
 * `.number()`/`.nonnegative()` already produces a dedicated issue for them,
 * and `0` is a legitimate, existing value on every field this is attached to
 * (a deliberate "this person/project earns nothing" override/salary) — this
 * must never turn that into a second, misleading "too small" message.
 *
 * security-review (task-money-floor-and-lying-comments, BLOCKER round):
 * this exact promise — "does not reject 0/NaN itself" — was UNTESTED for the
 * scale-6 sibling (`moneyFloorAndPrecisionError` in finance.ts) and a mutant
 * that dropped it survived, producing a second "слишком мала" issue
 * alongside `amount: 0`'s own positivity error. Pinned directly here (see
 * `money.spec.ts`) so this copy never regresses the same way.
 */
export function salaryAmountFloorError(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null
  if (value < MIN_SALARY_AMOUNT) {
    return `Сумма слишком мала — минимум ${MIN_SALARY_AMOUNT.toFixed(SALARY_AMOUNT_DECIMAL_PLACES)}`
  }
  if (decimalPlacesOf(value) > SALARY_AMOUNT_DECIMAL_PLACES) {
    return `Не больше ${SALARY_AMOUNT_DECIMAL_PLACES} знаков после запятой — иначе сумма запишется округлённой`
  }
  return null
}

/** Attaches `salaryAmountFloorError` to a `z.number()` chain via `.superRefine`. */
export function withSalaryFloor<T extends z.ZodNumber>(schema: T) {
  return schema.superRefine((v, ctx) => {
    const message = salaryAmountFloorError(v)
    if (message) ctx.addIssue({ code: 'custom', message })
  })
}
