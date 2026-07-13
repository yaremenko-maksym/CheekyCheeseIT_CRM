/**
 * task-salary-company-account — SINGLE SOURCE OF TRUTH for the company USDT
 * account balance.
 *
 * Previously the balance was computed in TWO places that had drifted apart:
 *   - `CompanyAccountService.computeBalance`         (display: GET /company-account)
 *   - `TransactionsService.computeCompanyAccountBalance` (gate: createSalary etc.)
 * The gate version was missing the `+PAYOUT(COMPANY_ACCOUNT)` term, so the gate
 * undercounted the real balance. This module collapses both into ONE pure,
 * free-function so display and gate are BYTE-FOR-BYTE identical.
 *
 * Implemented as a plain free function taking the Drizzle `db` instance (not a
 * NestJS service) so it carries no DI dependency and both services can call it
 * without a constructor/module change (which would ripple through ~26 specs
 * that build `new TransactionsService(...)` directly).
 *
 * Ledger formula (all terms PAID, all USDT — company account is USDT-only, so
 * NO currency conversion is applied; non-USDT company-funded rows are a client
 * bug rejected upstream):
 *
 *   Balance = + Σ(COMPANY_DEPOSIT        PAID, currency='USDT')
 *             + Σ(PAYOUT                 PAID, fundingSource='COMPANY_ACCOUNT', currency='USDT')
 *             + Σ(ADMIN_INCOME           PAID, fundingSource='COMPANY_ACCOUNT', currency='USDT')
 *             − Σ(DIVIDEND_TO_ADMIN      PAID, currency='USDT')
 *             − Σ(SALARY                 PAID, fundingSource='COMPANY_ACCOUNT', currency='USDT')
 *             − Σ(EXPENSE                PAID, fundingSource='COMPANY_ACCOUNT', currency='USDT')
 *             − Σ(SENIOR_INCOME          PAID, fundingSource='COMPANY_ACCOUNT', currency='USDT')
 *             − Σ(PAYOUT_DROP            PAID, fundingSource='COMPANY_ACCOUNT', currency='USDT')
 *
 * AC5 (BIZ-23 defence-in-depth): every term is additionally filtered by
 * currency='USDT'. The company account is USDT-only; upstream creation rejects
 * non-USDT rows, but the ledger formula adds its own guard so a mis-categorised
 * row cannot silently distort the balance.
 *
 * The two `← НОВОЕ` terms (ADMIN_INCOME +, EXPENSE −) were added in
 * task-salary-company-account: admin income directed into the company pool
 * credits the account, company-funded expenses debit it.
 *
 * The SENIOR_INCOME − term (task-drop-payout-company-account) closes the
 * drop-payout loop: when a DROP settles to the company the FULL payable is
 * credited (+PAYOUT COMPANY_ACCOUNT), but the senior's share of that payable is
 * owed by the company. ADMIN/ACCOUNTANT later closes that obligation via
 * settleByCompany, which pays the senior a SENIOR_INCOME funded from the company
 * account — so it MUST debit the company balance, else the senior share would be
 * double-counted (held by the company AND received by the senior). The marker is
 * stamped ONLY on company-funded SENIOR_INCOME (settleByCompany on a COMPANY
 * debt); legacy DROP-debt settlements + ordinary senior income leave it NULL and
 * are correctly ignored here.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { DatabaseService } from '../database/database.service'
import type { DrizzleTx } from '../database/types'
import { transactions } from '../database/schema'

/**
 * Either the base pool handle (`DatabaseService['db']`) or a transaction handle
 * (`DrizzleTx`) opened by `db.transaction(...)`. The balance is read through the
 * SAME query surface from both; the gate paths pass the `DrizzleTx` so the read
 * runs INSIDE the advisory-locked transaction and sees the consistent view.
 */
type Db = DatabaseService['db'] | DrizzleTx

/** Funding-source marker for company-account-routed money movements. */
const COMPANY_ACCOUNT = 'COMPANY_ACCOUNT'

/**
 * Public alias of the funding-source marker so other services (e.g.
 * PendingSettlementService.settleByCompany) stamp the SAME value the ledger
 * formula reads — one constant, no drift between the writer and the reader.
 */
export const COMPANY_ACCOUNT_FUNDING_SOURCE = COMPANY_ACCOUNT

/**
 * MED-1 (TOCTOU) — single advisory-lock key that serializes every
 * balance-mutating debit on the company USDT account.
 *
 * The company balance is a GLOBAL ledger aggregate (SUM over many rows), not a
 * single stored column, so a `SELECT … FOR UPDATE` on one row cannot serialize
 * the "read balance → check ≥ amount → write debit" sequence. Instead every
 * debit path wraps that sequence in a DB transaction and acquires this SAME
 * transaction-scoped advisory lock first (`pg_advisory_xact_lock`). Two
 * concurrent debits therefore run STRICTLY one-after-the-other: the second
 * blocks on the lock, then re-reads the already-reduced balance and correctly
 * fails the gate — the account can never be driven negative.
 *
 * MUST be the ONE key shared by createExpense / createSalary / paySalary (and
 * any future company-account debit). Value is an arbitrary fixed bigint
 * namespaced to this lock; never reuse it for unrelated advisory locks.
 */
export const COMPANY_ACCOUNT_LOCK_KEY = 8841001n

/**
 * Acquire the company-account advisory lock for the CURRENT transaction. Held
 * until the transaction commits/rolls back, then auto-released. Call this as the
 * FIRST statement inside the `db.transaction(...)` block that gates+writes a
 * company-account debit, BEFORE re-reading the balance.
 */
export async function lockCompanyAccount(dbtx: DrizzleTx): Promise<void> {
  await dbtx.execute(sql`SELECT pg_advisory_xact_lock(${COMPANY_ACCOUNT_LOCK_KEY})`)
}

/** SUM(amount) over `where`, parsed to a finite number (0 on NULL / NaN). */
async function sumAmount(db: Db, where: ReturnType<typeof and>): Promise<number> {
  const rows = await db
    .select({ total: sql<string>`COALESCE(SUM(${transactions.amount}), 0)` })
    .from(transactions)
    .where(where)
  const total = parseFloat(rows[0]?.total ?? '0')
  return Number.isFinite(total) ? total : 0
}

/**
 * Compute the derived company-account USDT balance from the ledger. Used by
 * BOTH the display endpoint and every balance gate (salary / expense). One
 * function → display and gate can never disagree.
 */
export async function computeCompanyAccountBalanceFromLedger(db: Db): Promise<number> {
  const [
    deposits,
    payouts,
    adminIncome,
    dividends,
    companySalaries,
    companyExpenses,
    companySeniorPayouts,
    companyDropPayouts,
  ] = await Promise.all([
    // AC5 (BIZ-23): currency='USDT' guard on EVERY term — defence-in-depth.
    sumAmount(
      db,
      and(
        eq(transactions.type, 'COMPANY_DEPOSIT'),
        eq(transactions.status, 'PAID'),
        eq(transactions.currency, 'USDT'),
      ),
    ),
    sumAmount(
      db,
      and(
        eq(transactions.type, 'PAYOUT'),
        eq(transactions.status, 'PAID'),
        eq(transactions.fundingSource, COMPANY_ACCOUNT),
        eq(transactions.currency, 'USDT'),
      ),
    ),
    sumAmount(
      db,
      and(
        eq(transactions.type, 'ADMIN_INCOME'),
        eq(transactions.status, 'PAID'),
        eq(transactions.fundingSource, COMPANY_ACCOUNT),
        eq(transactions.currency, 'USDT'),
      ),
    ),
    sumAmount(
      db,
      and(
        eq(transactions.type, 'DIVIDEND_TO_ADMIN'),
        eq(transactions.status, 'PAID'),
        eq(transactions.currency, 'USDT'),
      ),
    ),
    sumAmount(
      db,
      and(
        eq(transactions.type, 'SALARY'),
        eq(transactions.status, 'PAID'),
        eq(transactions.fundingSource, COMPANY_ACCOUNT),
        eq(transactions.currency, 'USDT'),
      ),
    ),
    sumAmount(
      db,
      and(
        eq(transactions.type, 'EXPENSE'),
        eq(transactions.status, 'PAID'),
        eq(transactions.fundingSource, COMPANY_ACCOUNT),
        eq(transactions.currency, 'USDT'),
      ),
    ),
    // task-drop-payout-company-account: company-funded senior IOU settlement
    // (settleByCompany on a COMPANY debt) debits the company account.
    sumAmount(
      db,
      and(
        eq(transactions.type, 'SENIOR_INCOME'),
        eq(transactions.status, 'PAID'),
        eq(transactions.fundingSource, COMPANY_ACCOUNT),
        eq(transactions.currency, 'USDT'),
      ),
    ),
    // task-drop-share-override-and-receiver (C7): company-funded DROP IOU
    // settlement (settleByCompany on a DROP_PENDING_PAYOUT with COMPANY_ACCOUNT
    // funding) debits the company account, exactly like the senior term above.
    // Existing drop-payout-cascade PAYOUT_DROP rows carry fundingSource=null →
    // NOT matched here (they never touched the pool). ADMIN_PERSONAL drop
    // settlements (senderId=admin, fundingSource=null) are caught by
    // adminBalances.sent in getSummary, so no ledger term is needed for them.
    sumAmount(
      db,
      and(
        eq(transactions.type, 'PAYOUT_DROP'),
        eq(transactions.status, 'PAID'),
        eq(transactions.fundingSource, COMPANY_ACCOUNT),
        eq(transactions.currency, 'USDT'),
      ),
    ),
  ])
  return (
    deposits +
    payouts +
    adminIncome -
    dividends -
    companySalaries -
    companyExpenses -
    companySeniorPayouts -
    companyDropPayouts
  )
}
