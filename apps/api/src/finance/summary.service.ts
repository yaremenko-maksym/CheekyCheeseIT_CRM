import { HttpStatus, Injectable } from '@nestjs/common'
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import type {
  SessionUser,
  SeniorSummaryDto,
  IncomeComplianceOverviewDto,
  MySalaryStatusDto,
} from '@crm/shared'
import { MONEY_SCALE, addCalendarMonths, kyivDayOf } from '@crm/shared'
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
import { transactionBusinessMonth } from './transaction-date.util'
import { getOwnSalaryStates } from './salary-status.helper'
import { findActiveTeamsForUser } from './active-teams.util'
import { CRON_ELIGIBLE_SALARY_ROLES } from './salary-roles.const'
import { type TxWithRelations } from './transaction-mapper.util'
import { getIncomeComplianceOverview } from './income-compliance.util'
import { computeDropAggregate, DEFAULT_SENIOR_SHARE_PERCENT } from './drop-distribution.util'

/**
 * Read-only finance summaries (admin summary, senior
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
    // RBAC: only ADMIN may see the full financial summary
    // (adminBalances, dropBalances, totalIncome, dropSharePercent).
    // Any other authenticated role (SENIOR / JUNIOR / HR / DROP) reaching
    // GET /api/finance/summary directly would leak payment-routing config.
    if (currentUser.role !== 'ADMIN') {
      throw apiError('FINANCE_SUMMARY_FORBIDDEN', HttpStatus.FORBIDDEN)
    }

    // The admin/drop balance arrays below expose payment-routing config (admin +
    // DROP display names alongside their accumulated balances). They need no
    // role re-check: the guard above already throws for every role except ADMIN.

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
    // `confirmPayout` when ADMIN manually confirms an off-platform
    // payout — also credits the chosen admin's balance. Phase 2 PAYOUT_ADMIN
    // (automatic 50/50 split) remains untouched and continues to count too;
    // both flows run in parallel per task scope ("Phase 2 auto-50/50 НЕ
    // ТРОГАТЬ — manual flow живёт параллельно"). Senior-only / legacy admin
    // balance values are unchanged because they never produce PAYOUT_CONFIRMED
    // rows.
    // Roles that fail the RBAC guard at the top of this method never reach
    // here at all.
    //
    // No `archivedAt` filter here — EXPLICIT, not an oversight (review round
    // 2, LOW-1): `eq(users.role, 'ADMIN')` alone includes archived admins,
    // exactly as it already did before this PR for the ADMIN viewer — this
    // task widens WHO can see the array, it does not change WHAT rows are in
    // it. An archived admin can still carry a nonzero HOLDING balance the
    // company owes or holds (departure ≠ automatic zero-out/settlement), so
    // dropping the row would hide money that still needs reconciling.
    // `getAdminBalance` (balance.service.ts) has no archived check either.
    // If archived admins should ever be hidden from this array, that is a
    // separate, undocumented-today business decision (nothing in
    // docs/business/ addresses it) — not bundled into this task's narrow
    // scope of "who may see `adminBalances`".
    const adminBalances = (
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
    const dropBalances = (
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
      // Audit 2026-06-28 (#9): bucket by the business date (txDate). Backlog
      // 338: the createdAt fallback is gone; a NULL txDate throws.
      //
      // CR-809-H-2: the line that used to stand here — "Prod data has txDate ==
      // createdAt so the existing totals / graph are unchanged" — has been false
      // since #809 shipped operator-chosen dates. It is removed rather than
      // amended because it was being read as a licence to key sibling
      // aggregates on `createdAt`; the former accountant KPI tile did
      // exactly that and disagreed with this graph by the backdated amounts.
      const month = transactionBusinessMonth(tx) // YYYY-MM
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
   * conversion — consistent with HR mySalaryStatus which
   * also report raw `amount`; the wire `currency` is the USD display label.
   */
  async getSeniorSummary(currentUser: SessionUser): Promise<SeniorSummaryDto> {
    if (currentUser.role !== 'SENIOR' && currentUser.role !== 'ADMIN') {
      throw apiError('FINANCE_SENIOR_SUMMARY_FORBIDDEN', HttpStatus.FORBIDDEN)
    }

    const selfId = currentUser.id

    // Business months (`YYYY-MM`), on the SAME clock as the monthly graph in
    // `getSummary` (backlog 338): each income is bucketed
    // by `transactionBusinessMonth`, and "this" / "last" month are the Kyiv month
    // of `now` and the one before it. A month KEY compare is exactly the old
    // half-open window compare: PR #868's rule that a future-dated income (txDate
    // is user-chosen) must not leak into "this month" holds because a later month
    // has a different key.
    const now = new Date()
    const thisMonthKey = kyivDayOf(now).slice(0, 7)
    const monthKeyBefore = (offset: number): string =>
      addCalendarMonths(`${thisMonthKey}-01`, -offset).slice(0, 7)
    const lastMonthKey = monthKeyBefore(1)
    // Backlog 338 (a): the SALARY lookup key is the same Kyiv month as the
    // incomes above, so one response never mixes two months for 2-3 hours.
    const salaryMonth = thisMonthKey

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
      // Per-month bucket for the sparkline (keyed by the income's business month).
      const key = transactionBusinessMonth(tx)
      perMonthShare.set(key, (perMonthShare.get(key) ?? 0) + share)
      if (key === lastMonthKey) {
        incomeLastMonth += share
      }
      if (key === thisMonthKey) {
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
      const key = monthKeyBefore(i)
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
    // all" question the E-5 gap report answers (only HR/JUNIOR are
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
   * Income compliance overview — «Контроль приходов». ADMIN only;
   * logic and full contract live in `income-compliance.util.ts`.
   */
  async getIncomeComplianceOverview(
    currentUser: SessionUser,
    month?: string,
  ): Promise<IncomeComplianceOverviewDto> {
    return getIncomeComplianceOverview(this.db, currentUser, month)
  }
}
