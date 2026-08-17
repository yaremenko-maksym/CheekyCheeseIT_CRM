/**
 * SEC-1 (mega-audit wave 2, round 4) — shared fixture for integration specs
 * that need a genuine, real-Postgres off-currency company-account row
 * (the exact shape `assertNoOffCurrencyCompanyRows` in company-account-balance
 * .ts looks for) WITHOUT corrupting any other spec's concurrent run.
 *
 * WHY THIS EXISTS: `assertNoOffCurrencyCompanyRows` scans the `transactions`
 * table GLOBALLY — there is no per-spec scoping possible for it — and
 * `crm_qa` is a scratch DB shared by multiple concurrently-running agents. A
 * naive insert-then-delete would let ANY other process's company-account
 * gate call (`createExpense` / `paySalary` / `settleByCompany` /
 * `createDividend`) observe the row for the whole window it exists and fail
 * with `CompanyAccountOffCurrencyError` — a new, avoidable source of the
 * exact "shared scratch DB contamination" flakiness this project already
 * has one instance of (see `admin-income-drop-backfill.integration.spec.ts`'s
 * own `assertNoForeignCandidateProjects` self-diagnosis).
 *
 * THE FIX: hold a SESSION-scoped Postgres advisory lock
 * (`pg_advisory_lock`), on a DEDICATED connection, on the SAME key every
 * real company-account gate acquires via `lockCompanyAccount`
 * (transaction-scoped `pg_advisory_xact_lock`) before reading the balance.
 * Session- and transaction-scoped advisory locks share ONE key space in
 * Postgres, so a concurrent `pg_advisory_xact_lock` call — inside this
 * process or another agent's — BLOCKS (waits) instead of racing past into a
 * corrupted read. It resumes, against a clean table, only once this fixture
 * cleans up and unlocks.
 *
 * `lockCompanyAccount` itself is NOT reusable here: its lock releases at
 * COMMIT, but the row only becomes VISIBLE to OTHER connections AT commit —
 * a single transaction-scoped primitive cannot hold the lock AND have
 * already committed at the same time, and the guard's read (a plain SELECT
 * on a different connection, under READ COMMITTED) needs the row committed
 * to see it at all.
 *
 * Read-only callers (`computeCompanyAccountBalanceForDisplay` /
 * `CompanyAccountService.getAccount`) do NOT acquire this lock and are
 * intentionally UNAFFECTED by it — a concurrent display read legitimately
 * observing a degraded balance during this window is exactly the behaviour
 * SEC-1 exists to make survivable, not a bug to hide.
 */
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { Pool } from 'pg'
import { COMPANY_ACCOUNT_LOCK_KEY } from '../company-account-balance'
import { transactions } from '../../database/schema'
import * as schema from '../../database/schema'

type Db = ReturnType<typeof drizzle<typeof schema>>

/**
 * Inserts a single row (`rowValues`, MUST carry an explicit `id`) while
 * holding the shared company-account advisory lock, runs `run()`, then
 * deletes the row and releases the lock — in a `finally`, so a thrown
 * assertion inside `run()` still cleans up and unlocks.
 *
 * `pool` MUST be a real `pg.Pool` connected to the SAME database as `db` —
 * the lock is acquired on a connection checked out from it, independent of
 * whatever connection(s) `db`'s own queries use internally.
 */
export async function withIsolatedOffCurrencyRow(
  pool: Pool,
  db: Db,
  rowValues: typeof transactions.$inferInsert & { id: string },
  run: () => Promise<void>,
): Promise<void> {
  const lockClient = await pool.connect()
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [COMPANY_ACCOUNT_LOCK_KEY.toString()])
    await db.insert(transactions).values(rowValues)
    await run()
  } finally {
    await db.delete(transactions).where(eq(transactions.id, rowValues.id))
    await lockClient.query('SELECT pg_advisory_unlock($1)', [COMPANY_ACCOUNT_LOCK_KEY.toString()])
    lockClient.release()
  }
}
