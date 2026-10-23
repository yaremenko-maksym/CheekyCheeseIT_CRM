import { HttpStatus, Injectable } from '@nestjs/common'
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import type {
  SessionUser,
  SeniorSummaryDto,
  IncomeComplianceOverviewDto,
  MySalaryStatusDto,
} from '@crm/shared'
import { MONEY_SCALE } from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import {
  pendingObligations,
  payoutRequests,
  transactions,
  users,
  visibleProjects,
} from '../database/schema'
import { NbuCurrencyService } from './nbu-currency.service'
import { convertToBase, type BalanceCurrency } from './balance.service'
import { resolveSeniorShare } from './senior-share-resolver'
import { getOwnSalaryStates } from './salary-status.helper'
import { findActiveTeamsForUser } from './active-teams.util'
import { CRON_ELIGIBLE_SALARY_ROLES } from './salary-roles.const'
import { type TxWithRelations } from './transaction-mapper.util'
import { getIncomeComplianceOverview } from './income-compliance.util'
import { computeDropAggregate, DEFAULT_SENIOR_SHARE_PERCENT } from './drop-distribution.util'

/**
 * Read-only finance summaries (admin/accountant summary, accountant KPI, senior
 * dashboard KPI, income-compliance overview). Extracted from
 * `TransactionsService` (decomposition stage T-L8): depends on the database and
 * the NBU rates ONLY and must never depend on `TransactionsService` —
 * `TransactionsService` keeps thin delegates (controllers call those) and calls
 * INTO this provider.
 */
@Injectable()
export class SummaryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly nbuCurrency: NbuCurrencyService,
  ) {}

  // ── Finance Summary (stats) ───────────────────────────────────────────────

  async getSummary(currentUser: SessionUser) {
    // RBAC: only ADMIN and ACCOUNTANT may see the full financial summary
    // (adminBalances, dropBalances, totalIncome, dropSharePercent).
    // Any other authenticated role (SENIOR / JUNIOR / HR / DROP) reaching
    // GET /api/finance/summary directly would leak payment-routing config.
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      throw apiError('FINANCE_SUMMARY_FORBIDDEN', HttpStatus.FORBIDDEN)
    }

    // task-accountant-summary-balances-rbac (security LOW, review #215): the
    // partner/drop balance arrays expose payment-routing config (partner +
    // DROP display names alongside their accumulated balances). ACCOUNTANT
    // needs the economic P&L surface (income/expenses/salaries/net + monthly)
    // for /crm/stats + the финансовый хаб, but NOT the per-drop balances —
    // those stay ADMIN-only and the ACCOUNTANT UI still hides that panel
    // (#214 removed the drop-balances panel; #215 gates it on /crm/stats to
    // ADMIN). `canSeeDropBalances` still gates on `[]` for anyone but ADMIN.
    const canSeeDropBalances = currentUser.role === 'ADMIN'

    // task-accountant-sees-admin-balances (2026-08-17, owner decision) — THIS
    // IS A DELIBERATE REVERSAL of the #214/#215 zeroing above, NOT a
    // regression. Do not "restore" `adminBalances: []` for ACCOUNTANT without
    // re-reading this comment.
    //
    // What changed: `assertCanReadAdminBalance` (balance.service.ts) already
    // lets ACCOUNTANT read ANY admin's personal balance via
    // GET /balances/admin/:id. Until PR #551, that endpoint was structurally
    // dead for this purpose — `getAdminBalance` summed ADMIN_INCOME_CASH /
    // ADMIN_INCOME_CRYPTO, transaction types nothing in prod ever creates, so
    // it always returned 0. #551's fix C-2 corrected that computation, which
    // made the contradiction live: an ACCOUNTANT can now pull a real, non-zero
    // personal balance for any admin one-by-one through that endpoint, while
    // this summary kept zeroing the SAME field (`adminBalances`) — two screens
    // disagreeing about a decision that was already made in the endpoint's
    // favor. Flagged by security-review on #551 (SEC-3).
    //
    // Owner resolution: keep the endpoint access; stop zeroing here so the
    // summary matches it. Scope is narrow — `adminBalances` (personal admin
    // balances) ONLY. `dropBalances` is a different, still-live #214/#215
    // decision (see `canSeeDropBalances` above) and is UNCHANGED.
    //
    // "Matches it" above is about ACCESS, not VALUES — do not read this as a
    // promise that the two screens show the same NUMBER. `adminBalances`
    // below computes the HOLDING model (all received across PAYOUT_ADMIN /
    // ADMIN_INCOME / ADMIN_TRANSFER / PAYOUT_CONFIRMED, minus ALL paid sends).
    // `getAdminBalance` (balance.service.ts, untouched here) computes a
    // narrower phase-4 personal-credit slice (ADMIN_INCOME_CASH/CRYPTO +
    // DIVIDEND_TO_ADMIN, minus paid EXPENSE) — PR #551 itself calls this a
    // "materially different, broader metric" than the endpoint. #551 is still
    // open as of this comment, so if this PR ships first the two figures can
    // diverge at their widest. Reconciling the two MODELS into one number is
    // a separate, not-yet-scoped decision — this task only reconciles WHO may
    // see `adminBalances`, not what it computes.
    //
    // Deliberately a bare literal, NOT `currentUser.role === 'ADMIN' ||
    // currentUser.role === 'ACCOUNTANT'`. That re-check would be an
    // equivalent-mutant magnet: the RBAC guard at the top of this method
    // already throws ForbiddenException for every role except ADMIN and
    // ACCOUNTANT, so a re-check here can never observably differ from `true`
    // — and a `// Stryker disable next-line ConditionalExpression` comment on
    // that OR expression does not target the specific `→true` mutant, it
    // suppresses EVERY ConditionalExpression mutant Stryker generates on that
    // line: the equivalent `→true` AND the three real, killed mutants
    // (`→false` on the whole expression, and `→false` on each operand) go
    // dark together (review round 2 on this task's own PR; the same
    // line×mutator suppression scope caught 8 mutants for 2 intended ones on
    // PR #531 — see the mutation-gate backlog item). Writing the guaranteed
    // value directly removes the equivalent mutant instead of hiding it: the
    // only mutant left is `true → false` (BooleanLiteral), which IS real —
    // flipping it empties `adminBalances` for actual ADMIN/ACCOUNTANT
    // callers, which the `getSummary` unit spec already asserts against — so
    // it needs no suppression at all.
    const canSeeAdminBalances = true

    // Scaled-integer constant used throughout aggregations below to avoid
    // JS float accumulation errors. Aliased to the module-level `MONEY_SCALE`
    // single source of truth so this method and `computeDropAggregate` can
    // never drift apart on the rounding scale.
    const SCALE = MONEY_SCALE

    // Audit 2026-06-28 (#4): aggregate every money figure in a single base
    // currency (USD). Rows may carry mixed currencies (USDT/USD/EUR/UAH); summing
    // their raw `amount` strings would add apples to oranges. Fetch the NBU
    // snapshot ONCE and convert each row BEFORE the scaled-integer accumulation.
    // USD ⇄ USDT is a byte-exact identity in convertToBase (peg short-circuit),
    // so the prod USDT/USD ledger totals are unchanged to the cent.
    const rates = await this.nbuCurrency.getRates()
    const toBase = (tx: { amount: string; currency: string }): number =>
      convertToBase(parseFloat(tx.amount), tx.currency as BalanceCurrency, 'USD', rates)

    // task-soft-delete-and-money-audit (AC4): the single most consequential
    // filter in this task — every totalIncome/totalExpenses/totalSalaries/
    // adminBalances/dropBalances figure below derives from `allTxs`.
    const allTxs = (await this.db.db.query.transactions.findMany({
      where: isNull(transactions.deletedAt),
      with: {
        sender: { columns: { displayName: true } },
        receiver: { columns: { displayName: true } },
        project: { columns: { name: true } },
      },
    })) as TxWithRelations[]

    const paid = allTxs.filter((tx) => tx.status === 'PAID')

    // task-drop-share-override-and-receiver (C4). A settlement SENIOR_INCOME (the
    // row settleByCompany inserts to close a senior IOU) is a slice of money whose
    // GROSS was already counted in totalIncome — as the linked DROP_INCOME (drop
    // payout) or the admin-USDT ADMIN_INCOME. Counting the settlement slice too
    // double-counts, REGARDLESS of funding: the previous fix only excluded
    // company-funded settlements, missing the ADMIN_PERSONAL case (funding=null).
    // Discriminator: a SENIOR_INCOME whose id closes a pending_obligation. Only a
    // "real" external SENIOR_INCOME (never a settlement) counts toward income.
    const closingTxRows = await this.db.db
      .select({ id: pendingObligations.closingTransactionId })
      .from(pendingObligations)
      .where(isNotNull(pendingObligations.closingTransactionId))
    const settlementTxIds = new Set(
      closingTxRows
        .map((r) => r.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    )

    // Drop role - phase 2: DROP_INCOME counts toward total income for
    // reporting purposes (gross money that came in through DROPs).
    // Scaled-integer reduce to avoid float accumulation (MED-5).
    const totalIncome =
      Math.round(
        paid
          .filter(
            (tx) =>
              tx.type === 'ADMIN_INCOME' ||
              // C4: count a SENIOR_INCOME only when it is NOT a settlement of a
              // company/admin IOU (its gross was already counted as the linked
              // DROP_INCOME / admin-USDT ADMIN_INCOME). Real external income
              // (not a closing transaction) still counts, at any funding.
              (tx.type === 'SENIOR_INCOME' && !settlementTxIds.has(tx.id)) ||
              tx.type === 'DROP_INCOME',
          )
          .reduce((sum, tx) => sum + Math.round(toBase(tx) * SCALE), 0),
      ) / SCALE

    const totalExpenses =
      Math.round(
        paid
          .filter((tx) => tx.type === 'EXPENSE')
          .reduce((sum, tx) => sum + Math.round(toBase(tx) * SCALE), 0),
      ) / SCALE

    const totalSalaries =
      Math.round(
        paid
          .filter((tx) => tx.type === 'SALARY')
          .reduce((sum, tx) => sum + Math.round(toBase(tx) * SCALE), 0),
      ) / SCALE

    // Admin balances (HOLDING model): all received − all spent.
    //   received: PAYOUT_ADMIN + ADMIN_INCOME (excl. COMPANY_ACCOUNT) +
    //             ADMIN_TRANSFER + PAYOUT_CONFIRMED (see filter below — unchanged).
    //   sent:     ALL PAID transactions where senderId = admin.id (any type:
    //             SALARY, EXPENSE, ADMIN_TRANSFER, etc.) — the full HOLDING debit.
    // Drop role - phase 3 (spec §8.4): PAYOUT_CONFIRMED — the row inserted by
    // `confirmPayout` when ACCOUNTANT/ADMIN manually confirms an off-platform
    // payout — also credits the chosen admin's balance. Phase 2 PAYOUT_ADMIN
    // (automatic 50/50 split) remains untouched and continues to count too;
    // both flows run in parallel per task scope ("Phase 2 auto-50/50 НЕ
    // ТРОГАТЬ — manual flow живёт параллельно"). Senior-only / legacy admin
    // balance values are unchanged because they never produce PAYOUT_CONFIRMED
    // rows.
    // ACCOUNTANT now sees this too (see `canSeeAdminBalances` above —
    // deliberate #214/#215 reversal, 2026-08-17). Roles that fail the RBAC
    // guard at the top of this method never reach here at all.
    //
    // No `archivedAt` filter here — EXPLICIT, not an oversight (review round
    // 2, LOW-1): `eq(users.role, 'ADMIN')` alone includes archived admins,
    // exactly as it already did before this PR for the ADMIN viewer — this
    // task widens WHO can see the array, it does not change WHAT rows are in
    // it. An archived admin can still carry a nonzero HOLDING balance the
    // company owes or holds (departure ≠ automatic zero-out/settlement), so
    // dropping the row would hide money that still needs reconciling — the
    // accountant's job. `getAdminBalance` (balance.service.ts) has no
    // archived check either, so the per-admin endpoint ACCOUNTANT already
    // used would return the same figure for an archived admin regardless.
    // If archived admins should ever be hidden from this array, that is a
    // separate, undocumented-today business decision (nothing in
    // docs/business/ addresses it) — not bundled into this task's narrow
    // scope of "who may see `adminBalances`".
    const adminBalances = !canSeeAdminBalances
      ? []
      : (
          await this.db.db.query.users.findMany({
            where: eq(users.role, 'ADMIN'),
          })
        ).map((admin) => {
          const receivedScaled = paid
            .filter(
              (tx) =>
                tx.receiverId === admin.id &&
                (tx.type === 'PAYOUT_ADMIN' ||
                  // task-salary-company-account: ADMIN_INCOME routed to the
                  // company account (fundingSource='COMPANY_ACCOUNT') went into
                  // the shared pool, NOT the admin's personal balance — exclude
                  // it here. Legacy/admin-personal ADMIN_INCOME (NULL funding)
                  // still credits the admin as before.
                  (tx.type === 'ADMIN_INCOME' && tx.fundingSource !== 'COMPANY_ACCOUNT') ||
                  tx.type === 'ADMIN_TRANSFER' ||
                  tx.type === 'PAYOUT_CONFIRMED'),
            )
            // Audit 2026-06-28 (#4): convert to base before scaling (mixed-currency
            // safe). USD/USDT → identity, so prod balances stay byte-exact.
            .reduce((sum, tx) => sum + Math.round(toBase(tx) * SCALE), 0)
          // HOLDING model: debit = ALL paid transactions sent by this admin
          // (SALARY, EXPENSE, ADMIN_TRANSFER, etc.), not only ADMIN_TRANSFER.
          const sentScaled = paid
            .filter((tx) => tx.senderId === admin.id)
            .reduce((sum, tx) => sum + Math.round(toBase(tx) * SCALE), 0)
          return {
            userId: admin.id,
            displayName: admin.displayName,
            balance: (receivedScaled - sentScaled) / SCALE,
          }
        })

    // Drop role - phase 2 (AC4): aggregate balance per DROP user — credit on
    // PAYOUT_DROP (their slice of drop-project distribution) minus any debit
    // (none today; field kept here for symmetry with adminBalances). Empty
    // array when no DROP users exist. The shape is intentionally identical
    // to adminBalances so the frontend can render both side-by-side.
    //
    // Drop role - phase 1 (task-drop-1-backend): per-drop aggregate flows
    // through the shared `computeDropAggregate` helper (single source of truth
    // also consumed by the self-only `getDropSelfSummary`). The admin summary
    // DTO is unchanged — `debtToCompany` (returned by the helper) is mapped
    // away here so `financeSummarySchema.dropBalances` and its existing unit
    // tests stay byte-for-byte identical.
    //
    // ACCOUNTANT still gets `[]` here (see `canSeeDropBalances` above — this
    // half of #214/#215 is UNCHANGED by the adminBalances reversal); ADMIN
    // keeps the full list.
    const dropBalances = !canSeeDropBalances
      ? []
      : (
          await this.db.db.query.users.findMany({
            where: eq(users.role, 'DROP'),
          })
        ).map((drop) => {
          const aggregate = computeDropAggregate(
            { id: drop.id, displayName: drop.displayName, dropSharePercent: drop.dropSharePercent },
            allTxs,
            rates,
          )
          return {
            userId: aggregate.userId,
            displayName: aggregate.displayName,
            balance: aggregate.balance,
            dropSharePercent: aggregate.dropSharePercent,
            pendingCount: aggregate.pendingCount,
          }
        })

    // Monthly breakdown — scaled-integer accumulation (MED-5).
    const monthMap = new Map<
      string,
      { incomeScaled: number; expensesScaled: number; salariesScaled: number }
    >()

    for (const tx of paid) {
      // Audit 2026-06-28 (#9): bucket by the business date (txDate) when present,
      // falling back to createdAt. Aligns with getIncomeComplianceOverview. Prod
      // data has txDate == createdAt so the existing totals / graph are unchanged.
      const when = tx.txDate ?? tx.createdAt
      const month = when.toISOString().slice(0, 7) // YYYY-MM
      if (!monthMap.has(month))
        monthMap.set(month, { incomeScaled: 0, expensesScaled: 0, salariesScaled: 0 })
      const entry = monthMap.get(month)!
      // Audit 2026-06-28 (#4): convert to base before scaling (mixed-currency safe).
      const amtScaled = Math.round(toBase(tx) * SCALE)

      if (
        tx.type === 'ADMIN_INCOME' ||
        // task-drop-share-override-and-receiver (C4): exclude settlement
        // SENIOR_INCOME (closing an IOU) from the monthly income series too —
        // same closing-tx discriminator as totalIncome above (regardless of
        // funding, so ADMIN_PERSONAL settlements are excluded as well).
        (tx.type === 'SENIOR_INCOME' && !settlementTxIds.has(tx.id)) ||
        tx.type === 'DROP_INCOME'
      ) {
        entry.incomeScaled += amtScaled
      } else if (tx.type === 'EXPENSE') entry.expensesScaled += amtScaled
      else if (tx.type === 'SALARY') entry.salariesScaled += amtScaled
    }

    const monthly = Array.from(monthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([month, v]) => {
        const income = v.incomeScaled / SCALE
        const expenses = v.expensesScaled / SCALE
        const salaries = v.salariesScaled / SCALE
        return {
          month,
          income,
          expenses,
          salaries,
          profit: (v.incomeScaled - v.expensesScaled - v.salariesScaled) / SCALE,
        }
      })

    return {
      totalIncome,
      totalExpenses,
      totalSalaries,
      netBalance: totalIncome - totalExpenses - totalSalaries,
      adminBalances,
      dropBalances,
      monthly,
    }
  }

  /**
   * Accountant KPI snapshot for the финансовый хаб (Sprint 2).
   *
   * RBAC: ACCOUNTANT + ADMIN only. Every other role (SENIOR / JUNIOR / HR /
   * DROP) reaching GET /api/finance/accountant-summary directly would leak
   * company-wide payment-validation figures → ForbiddenException. Mirrors the
   * guard in `getSummary` above (single, explicit role check) and is thrown
   * BEFORE any DB access.
   *
   * Implementation: loads all transaction rows via `findMany()` and aggregates
   * the KPI buckets in-process using a single scan. UTC-based month boundaries
   * are computed once from `new Date()` so every bucket uses the same cutoff.
   *
   * KPI semantics:
   *   - pendingValidation  — income rows (SENIOR_INCOME + DROP_INCOME) still in
   *                          PENDING status, i.e. awaiting accountant action.
   *   - validatedThisMonth — rows the accountant VALIDATED in the current
   *                          calendar month (by `validatedAt`, NOT NULL).
   *   - paidThisMonth      — income/payout money settled (status PAID) whose
   *                          `createdAt` falls in the current month.
   *   - recipientCount     — distinct income parties (seniors / drops) the
   *                          accountant oversees.
   *
   * Money: `amount` is numeric(18,6); `COALESCE(SUM(amount), 0)` yields an exact
   * decimal string on the empty set → 0, mapped to a JS number with `Number`
   * (matching the previous float accumulation to the column's 6-decimal scale).
   */
  async getAccountantSummary(currentUser: SessionUser): Promise<{
    pendingValidation: { count: number; amount: number }
    validatedThisMonth: { count: number; amount: number }
    paidThisMonth: { amount: number }
    recipientCount: number
  }> {
    if (currentUser.role !== 'ACCOUNTANT' && currentUser.role !== 'ADMIN') {
      throw apiError('FINANCE_ACCOUNTANT_SUMMARY_FORBIDDEN', HttpStatus.FORBIDDEN)
    }

    // Current-month boundary, computed once. UTC-based to match how the rest of
    // the summary buckets months (`createdAt.toISOString().slice(0,7)`).
    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

    // Income types a senior / drop submits that require accountant validation —
    // the validatable-income predicate (pendingValidation + recipientCount).
    const incomeTypes = sql`${transactions.type} in ('SENIOR_INCOME', 'DROP_INCOME')`

    // Income/payout money types eligible for paidThisMonth.
    const paidEligibleTypes = sql`${transactions.type} in ('SENIOR_INCOME', 'DROP_INCOME', 'PAYOUT', 'PAYOUT_ADMIN', 'PAYOUT_DROP', 'PAYOUT_CONFIRMED')`

    // Single aggregating pass — conditional COUNT/SUM via FILTER (WHERE ...)
    // plus a distinct-party count. `COALESCE(SUM(...), 0)` guarantees 0 (not
    // NULL) on the empty set; numeric sums arrive as decimal strings → Number.
    const [row] = await this.db.db
      .select({
        pendingCount:
          sql<number>`count(*) filter (where ${transactions.status} = 'PENDING' and ${incomeTypes})`.mapWith(
            Number,
          ),
        pendingAmount:
          sql<number>`coalesce(sum(${transactions.amount}) filter (where ${transactions.status} = 'PENDING' and ${incomeTypes}), 0)`.mapWith(
            Number,
          ),
        validatedCount:
          sql<number>`count(*) filter (where ${transactions.status} = 'VALIDATED' and ${transactions.validatedAt} is not null and ${transactions.validatedAt} >= ${monthStart})`.mapWith(
            Number,
          ),
        validatedAmount:
          sql<number>`coalesce(sum(${transactions.amount}) filter (where ${transactions.status} = 'VALIDATED' and ${transactions.validatedAt} is not null and ${transactions.validatedAt} >= ${monthStart}), 0)`.mapWith(
            Number,
          ),
        paidAmount:
          sql<number>`coalesce(sum(${transactions.amount}) filter (where ${transactions.status} = 'PAID' and ${paidEligibleTypes} and ${transactions.createdAt} >= ${monthStart}), 0)`.mapWith(
            Number,
          ),
        recipientCount:
          sql<number>`count(distinct coalesce(${transactions.receiverId}, ${transactions.senderId})) filter (where ${incomeTypes})`.mapWith(
            Number,
          ),
      })
      .from(transactions)
      // task-soft-delete-and-money-audit (AC4): scope the WHOLE aggregating
      // scan to non-deleted rows — every FILTER (WHERE ...) clause above runs
      // against this, so one WHERE here covers all five KPI buckets at once.
      .where(isNull(transactions.deletedAt))

    return {
      pendingValidation: {
        count: row?.pendingCount ?? 0,
        amount: row?.pendingAmount ?? 0,
      },
      validatedThisMonth: {
        count: row?.validatedCount ?? 0,
        amount: row?.validatedAmount ?? 0,
      },
      paidThisMonth: {
        amount: row?.paidAmount ?? 0,
      },
      recipientCount: row?.recipientCount ?? 0,
    }
  }

  /**
   * SENIOR dashboard KPI snapshot — STRICTLY self-scoped to `currentUser.id`.
   *
   * RBAC: SENIOR + ADMIN only (every other role → 403). The figures are ALWAYS
   * scoped to the caller's own id; there is NO `targetUserId` parameter, so a
   * senior can never request another senior's projects / income / payouts. ADMIN
   * gets access for debugging but sees their OWN id's figures (an admin owns
   * projects via `seniorId === adminId`), never an arbitrary senior's — closing
   * the data-leak surface that a `:userId` param would open.
   *
   * Content (USER selection — only this):
   *   1. activeProjects    — own active senior-projects + effective share %.
   *   2. seniorShareIncome — own senior SHARE of PAID SENIOR_INCOME (total +
   *                          this month), share = amount * sharePercent/100.
   *   3. pendingPayouts    — own PENDING payout_requests (count + Σ payable).
   *   4. mySalaryStatus    — own current-month SALARY tx (or null).
   *
   * Amounts are summed in the transaction's stored currency without cross-rate
   * conversion — consistent with getAccountantSummary / HR mySalaryStatus which
   * also report raw `amount`; the wire `currency` is the USD display label.
   */
  async getSeniorSummary(currentUser: SessionUser): Promise<SeniorSummaryDto> {
    if (currentUser.role !== 'SENIOR' && currentUser.role !== 'ADMIN') {
      throw apiError('FINANCE_SENIOR_SUMMARY_FORBIDDEN', HttpStatus.FORBIDDEN)
    }

    const selfId = currentUser.id

    // Current-month boundary (UTC), computed once — matches HR / accountant.
    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    // task-senior-stats-block: PREVIOUS-month window [lastMonthStart, monthStart)
    // for `lastMonthIncome`. The current-month `YYYY-MM` key (salaryMonth) is also
    // reused as the per-company arrival bucket so the progress bar and the salary
    // lookup share one definition of "this month".
    const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    // PR #868: half-open [monthStart, nextMonthStart) — a future-dated income
    // (txDate is user-chosen) must not leak into "this month".
    const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    const salaryMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`

    // ── 1. Active own senior-projects + effective share % ──────────────────────
    // Self-scope at the DB level: only projects where seniorId === self AND not
    // archived. No other senior's project can ever surface here.
    // task-project-draft-status: sourced from `visibleProjects` — a DRAFT or
    // REJECTED project of the senior's own must not show as "active" here
    // either (it never accrued income and never will until confirmed).
    // Views are not registered in Drizzle's relational-query schema config
    // (same reason `nonDeletedTransactions` reads use explicit
    // select/join elsewhere in this file), so `db.query.projects.findMany`
    // is replaced with an explicit select + orderBy.
    const ownProjects = await this.db.db
      .select()
      .from(visibleProjects)
      .where(eq(visibleProjects.seniorId, selfId))
      .orderBy(desc(visibleProjects.createdAt))

    // Effective share resolution reuses the canonical resolver
    // (project override → single active team override → user default). One
    // team-membership lookup serves every project (the senior's team set is the
    // same regardless of the project).
    const selfUser = await this.db.db.query.users.findFirst({ where: eq(users.id, selfId) })
    const applicableTeams = await findActiveTeamsForUser(this.db.db, selfId)
    const seniorSharePercent =
      selfUser?.seniorSharePercent ?? currentUser.seniorSharePercent ?? DEFAULT_SENIOR_SHARE_PERCENT

    const activeProjectItems = ownProjects.map((p) => {
      const resolved = resolveSeniorShare(
        { seniorSharePercentOverride: p.seniorSharePercentOverride },
        { seniorSharePercent },
        applicableTeams,
      )
      return {
        id: p.id,
        name: p.name,
        companyName: p.companyName,
        sharePercent: resolved.value,
      }
    })

    // ── 2. Senior SHARE of PAID SENIOR_INCOME (total + this month) ─────────────
    // Only PAID SENIOR_INCOME credited to self counts (same gate as
    // getTotalEarned SENIOR branch). The senior's NET share uses the snapshot
    // `seniorSharePercent` written at income-creation time (authoritative
    // historical value, NOT recomputed). A null snapshot falls back to the
    // user-level default so legacy rows still contribute.
    const paidIncomeRows = await this.db.db.query.transactions.findMany({
      where: and(
        eq(transactions.type, 'SENIOR_INCOME'),
        eq(transactions.status, 'PAID'),
        eq(transactions.receiverId, selfId),
        // task-soft-delete-and-money-audit (AC4): a deleted income row must
        // not inflate the senior's own «Статистика заработка» KPIs.
        isNull(transactions.deletedAt),
      ),
    })

    // task-senior-stats-block: derive the «Статистика заработка» figures from the
    // SAME `paidIncomeRows` (no extra query, no duplicated gate). One pass tallies:
    //   - incomeTotal / incomeThisMonth (existing KPI),
    //   - incomeLastMonth (previous calendar month),
    //   - perMonthShare (YYYY-MM → Σ share) for the sparkline history,
    //   - companiesWithIncomeThisMonth (set of own projectIds that got ≥1 PAID
    //     SENIOR_INCOME dated this month) for the arrival-progress bar.
    const monthKeyOf = (d: Date): string =>
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    let incomeTotal = 0
    let incomeThisMonth = 0
    let incomeLastMonth = 0
    const perMonthShare = new Map<string, number>()
    const companiesWithIncomeThisMonth = new Set<string | null>()
    for (const tx of paidIncomeRows) {
      const amt = parseFloat(tx.amount)
      if (!Number.isFinite(amt)) continue
      const pct = tx.seniorSharePercent ?? seniorSharePercent
      const share = amt * (pct / 100)
      incomeTotal += share
      const when = tx.txDate ?? tx.createdAt
      // `when` is never null: `createdAt` is NOT NULL, so `txDate ?? createdAt` always resolves.
      const whenDate = new Date(when)
      // Per-month bucket for the sparkline (keyed by the income's own date).
      const key = monthKeyOf(whenDate)
      perMonthShare.set(key, (perMonthShare.get(key) ?? 0) + share)
      if (whenDate >= lastMonthStart && whenDate < monthStart) {
        incomeLastMonth += share
      }
      if (whenDate >= monthStart && whenDate < nextMonthStart) {
        incomeThisMonth += share
        // A project counts toward arrival-progress as soon as ONE of its incomes
        // lands this month. Self-scoped: receiverId is already === self.
        // A null project id lands as `null` in the set; the intersection below only
        // probes real active-project ids, so it never matches.
        companiesWithIncomeThisMonth.add(tx.projectId)
      }
    }

    // ── 2a. «Статистика заработка» — sparkline history + arrival progress ───────
    // monthlyHistory: a contiguous run of the LAST `HISTORY_MONTHS` calendar
    // months (oldest → newest), each carrying its summed share (0 when no income
    // that month) so the sparkline keeps a fixed length and gap-free x-axis.
    const HISTORY_MONTHS = 8
    const monthlyHistory: Array<{ month: string; amount: number }> = []
    for (let i = HISTORY_MONTHS - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
      const key = monthKeyOf(d)
      monthlyHistory.push({ month: key, amount: perMonthShare.get(key) ?? 0 })
    }

    // companyIncomeProgress: total = active own projects; received = those that
    // already have ≥1 PAID SENIOR_INCOME dated this month. received ≤ total
    // because the set only contains ids drawn from this senior's own incomes,
    // intersected with the active-project id set (guards against income on a now-
    // archived project inflating `received` past `total`).
    const ownActiveProjectIds = new Set(ownProjects.map((p) => p.id))
    let companyIncomeReceived = 0
    for (const projectId of ownActiveProjectIds) {
      if (companiesWithIncomeThisMonth.has(projectId)) companyIncomeReceived += 1
    }

    // ── 3. PENDING payout_requests owed/queued by self ─────────────────────────
    // Self-scoped: payout_requests.seniorId === self. amount = Σ payableAmount of
    // the PENDING rows (what the senior still has to settle).
    const pendingRows = await this.db.db.query.payoutRequests.findMany({
      where: and(eq(payoutRequests.seniorId, selfId), eq(payoutRequests.status, 'PENDING')),
    })
    const pendingAmount = pendingRows.reduce((sum, r) => {
      const v = parseFloat(r.payableAmount)
      return Number.isFinite(v) ? sum + v : sum
    }, 0)

    // ── 4. Own current-month salary status (same shape as HR dashboard) ────────
    // task-salary-month-gap-and-status (E-6): `hasMonthlySalary` mirrors the
    // cron's own `if (!emp.monthlySalary) continue` truthiness check.
    // `isCronEligibleRole` is the SAME "does the cron process this role at
    // all" question the E-5 gap report answers (only HR/ACCOUNTANT/JUNIOR are
    // ever targeted by `createMonthlySalaries`) — security-review MED-3:
    // `getSeniorSummary` is reached ONLY by SENIOR/ADMIN (the RBAC gate
    // above), and the cron never processes either, so this is always `false`
    // here; written as a real role check (not hardcoded `false`) so the
    // shared helper stays correct if a future HR-summary re-add calls it for
    // a cron-eligible role.
    const salaryStates = await getOwnSalaryStates(this.db.db, selfId, salaryMonth, {
      hasMonthlySalary: Boolean(selfUser?.monthlySalary),
      isCronEligibleRole: CRON_ELIGIBLE_SALARY_ROLES.has(currentUser.role),
    })
    const mySalaryState = salaryStates.legacy
    const mySalaryAggregateState = salaryStates.aggregate
    // DEPRECATED field — see the module comment on `mySalaryStatusSchema` in
    // @crm/shared (security-review MED-3): derived from `mySalaryState` so
    // there is exactly ONE computation, not two that could drift.
    const mySalaryStatus: MySalaryStatusDto =
      mySalaryState.state === 'EXISTS'
        ? {
            amount: mySalaryState.amount,
            currency: mySalaryState.currency,
            status: mySalaryState.status,
          }
        : null

    return {
      activeProjects: {
        count: activeProjectItems.length,
        items: activeProjectItems,
      },
      seniorShareIncome: {
        total: incomeTotal,
        thisMonth: incomeThisMonth,
        currency: 'USD',
      },
      pendingPayouts: {
        count: pendingRows.length,
        amount: pendingAmount,
      },
      mySalaryStatus,
      mySalaryState,
      mySalaryAggregateState,
      // task-senior-stats-block — «Статистика заработка». No money "expected"
      // figure (USER): only the per-company arrival PROGRESS for this month.
      earningsStats: {
        lastMonthIncome: incomeLastMonth,
        monthlyHistory,
        companyIncomeProgress: {
          received: companyIncomeReceived,
          total: ownProjects.length,
        },
      },
    }
  }

  /**
   * Income compliance overview — «Контроль приходов». ADMIN + ACCOUNTANT only;
   * logic and full contract live in `income-compliance.util.ts`.
   */
  async getIncomeComplianceOverview(
    currentUser: SessionUser,
    month?: string,
  ): Promise<IncomeComplianceOverviewDto> {
    return getIncomeComplianceOverview(this.db, currentUser, month)
  }
}
