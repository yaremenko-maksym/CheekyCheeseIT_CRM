import { z } from 'zod'

/**
 * task-money-floor-and-lying-comments (security-review MED-1 + BLOCKER
 * follow-up).
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
 *
 * IMPORTANT — 0 is NOT rejected by either floor below, deliberately, because
 * `.nonnegative()` is the pre-existing business decision on every field this
 * module guards (a person/project may genuinely earn/owe nothing). That
 * means an explicit `monthlySalary: 0` / `juniorSalaryOverride: 0` still
 * reaches `createMonthlySalaries`'s `if (!emp.monthlySalary) continue` guard
 * as the STRING `"0.00"` (drizzle's numeric representation) — which is
 * truthy, so the guard does not skip it — and the resulting PENDING SALARY
 * row can later be closed by `paySalary` WITHOUT an explicit `paidAmount`
 * (that field is optional; when omitted the service falls back to
 * `parseFloat(existingRow.amount)` with no floor/positivity re-check at
 * all). The floor in THIS file closes "a value that would silently round to
 * a nonzero-intended amount landing as zero" — it does not, and was never
 * meant to, make a $0 salary/override impossible. Whether $0 should be
 * creatable/payable at all is a separate, open business question, not a gap
 * in this fix.
 *
 * `moneyFloorAndPrecisionError`/`withMoneyFloor` (scale-6,
 * `transactions.amount`) ALSO live here, not in `finance.ts` where they were
 * first written — security-review, BLOCKER round: `withMoneyFloor` is called
 * at MODULE-IMPORT time by 11 schemas inside `finance.ts` itself, three of
 * which chain `.optional()` straight onto its result. A mutant that empties
 * its body makes it return `undefined`, and `undefined.optional()` throws
 * the instant `finance.ts` is imported — before any test body runs — which
 * Stryker's per-test coverage model cannot attribute to a specific test (the
 * whole file collects 0 tests, not a per-test failure), so the mutant
 * "survives" despite being a real, severe regression. This module does NOT
 * consume its own exports at its own top level, so a DIRECT test that
 * imports `withMoneyFloor` and calls it in isolation (see `money.spec.ts`)
 * properly fails, per-test, the moment the mutation is applied — turning an
 * unavoidable suppression into an unnecessary one.
 */

/**
 * Decimal places a JS number would need to be written out exactly. Shared by
 * every money-floor check in this file (scale-6 below, scale-2 further down)
 * so "how many digits does this literally have" can never drift between them.
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
 * Scale of the money columns (`transactions.amount` — `numeric(18,6)`), and
 * the smallest positive value that column can therefore hold.
 *
 * security-review PR #485 (MED-1). `paidAmount` had a ceiling but no FLOOR
 * and no precision rule, so `1e-7` passed validation and then landed in
 * `numeric(18,6)` as `0.000000` — a salary obligation closed in full by a
 * payment recorded as ZERO. The bug was not the number being small; it was
 * the schema promising to store a value it silently could not. Hence the
 * rule below: a value that cannot be written WITHOUT LOSS is not accepted
 * at all.
 */
export const AMOUNT_DECIMAL_PLACES = 6
export const MIN_TRANSACTION_AMOUNT = 1e-6 // 0.000001 — one unit at scale 6

/**
 * task-money-floor-and-lying-comments (security-review follow-up to PR #485).
 * `transactionAmountError` (`finance.ts`) fixed the floor for `paidAmount`
 * alone; every OTHER HAND-ENTERED `amount` field in `finance.ts` that also
 * writes to `transactions.amount` (`numeric(18,6)`) had the identical gap —
 * a value like `1e-7` passed `.positive().max(...)` and then landed in the
 * column as `0.000000` — an obligation recorded as fully paid/booked with
 * ZERO money.
 *
 * This is deliberately NOT "just call `transactionAmountError`" at each call
 * site: that function ALSO enforces `Number.isFinite`, `value > 0`, and the
 * `MAX_TRANSACTION_AMOUNT` ceiling — checks every field in `finance.ts` that
 * uses this already expresses itself via `.number()` / `.positive()` /
 * `.max(...)`, with ONE exception (`createDividendSchema`, which has NO
 * ceiling — "no balance gate" is a deliberate business decision, see its own
 * comment in `finance.ts`). Reusing `transactionAmountError` wholesale there
 * would silently ADD a 500k ceiling that was never asked for. This function
 * adds ONLY the floor + precision rule, so a field's own positivity/ceiling
 * checks are never duplicated or overridden.
 *
 * Deliberately does NOT reject non-finite / non-positive values itself
 * (returns `null` for those) — the field's own `.number()` /
 * `.positive()`/`.nonnegative()` already produces a clearer, dedicated issue
 * for them; this only ever needs to ADD an issue for a value that is
 * genuinely positive but too small or too precise to survive the column.
 *
 * Values BELOW the computed sums a schema legitimately receives (e.g. a
 * server-computed share with a long floating-point tail) are OUT OF SCOPE
 * for this helper — see `settledAmountError` in `exchange-rate.util.ts` for
 * the sibling rule that applies to a SERVER-COMPUTED figure instead of a
 * hand-typed one. Every schema this helper is attached to is parsed
 * directly against a raw HTTP request body (verified against every
 * controller call site) — never against a value the server itself derived.
 *
 * security-review, BLOCKER round: this exact promise — "does not touch
 * 0/NaN/negative" — was UNTESTED and a mutant dropping it survived: `amount:
 * 0` gained a SECOND, misleading "слишком мала" issue alongside
 * `.positive()`'s own rejection. Pinned directly (see `money.spec.ts`) so it
 * cannot regress the same way.
 */
export function moneyFloorAndPrecisionError(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null
  if (value < MIN_TRANSACTION_AMOUNT) {
    return `Сумма слишком мала — минимум ${MIN_TRANSACTION_AMOUNT.toFixed(AMOUNT_DECIMAL_PLACES)}`
  }
  if (decimalPlacesOf(value) > AMOUNT_DECIMAL_PLACES) {
    return `Не больше ${AMOUNT_DECIMAL_PLACES} знаков после запятой — иначе сумма запишется округлённой`
  }
  return null
}

/** Attaches `moneyFloorAndPrecisionError` to a `z.number()` chain via `.superRefine`. */
export function withMoneyFloor<T extends z.ZodNumber>(schema: T) {
  return schema.superRefine((v, ctx) => {
    const message = moneyFloorAndPrecisionError(v)
    if (message) ctx.addIssue({ code: 'custom', message })
  })
}

/**
 * Scale of every `numeric(10,2)` salary-shaped column in this monorepo:
 * `users.monthly_salary` and `project_finance_settings.junior_salary_override`
 * (an override OF the former — see the module comment above for the shared
 * write path that makes them the SAME bug surface). DIFFERENT from the
 * scale-6 `transactions.amount` columns above (`MIN_TRANSACTION_AMOUNT`/
 * `AMOUNT_DECIMAL_PLACES`) — reusing those here would be wrong in the
 * OPPOSITE direction: they would happily accept e.g. `0.001`, which THIS
 * column still cannot store without loss.
 */
export const SALARY_AMOUNT_DECIMAL_PLACES = 2
export const MIN_SALARY_AMOUNT = 0.01 // one cent at scale 2

/**
 * Floor + precision ONLY — deliberately does NOT reject non-finite /
 * non-positive values itself (returns `null` for those); the field's own
 * `.number()`/`.nonnegative()` already produces a dedicated issue for them,
 * and `0` is a legitimate, existing value on every field this is attached to
 * (a deliberate "this person/project earns nothing" override/salary) — this
 * must never turn that into a second, misleading "too small" message. See
 * the module comment above for exactly how far that "0 passes" guarantee
 * reaches (and where it stops) downstream.
 *
 * security-review (task-money-floor-and-lying-comments, BLOCKER round):
 * this exact promise — "does not reject 0/NaN itself" — was UNTESTED for the
 * scale-6 sibling (`moneyFloorAndPrecisionError` above) and a mutant that
 * dropped it survived, producing a second "слишком мала" issue alongside
 * `amount: 0`'s own positivity error. Pinned directly here (see
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
