/**
 * getOwnSalaryStatus — shared helper (DRY: replaces private duplicates in
 * TransactionsService and InterviewsService).
 *
 * Returns the caller's own SALARY transaction for `salaryMonth` (YYYY-MM) as
 * one of THREE explicit states (task-salary-month-gap-and-status, E-6 — see
 * the module comment on `mySalaryStatusSchema` in @crm/shared for the full
 * rationale): `NOT_CONFIGURED` (no `monthlySalary` set — this person will
 * never get a row), `AWAITING_CREATION` (configured, but no row yet for this
 * month), or `EXISTS` (the row, same fields as before). Only PENDING / PAID /
 * LOCKED statuses count as a valid EXISTS row; any other status degrades to
 * the same NOT_CONFIGURED/AWAITING_CREATION branching as a missing row
 * (defensive — should not occur in practice).
 *
 * `hasSalaryConfigured` is passed in by the caller (not re-derived here) —
 * the caller already has the user row in hand (`getSeniorSummary` fetches
 * `selfUser` for the share-percent resolution regardless), so a second query
 * here would be a redundant round-trip for a single boolean.
 *
 * Extracted in task-dedup-salary-status (#234 MED review): both
 * `getSeniorSummary` and `getHrSummary` contained byte-for-byte identical
 * implementations — one in TransactionsService, one in InterviewsService.
 * Centralising here guarantees the logic can never drift between the two
 * dashboards. (`getHrSummary` no longer surfaces this field — see the schema
 * comment — but the helper stays module-level/DI-free for any future re-add.)
 *
 * The function is intentionally a pure module-level function (not a class
 * method) so it can be imported by any service without introducing a
 * cross-module DI dependency (FinanceModule ↔ InterviewsModule).
 */

import { and, eq } from 'drizzle-orm'
import type { MySalaryStatusDto, SalaryStatus } from '@crm/shared'
import type { DatabaseService } from '../database/database.service'
// security-review PR #456 round 2: reads the `nonDeletedTransactions` VIEW —
// a deleted SALARY reminder cannot resurface here no matter what, see
// schema.ts's doc on the view (this file is also imported by
// InterviewsService, a DIFFERENT NestJS module — exactly the cross-module
// case the round-1 scanner failed to hold the line on).
import { nonDeletedTransactions } from '../database/schema'

/**
 * The Drizzle `db` instance is passed in (not `DatabaseService`) so the
 * function stays free of NestJS DI and is trivially testable with a plain
 * mock.
 */
export async function getOwnSalaryStatus(
  db: DatabaseService['db'],
  userId: string,
  salaryMonth: string,
  hasSalaryConfigured: boolean,
): Promise<MySalaryStatusDto> {
  const [salaryRow] = await db
    .select()
    .from(nonDeletedTransactions)
    .where(
      and(
        eq(nonDeletedTransactions.type, 'SALARY'),
        eq(nonDeletedTransactions.receiverId, userId),
        eq(nonDeletedTransactions.salaryMonth, salaryMonth),
      ),
    )
    .limit(1)

  const validStatuses: SalaryStatus[] = ['PENDING', 'PAID', 'LOCKED']
  if (!salaryRow || !validStatuses.includes(salaryRow.status as SalaryStatus)) {
    return hasSalaryConfigured ? { state: 'AWAITING_CREATION' } : { state: 'NOT_CONFIGURED' }
  }

  return {
    state: 'EXISTS',
    amount: Number(salaryRow.amount),
    currency: salaryRow.currency,
    status: salaryRow.status as SalaryStatus,
  }
}
