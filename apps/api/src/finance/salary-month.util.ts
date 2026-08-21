/**
 * previousSalaryMonthKey — the SINGLE definition of "which month does the
 * monthly SALARY cron currently target".
 *
 * task-salary-month-gap-and-status security-review HIGH-2: `SalaryCronService
 * .handleMonthlySalaries` runs at 00:00 on the 1st and always accrues for the
 * month that JUST ENDED (the previous calendar month) — verified by reading
 * that method, not assumed. `TransactionsService.getSalaryMonthGapReport`
 * used to default its `?month` query param to the CURRENT UTC month instead
 * (copying the convention `getSeniorSummary`/`getIncomeComplianceOverview`
 * use for THEIR "this month" figures) — a plausible-looking but wrong
 * default for a report whose whole point is "did the cron do its job",
 * because the cron has NEVER once touched the current month by the time
 * anyone would look. Reviewed against real data: the report defaulted to
 * reporting the entire salaried population as "100% missing" every single
 * day before the 1st, with an ADMIN-only "Backfill" button right next to it
 * that would happily create a real, uniquely-indexed SALARY ledger for a
 * month nobody has worked yet.
 *
 * Extracted so `SalaryCronService` (the actual trigger) and the gap report's
 * default can never drift apart again — both call THIS function, neither
 * re-derives the computation locally.
 *
 * Deliberately LOCAL server time (`getFullYear()`/`getMonth()`), matching
 * the cron's pre-existing, unchanged computation exactly — NOT UTC, unlike
 * the sibling "this month" resolvers elsewhere in this module (getSeniorSummary
 * etc.). Truthfulness to "what did the cron actually just do" requires
 * matching the cron's own clock basis bit-for-bit; reconciling the cron's
 * local-time convention with the rest of the codebase's UTC convention is a
 * separate, pre-existing question this task does not decide.
 */
export function previousSalaryMonthKey(now: Date = new Date()): string {
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`
}
