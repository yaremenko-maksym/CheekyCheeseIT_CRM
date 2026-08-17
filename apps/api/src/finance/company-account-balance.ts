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
 *
 * SEC-1 (mega-audit wave 2, round 2/3) — this module exports TWO ways to read
 * the balance, deliberately different on failure:
 *   - `computeCompanyAccountBalanceFromLedger` — throws on a detected
 *     off-currency company row (`CompanyAccountOffCurrencyError`, see C-3
 *     below). Used by the four money-moving GATES (`createExpense`,
 *     `paySalary`, `settleByCompany`, `createDividend`) — refusing to move
 *     money against an unreliable balance is correct.
 *   - `computeCompanyAccountBalanceForDisplay` — never throws on that SAME
 *     condition; degrades to a best-effort `balance` + `{ reliable: false,
 *     offCurrencyCount }` instead, for the read-only diagnostic screen
 *     (`CompanyAccountService.computeBalance`, wired in round 3). See its own
 *     docstring for the full rationale, including why `balance` stays a
 *     plain `number` rather than `null` (the shared `CompanyAccountDto`
 *     schema is out of this task's zone).
 */
import { Logger } from '@nestjs/common'
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm'
import type { DatabaseService } from '../database/database.service'
import type { DrizzleTx } from '../database/types'
// security-review PR #456 round 2: reads the `nonDeletedTransactions` VIEW,
// not the raw `transactions` table — see schema.ts's doc on the view for why
// (eliminate the "forgot the deletedAt filter" class, don't rely on a scanner
// to detect it). This module never needs to see a deleted row (a company
// balance has no "ADMIN sees it anyway" concept), so the view covers 100% of
// its reads.
import { nonDeletedTransactions } from '../database/schema'

/**
 * Either the base pool handle (`DatabaseService['db']`) or a transaction handle
 * (`DrizzleTx`) opened by `db.transaction(...)`. The balance is read through the
 * SAME query surface from both; the gate paths pass the `DrizzleTx` so the read
 * runs INSIDE the advisory-locked transaction and sees the consistent view.
 */
type Db = DatabaseService['db'] | DrizzleTx

/**
 * SEC-1 (mega-audit wave 2, review round 2) — this module has no NestJS DI
 * context (it is a plain free-function module, deliberately — see the top
 * docstring), so a standalone `Logger` instance (not `new Logger(Class.name)`
 * inside a service) is the closest fit to the per-class pattern every other
 * file in this directory uses.
 */
const logger = new Logger('company-account-balance')

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

/**
 * SUM(amount) over `where`, parsed to a finite number (0 on NULL / NaN).
 *
 * security-review PR #456 round 2: sources from `nonDeletedTransactions` (a
 * VIEW pre-filtered to `deleted_at IS NULL`) instead of ANDing the condition
 * in by hand — a soft-deleted row cannot appear in this SUM no matter what
 * `where` a future caller passes, because there is no code path that could
 * omit the filter (it is not a condition here, it is the FROM target).
 */
async function sumAmount(db: Db, where: ReturnType<typeof and>): Promise<number> {
  const rows = await db
    .select({ total: sql<string>`COALESCE(SUM(${nonDeletedTransactions.amount}), 0)` })
    .from(nonDeletedTransactions)
    .where(where)
  const total = parseFloat(rows[0]?.total ?? '0')
  return Number.isFinite(total) ? total : 0
}

/**
 * C-3 (mega-audit wave 2, AC7/AC8) — the two "company-shaped" types that carry
 * no `fundingSource` gate: a row of one of these types is company money by
 * TYPE ALONE (a company deposit, a dividend paid FROM the company).
 */
const COMPANY_TERM_TYPES_UNGATED = ['COMPANY_DEPOSIT', 'DIVIDEND_TO_ADMIN'] as const

/**
 * The remaining six terms are company money only when ALSO stamped
 * `fundingSource='COMPANY_ACCOUNT'` — mirrors the 8-term SUM below exactly
 * (same type list, same funding-source gate).
 */
const COMPANY_TERM_TYPES_FUNDING_GATED = [
  'PAYOUT',
  'ADMIN_INCOME',
  'SALARY',
  'EXPENSE',
  'SENIOR_INCOME',
  'PAYOUT_DROP',
] as const

/**
 * C-3 (mega-audit wave 2): every SUM term below already carries a
 * `currency='USDT'` guard (AC5/BIZ-23, defence-in-depth on the NUMBER). Its
 * blind spot: a company-shaped row (any of the twelve type/funding
 * combinations above) booked in a currency OTHER than USDT is simply
 * EXCLUDED from every SUM — the balance silently omits money the ledger says
 * belongs to the company, with no error and no log. There is no DB
 * constraint tying "this row is company money" to `currency='USDT'` (a
 * CHECK constraint achieving that is proposed in the PR description — NOT
 * applied here; prod DDL only lands through `deploy.yml`, by the owner's
 * decision).
 *
 * Until that constraint exists, `computeCompanyAccountBalanceFromLedger`
 * refuses to hand back a balance it knows might be silently wrong: it checks
 * for any such off-currency row and throws loudly instead. Every write path
 * that creates one of these rows hardcodes 'USDT' today (`submitDeposit`,
 * `createDividend` — see the C-3 audit finding), so in the CURRENT data this
 * can never fire; it is a trap for a FUTURE write path that forgets to, not
 * a live bug.
 *
 * SEC-1 (review round 2): a typed subclass, not a bare `Error` — so a caller
 * can distinguish "the off-currency guard tripped" (a KNOWN, count-only
 * condition — safe to degrade gracefully on a read-only path) from any OTHER
 * failure reading this ledger (a DB outage, a query bug — which must NOT be
 * silently swallowed anywhere, including the display path). See
 * `computeCompanyAccountBalanceForDisplay` below.
 */
export class CompanyAccountOffCurrencyError extends Error {
  constructor(readonly count: number) {
    super(
      `computeCompanyAccountBalanceFromLedger: found ${count} PAID company-account ` +
        `row(s) booked in a currency other than USDT. The company account is ` +
        `USDT-only — these rows would silently drop out of the balance instead of ` +
        `being counted or rejected. Fix the offending row(s) (wrong currency label) ` +
        `before trusting this balance.`,
    )
    this.name = 'CompanyAccountOffCurrencyError'
  }
}

async function assertNoOffCurrencyCompanyRows(db: Db): Promise<void> {
  const rows = await db
    .select({ total: sql<string>`COUNT(*)` })
    .from(nonDeletedTransactions)
    .where(
      and(
        eq(nonDeletedTransactions.status, 'PAID'),
        ne(nonDeletedTransactions.currency, 'USDT'),
        or(
          inArray(nonDeletedTransactions.type, COMPANY_TERM_TYPES_UNGATED),
          and(
            inArray(nonDeletedTransactions.type, COMPANY_TERM_TYPES_FUNDING_GATED),
            eq(nonDeletedTransactions.fundingSource, COMPANY_ACCOUNT),
          ),
        ),
      ),
    )
  // Stryker disable next-line StringLiteral: equivalent mutant — this default
  // ('0' vs '') is consumed ONLY by the `count > 0` gate two lines below.
  // parseInt('0',10)=0 and parseInt('',10)=NaN both fail `>0`, so a missing
  // row row[0] produces the SAME observable outcome (no throw) either way;
  // no assertion on this fallback's exact string value can ever be written.
  const count = parseInt(rows[0]?.total ?? '0', 10)
  if (count > 0) {
    throw new CompanyAccountOffCurrencyError(count)
  }
}

/**
 * The 8-term ledger SUM, WITHOUT the off-currency guard — extracted so
 * `computeCompanyAccountBalanceForDisplay` can compute the SAME best-effort
 * figure the guard would otherwise block, for its degraded return (see that
 * function's docstring for why a best-effort NUMBER, not `null`, is what the
 * display path needs). Never exported: every external caller goes through
 * either `computeCompanyAccountBalanceFromLedger` (guarded) or
 * `computeCompanyAccountBalanceForDisplay` (guarded-with-fallback) — nobody
 * should read an un-guarded balance without EITHER trusting it (the former)
 * or knowing explicitly that it might not be trustworthy (the latter).
 */
async function sumLedgerTerms(db: Db): Promise<number> {
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
        eq(nonDeletedTransactions.type, 'COMPANY_DEPOSIT'),
        eq(nonDeletedTransactions.status, 'PAID'),
        eq(nonDeletedTransactions.currency, 'USDT'),
      ),
    ),
    sumAmount(
      db,
      and(
        eq(nonDeletedTransactions.type, 'PAYOUT'),
        eq(nonDeletedTransactions.status, 'PAID'),
        eq(nonDeletedTransactions.fundingSource, COMPANY_ACCOUNT),
        eq(nonDeletedTransactions.currency, 'USDT'),
      ),
    ),
    sumAmount(
      db,
      and(
        eq(nonDeletedTransactions.type, 'ADMIN_INCOME'),
        eq(nonDeletedTransactions.status, 'PAID'),
        eq(nonDeletedTransactions.fundingSource, COMPANY_ACCOUNT),
        eq(nonDeletedTransactions.currency, 'USDT'),
      ),
    ),
    sumAmount(
      db,
      and(
        eq(nonDeletedTransactions.type, 'DIVIDEND_TO_ADMIN'),
        eq(nonDeletedTransactions.status, 'PAID'),
        eq(nonDeletedTransactions.currency, 'USDT'),
      ),
    ),
    sumAmount(
      db,
      and(
        eq(nonDeletedTransactions.type, 'SALARY'),
        eq(nonDeletedTransactions.status, 'PAID'),
        eq(nonDeletedTransactions.fundingSource, COMPANY_ACCOUNT),
        eq(nonDeletedTransactions.currency, 'USDT'),
      ),
    ),
    sumAmount(
      db,
      and(
        eq(nonDeletedTransactions.type, 'EXPENSE'),
        eq(nonDeletedTransactions.status, 'PAID'),
        eq(nonDeletedTransactions.fundingSource, COMPANY_ACCOUNT),
        eq(nonDeletedTransactions.currency, 'USDT'),
      ),
    ),
    // task-drop-payout-company-account: company-funded senior IOU settlement
    // (settleByCompany on a COMPANY debt) debits the company account.
    sumAmount(
      db,
      and(
        eq(nonDeletedTransactions.type, 'SENIOR_INCOME'),
        eq(nonDeletedTransactions.status, 'PAID'),
        eq(nonDeletedTransactions.fundingSource, COMPANY_ACCOUNT),
        eq(nonDeletedTransactions.currency, 'USDT'),
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
        eq(nonDeletedTransactions.type, 'PAYOUT_DROP'),
        eq(nonDeletedTransactions.status, 'PAID'),
        eq(nonDeletedTransactions.fundingSource, COMPANY_ACCOUNT),
        eq(nonDeletedTransactions.currency, 'USDT'),
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

/**
 * Compute the derived company-account USDT balance from the ledger. Used by
 * the four money-moving GATES (`createExpense`, `paySalary`,
 * `settleByCompany`, `createDividend`) — see `computeCompanyAccountBalanceForDisplay`
 * below for the read-only diagnostic-screen variant. One shared formula
 * (`sumLedgerTerms`) → the two can never disagree on the NUMBER, only on
 * what happens when the off-currency guard trips.
 */
export async function computeCompanyAccountBalanceFromLedger(db: Db): Promise<number> {
  // C-3 (AC7/AC8): the 8-term SUM (`sumLedgerTerms`) runs FIRST, exactly as
  // before this function was split out — the guard is still a 9th query run
  // AFTER it, so the existing 8 SUMs (and their call order, pinned by
  // company-account-balance-currency.spec.ts) are completely untouched.
  const total = await sumLedgerTerms(db)
  await assertNoOffCurrencyCompanyRows(db)
  return total
}

/** Result shape for `computeCompanyAccountBalanceForDisplay` — see its docstring. */
export interface CompanyAccountBalanceReading {
  /**
   * ALWAYS a number — round 3 (SEC-1 wiring): `CompanyAccountDto.balance` is
   * `z.number()` in the shared schema (packages/shared/src/schemas/finance.ts,
   * out of this task's zone — a parallel session owns it, PR #543), so the
   * display caller has no `null`/flag slot to put an "unreliable" signal in
   * without a cross-team schema change. When `reliable === false` this is the
   * BEST-EFFORT figure — `sumLedgerTerms` run WITHOUT the guard, i.e. exactly
   * the number this endpoint would have silently shown before the C-3 fix
   * existed at all. That is a deliberate choice: it does not introduce any
   * NEW form of wrongness beyond the pre-C3 status quo, and pairs it with the
   * loud server-side log below — before C-3, ops had zero signal; now they
   * have one, even though the client-visible number is unchanged. A `reliable`
   * flag surfaced to the client (so the number itself could be replaced by an
   * explicit "unknown") is a real improvement — tracked separately, requires
   * the shared-schema change this task must not make.
   */
  balance: number
  reliable: boolean
  /** Count of PAID company-account rows in a non-USDT currency, 0 when `reliable`. */
  offCurrencyCount: number
}

/**
 * SEC-1 (mega-audit wave 2, review round 2/3) — display-safe variant of
 * `computeCompanyAccountBalanceFromLedger`, for the read-only diagnostic
 * screen (`GET /api/company-account`, the balance KPI on `/stats` and
 * `/admin/wallet` — wired in round 3, `CompanyAccountService.computeBalance`).
 *
 * `computeCompanyAccountBalanceFromLedger` is shared by SIX non-spec callers:
 * that one display endpoint AND four money-moving gates (`createExpense`,
 * `paySalary`, `settleByCompany`, `createDividend`). Before this split, ONE
 * off-currency row tripped the SAME throw on all six — including the exact
 * screen an operator would open to diagnose the incident, taking down the
 * only tool that could show them anything. The policy split (owner-approved,
 * mega-audit wave 2 round 2):
 *
 *   - The FOUR GATES keep calling `computeCompanyAccountBalanceFromLedger`
 *     directly (UNCHANGED — this function does not touch that path at all).
 *     Moving money against a balance you know might be wrong is worse than
 *     refusing outright; fail-closed is correct there.
 *   - The DISPLAY path calls THIS function instead. It never throws on the
 *     known off-currency condition: it logs the full detail SERVER-SIDE
 *     (safe — this never crosses the HTTP boundary) and returns a
 *     best-effort `balance` + `{ reliable: false, offCurrencyCount: N }` so
 *     the screen can stay alive rather than a blank 500. Any OTHER error (DB
 *     connectivity, a query bug) is NOT swallowed here — it propagates,
 *     because a genuine read failure is a different, correctly-loud case
 *     from "the read succeeded and found a data-integrity problem".
 *   - Only a COUNT ever leaves this function on the degraded path — no sums,
 *     no row ids, no counterparty names (SEC-2 requirement: if this ever
 *     becomes an `HttpException` surfaced to the client, it must stay
 *     count-only for that same reason).
 */
export async function computeCompanyAccountBalanceForDisplay(
  db: Db,
): Promise<CompanyAccountBalanceReading> {
  try {
    const balance = await computeCompanyAccountBalanceFromLedger(db)
    return { balance, reliable: true, offCurrencyCount: 0 }
  } catch (err) {
    if (err instanceof CompanyAccountOffCurrencyError) {
      logger.error(`company-account balance display degraded — ${err.message}`, err.stack)
      const bestEffortBalance = await sumLedgerTerms(db)
      return { balance: bestEffortBalance, reliable: false, offCurrencyCount: err.count }
    }
    throw err
  }
}
