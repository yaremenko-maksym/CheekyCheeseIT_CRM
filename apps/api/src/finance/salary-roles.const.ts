import type { SessionUser } from '@crm/shared'

/**
 * Roles the monthly SALARY cron (`createMonthlySalaries`) actually processes
 * — mirrors exactly what `resolveHrAccountantSalaryReceivers` /
 * `resolveJuniorSalaryReceivers` target, kept as an explicit named set (not
 * re-derived from those two methods' names) so both the E-5 gap report and
 * the E-6 `mySalaryState` computation in `getSeniorSummary` can ask "is this
 * role one the cron ever accrues to" without a role-by-role reimplementation.
 * Deliberately narrower than `SALARY_ELIGIBLE_ROLES` (@crm/shared, users.ts)
 * — that set ALSO includes SENIOR/DROP, who can only ever receive a
 * MANUALLY created salary (`createSalary`), never a cron-accrued one.
 *
 * security-review round 3 (mutation gate): exported so it can be pinned
 * DIRECTLY — its only current runtime call site is `getSeniorSummary`,
 * which is itself RBAC-gated to SENIOR/ADMIN callers ONLY (see the class's
 * `@Roles` guard). Neither SENIOR nor ADMIN is ever a member of this set,
 * so `.has(currentUser.role)` is FALSE for every real caller regardless of
 * what this set actually contains — gutting it to `[]`, or blanking any of
 * its 3 string literals, changed nothing any existing test could observe
 * through that call site alone (all 4 mutants survived). A direct
 * membership test on the export is the only way to pin the invariant the
 * docblock above already claims ("mirrors exactly what
 * resolveHrAccountantSalaryReceivers / resolveJuniorSalaryReceivers
 * target").
 */
export const CRON_ELIGIBLE_SALARY_ROLES: ReadonlySet<SessionUser['role']> = new Set([
  'HR',
  'ACCOUNTANT',
  'JUNIOR',
])
