import { and, eq } from 'drizzle-orm'
import { accountsForSalaryMonth, isAutomaticSalaryOrigin } from '@crm/shared'
import type { DrizzleTx } from '../database/types'
import { salaryMonthInitializations, transactions } from '../database/schema'
import { accountsForSalaryMonthSql } from './salary-origin'

/**
 * The salary-month marker migration of `AdminEditService.adminUpdateTransaction`,
 * moved out unchanged (CR-M-5: the service file outgrew the 800-line cap). Runs
 * inside the edit's own DB transaction, after the source-row UPDATE.
 *
 * Multipart salary: before this feature, the receiver/month unique
 * index itself was cron idempotency. Moving an unpaid salary row to
 * another month therefore automatically freed the old month. The
 * durable marker must preserve that behaviour for legacy/CRON rows or
 * an admin correction would leave a stale marker behind and cron would
 * silently skip the now-empty old month forever.
 *
 * SR-795-M-1 / owner decision D-3: a MANUAL part is now ALSO a marker
 * owner — the first part recorded for a receiver/month claims the slot
 * so cron skips that month (see `createSalary`). So a manual part moved
 * to another month has to carry its marker with it, exactly like a
 * legacy/CRON row, or the old month stays claimed with no salary in it
 * and cron skips it forever. Only ADJUSTED rows own nothing: one became
 * ADJUSTED precisely because another row already held that month.
 */
export async function migrateSalaryMonthMarker(
  dbtx: DrizzleTx,
  tx: typeof transactions.$inferSelect,
  targetMonth: string | undefined,
  salaryMonthChanged: boolean,
  actorId: string,
): Promise<void> {
  if (
    salaryMonthChanged &&
    tx.type === 'SALARY' &&
    tx.receiverId &&
    tx.salaryMonth &&
    targetMonth &&
    accountsForSalaryMonth(tx.salaryOrigin)
  ) {
    const claimedTarget = await dbtx
      .insert(salaryMonthInitializations)
      .values({
        receiverId: tx.receiverId,
        salaryMonth: targetMonth,
        initializedBy: actorId,
      })
      .onConflictDoNothing({
        target: [salaryMonthInitializations.receiverId, salaryMonthInitializations.salaryMonth],
      })
      .returning({ id: salaryMonthInitializations.id })

    // If the destination was already initialized, another automatic or
    // legacy salary already owns that month. The moved row remains an
    // operator correction of an automatic row but no longer owns the
    // automatic slot. SR-795-M-3 (PR #868): ADJUSTED, not MANUAL — a
    // MANUAL salary must carry an idempotency key
    // (ck_transactions_manual_salary_idempotency_key) and a cron/legacy
    // row has none, so MANUAL here was a CHECK violation (500).
    //
    // Only an AUTOMATIC row is reclassified. A MANUAL part keeps its
    // origin: it carries an idempotency key and a persisted creation
    // intent (`salary_creation_intent`), and both describe a manual
    // request that an admin moving its month does not retract. It simply
    // arrives at the destination without the marker, which is the same
    // position as any second manual part of an already-claimed month.
    if (claimedTarget.length === 0 && isAutomaticSalaryOrigin(tx.salaryOrigin)) {
      await dbtx
        .update(transactions)
        .set({ salaryOrigin: 'ADJUSTED' })
        .where(eq(transactions.id, tx.id))
    }

    // Keep the old marker only when another raw row still accounts for
    // that month. Deliberately include soft-deleted rows: deleting a
    // salary is an audit event, not permission for cron to resurrect it
    // (same invariant as createMonthlySalaries).
    //
    // CR-795-M-7 / D-3: the predicate is the shared "accounts for the
    // month" fragment, which — unlike the automatic-component one this
    // query used before — also counts a MANUAL part. It has to: since the
    // first manual part of a month claims the marker, a sibling manual
    // part left behind in the old month is exactly the evidence that the
    // old month is still accounted for.
    const [oldMonthEvidence] = await dbtx
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.type, 'SALARY'),
          eq(transactions.receiverId, tx.receiverId),
          eq(transactions.salaryMonth, tx.salaryMonth),
          accountsForSalaryMonthSql(),
        ),
      )
      .limit(1)

    if (!oldMonthEvidence) {
      await dbtx
        .delete(salaryMonthInitializations)
        .where(
          and(
            eq(salaryMonthInitializations.receiverId, tx.receiverId),
            eq(salaryMonthInitializations.salaryMonth, tx.salaryMonth),
          ),
        )
    }
  }
}
