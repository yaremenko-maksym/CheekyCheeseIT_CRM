/**
 * getOwnSalaryStatus — shared helper (DRY: replaces private duplicates in
 * TransactionsService and InterviewsService).
 *
 * Returns the caller's own SALARY transaction for `salaryMonth` (YYYY-MM),
 * or null if none exists yet. Only PENDING / PAID / LOCKED statuses are valid
 * for a SALARY row; any other status maps to null (defensive — should not
 * occur in practice).
 *
 * Extracted in task-dedup-salary-status (#234 MED review): both
 * `getSeniorSummary` and `getHrSummary` contained byte-for-byte identical
 * implementations — one in TransactionsService, one in InterviewsService.
 * Centralising here guarantees the logic can never drift between the two
 * dashboards.
 *
 * The function is intentionally a pure module-level function (not a class
 * method) so it can be imported by any service without introducing a
 * cross-module DI dependency (FinanceModule ↔ InterviewsModule).
 */

import { and, eq } from 'drizzle-orm'
import type { MySalaryStatusDto, SalaryStatus } from '@crm/shared'
import type { DatabaseService } from '../database/database.service'
import { transactions } from '../database/schema'

/**
 * The Drizzle `db` instance is passed in (not `DatabaseService`) so the
 * function stays free of NestJS DI and is trivially testable with a plain
 * mock.
 */
export async function getOwnSalaryStatus(
  db: DatabaseService['db'],
  userId: string,
  salaryMonth: string,
): Promise<MySalaryStatusDto> {
  const salaryRow = await db.query.transactions.findFirst({
    where: and(
      eq(transactions.type, 'SALARY'),
      eq(transactions.receiverId, userId),
      eq(transactions.salaryMonth, salaryMonth),
    ),
  })

  if (!salaryRow) return null

  const validStatuses: SalaryStatus[] = ['PENDING', 'PAID', 'LOCKED']
  if (!validStatuses.includes(salaryRow.status as SalaryStatus)) return null

  return {
    amount: Number(salaryRow.amount),
    currency: salaryRow.currency,
    status: salaryRow.status as SalaryStatus,
  }
}
