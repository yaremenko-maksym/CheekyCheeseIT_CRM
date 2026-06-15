/**
 * Drop role - phase 4 (refactor — task-drop-phase4-refactor-remove-tov.md).
 *
 * Personal-balance infrastructure for the post-refactor payment channels.
 * Balances are derived on-demand from the unified `transactions` ledger and
 * the auxiliary `pending_obligations` table. NO stored balance columns; the
 * ledger is the single source of truth.
 *
 * Multi-currency: each balance method accepts a `currency` (default 'USD').
 * Rows in other currencies are converted to the requested base through
 * `NbuCurrencyService` rates. USDT is pegged 1:1 to USD; UAH/EUR convert via
 * NBU. The conversion is intentionally simple — one snapshot of "today's"
 * rate is applied to every row regardless of the historical txDate.
 *
 * Removed in the refactor (AC3): the `getTOVBalance` aggregate + matching
 * `/api/balances/tov` endpoint. The corporate ТОВ flow has been removed
 * end-to-end, so there is no longer a balance to aggregate.
 *
 * Parallel to legacy `TransactionsService.getSummary`. Both services read
 * the same ledger and stay independent: getSummary keeps its
 * `PAYOUT_ADMIN + ADMIN_INCOME + ADMIN_TRANSFER + PAYOUT_CONFIRMED` map,
 * BalanceService reads only the Phase 4 personal-credit types.
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { pendingObligations, users } from '../database/schema'
import { NbuCurrencyService, type ExchangeRateResult } from './nbu-currency.service'

export type BalanceCurrency = 'USDT' | 'USD' | 'EUR' | 'UAH'

export interface BalanceResult {
  balance: number
  currency: BalanceCurrency
  breakdown: Record<string, number>
}

export interface PendingObligationsFilter {
  creditorUserId?: string
  status?: 'PENDING' | 'PAID' | 'CANCELLED'
}

/**
 * Pure converter from an arbitrary (amount, currency) → the target base. Kept
 * private to the module but extracted as a free function so the unit tests
 * can call it directly without standing up the full service.
 */
export function convertToBase(
  amount: number,
  fromCurrency: BalanceCurrency,
  toCurrency: BalanceCurrency,
  rates: ExchangeRateResult,
): number {
  if (fromCurrency === toCurrency) return amount
  // First, normalize to UAH via the NBU rate, then to the target currency.
  // USDT is pegged 1:1 to USD so its UAH rate matches usdUah.
  const usdUah = parseFloat(rates.usdUah)
  const eurUah = parseFloat(rates.eurUah)
  if (!Number.isFinite(usdUah) || usdUah <= 0) return amount
  if (!Number.isFinite(eurUah) || eurUah <= 0) return amount

  const inUah = (() => {
    if (fromCurrency === 'UAH') return amount
    if (fromCurrency === 'USD' || fromCurrency === 'USDT') return amount * usdUah
    if (fromCurrency === 'EUR') return amount * eurUah
    return amount
  })()

  if (toCurrency === 'UAH') return inUah
  if (toCurrency === 'USD' || toCurrency === 'USDT') return inUah / usdUah
  if (toCurrency === 'EUR') return inUah / eurUah
  return inUah
}

@Injectable()
export class BalanceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly nbu: NbuCurrencyService,
  ) {}

  /**
   * Personal admin balance — sum of crypto/cash incomes attributed to that
   * admin via `recipientId` (falling back to `receiverId` for compatibility
   * with rows authored before the recipient pointer was added), plus
   * DIVIDEND_TO_ADMIN credit, minus EXPENSE rows where the admin is sender.
   *
   * Why recipientId-first: the recipientId column was added in Phase 2 and
   * Phase 4-A flows always populate it. We still honour receiverId for
   * compatibility — a payment channel migration can route the actual user
   * via either column without invalidating older rows.
   */
  async getAdminBalance(
    adminId: string,
    currency: BalanceCurrency = 'USD',
  ): Promise<BalanceResult> {
    const rates = await this.nbu.getRates()
    const allTxs = await this.db.db.query.transactions.findMany()

    let cashIncome = 0
    let cryptoIncome = 0
    let dividends = 0
    let expenses = 0
    for (const tx of allTxs) {
      const amt = parseFloat(tx.amount)
      if (!Number.isFinite(amt)) continue
      const converted = convertToBase(amt, tx.currency as BalanceCurrency, currency, rates)
      const recipient = tx.recipientId ?? tx.receiverId
      if (tx.type === 'ADMIN_INCOME_CASH' && recipient === adminId) {
        cashIncome += converted
      } else if (tx.type === 'ADMIN_INCOME_CRYPTO' && recipient === adminId) {
        cryptoIncome += converted
      } else if (tx.type === 'DIVIDEND_TO_ADMIN' && recipient === adminId) {
        dividends += converted
      } else if (tx.type === 'EXPENSE' && tx.senderId === adminId) {
        expenses += converted
      }
    }

    const balance = cashIncome + cryptoIncome + dividends - expenses
    return {
      balance,
      currency,
      breakdown: {
        cash_income: cashIncome,
        crypto_income: cryptoIncome,
        dividends,
        expenses,
      },
    }
  }

  /**
   * Personal senior balance — sum of SENIOR_INCOME_CRYPTO + SENIOR_PAID
   * credited to that senior, minus EXPENSE rows where the senior is sender.
   *
   * Critical: SENIOR_PENDING_PAYOUT is deliberately *not* counted. It opens
   * an obligation row but the cash hasn't moved yet. Only the closing
   * SENIOR_PAID row credits the senior's real balance.
   */
  async getSeniorBalance(
    seniorId: string,
    currency: BalanceCurrency = 'USD',
  ): Promise<BalanceResult> {
    const rates = await this.nbu.getRates()
    const allTxs = await this.db.db.query.transactions.findMany()

    let cryptoIncome = 0
    let paidIncome = 0
    let expenses = 0
    for (const tx of allTxs) {
      const amt = parseFloat(tx.amount)
      if (!Number.isFinite(amt)) continue
      const converted = convertToBase(amt, tx.currency as BalanceCurrency, currency, rates)
      const recipient = tx.recipientId ?? tx.receiverId
      if (tx.type === 'SENIOR_INCOME_CRYPTO' && recipient === seniorId) {
        cryptoIncome += converted
      } else if (tx.type === 'SENIOR_PAID' && recipient === seniorId) {
        paidIncome += converted
      } else if (tx.type === 'EXPENSE' && tx.senderId === seniorId) {
        expenses += converted
      }
    }

    const balance = cryptoIncome + paidIncome - expenses
    return {
      balance,
      currency,
      breakdown: {
        crypto_income: cryptoIncome,
        paid_income: paidIncome,
        expenses,
      },
    }
  }

  /**
   * Lifetime «всего заработано с нами» — the cumulative amount the COMPANY has
   * actually PAID this user across the whole history, surfaced on the employee
   * profile «Финансы» tab for ADMIN / ACCOUNTANT viewers.
   *
   * Definition (task-profile-earned-balance, USER-confirmed): the accumulated
   * money that the company *actually paid out* to this user. We therefore sum
   * only PAID transaction rows where the user is the REAL money recipient,
   * mapped per the user's role:
   *
   *   - JUNIOR / HR / ACCOUNTANT → SALARY rows (status=PAID, receiverId=user).
   *     Salary is the only channel the company pays these roles.
   *   - SENIOR → PAID SENIOR_INCOME only (the share the senior earned through
   *     the platform; recipient = receiverId ?? senderId for legacy rows).
   *     Consistent with getSeniorBalance.paidIncome — only money the platform
   *     confirmed as received by this senior. Phase 4-B types (SENIOR_PAID /
   *     SENIOR_INCOME_CRYPTO) are NOT counted here: they have not been emitted
   *     in the current data and belong to a separate payout channel; adding them
   *     to totalEarned would double-count once that channel lands.
   *   - DROP → PAID PAYOUT_DROP (drop's distribution share) PLUS PAID DROP_INCOME
   *     where recipient/receiver = drop (income that landed on the drop account).
   *   - ADMIN → PAID PAYOUT_ADMIN / DIVIDEND_TO_ADMIN / ADMIN_INCOME_CASH /
   *     ADMIN_INCOME_CRYPTO where recipient = admin. (Admins are not a profile
   *     target for this metric per the task, but supporting them keeps the
   *     resolver total — no role silently returns a wrong 0.)
   *
   * Multi-currency rows are converted to `currency` (default USD) via NBU rates,
   * mirroring getAdminBalance / getSeniorBalance. `breakdown` exposes the
   * per-source split so the UI can show "salary" vs "payout" if desired.
   *
   */
  async getTotalEarned(
    targetUserId: string,
    currency: BalanceCurrency = 'USD',
  ): Promise<{
    userId: string
    role: 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT' | 'DROP'
    totalEarned: number
    currency: BalanceCurrency
    breakdown: Record<string, number>
  }> {
    const target = await this.db.db.query.users.findFirst({
      where: eq(users.id, targetUserId),
    })
    if (!target) throw new NotFoundException('Пользователь не найден')

    const rates = await this.nbu.getRates()
    const allTxs = await this.db.db.query.transactions.findMany()

    // Only money that has actually moved counts — PAID is the single gate.
    const paidTxs = allTxs.filter((tx) => tx.status === 'PAID')

    const role = target.role as 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT' | 'DROP'
    const breakdown: Record<string, number> = {}

    const add = (key: string, amount: number) => {
      breakdown[key] = (breakdown[key] ?? 0) + amount
    }

    for (const tx of paidTxs) {
      const amt = parseFloat(tx.amount)
      if (!Number.isFinite(amt)) continue
      const recipient = tx.recipientId ?? tx.receiverId
      const converted = convertToBase(amt, tx.currency as BalanceCurrency, currency, rates)

      if (role === 'JUNIOR' || role === 'HR' || role === 'ACCOUNTANT') {
        // Company pays these roles only via SALARY.
        if (tx.type === 'SALARY' && tx.receiverId === targetUserId) add('salary', converted)
      } else if (role === 'SENIOR') {
        // Only PAID SENIOR_INCOME counts — consistent with getSeniorBalance.paidIncome.
        // Phase 4-B types (SENIOR_PAID, SENIOR_INCOME_CRYPTO) are excluded: they
        // belong to a separate payout channel and would double-count once emitted.
        if (
          tx.type === 'SENIOR_INCOME' &&
          (tx.receiverId === targetUserId ||
            (tx.receiverId == null && tx.senderId === targetUserId))
        ) {
          add('income', converted)
        }
      } else if (role === 'DROP') {
        if (tx.type === 'PAYOUT_DROP' && recipient === targetUserId) {
          add('payout', converted)
        } else if (tx.type === 'DROP_INCOME' && recipient === targetUserId) {
          add('income', converted)
        }
      } else if (role === 'ADMIN') {
        if (
          (tx.type === 'PAYOUT_ADMIN' ||
            tx.type === 'DIVIDEND_TO_ADMIN' ||
            tx.type === 'ADMIN_INCOME_CASH' ||
            tx.type === 'ADMIN_INCOME_CRYPTO') &&
          recipient === targetUserId
        ) {
          add('admin_income', converted)
        }
      }
    }

    const totalEarned = Object.values(breakdown).reduce((sum, v) => sum + v, 0)

    return { userId: targetUserId, role, totalEarned, currency, breakdown }
  }

  /**
   * Direct read from `pending_obligations`. Caller filters via optional
   * `creditorUserId` and `status`. Returned rows are mapped to the wire
   * shape (`PendingObligationDto`) — `amount` stays a numeric string to
   * avoid float drift in the API layer.
   */
  async getPendingObligations(filter: PendingObligationsFilter = {}) {
    // Filter conjuncts. drizzle's `and()` accepts an array; we build it
    // dynamically so unfiltered callers (admin/accountant pages) get every
    // row in one query.
    const conjuncts: Array<ReturnType<typeof eq>> = []
    if (filter.creditorUserId) {
      conjuncts.push(eq(pendingObligations.creditorUserId, filter.creditorUserId))
    }
    if (filter.status) {
      conjuncts.push(eq(pendingObligations.status, filter.status))
    }

    const rows = await this.db.db.query.pendingObligations.findMany({
      ...(conjuncts.length > 0 && { where: and(...conjuncts) }),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
    })

    return rows.map((row) => ({
      id: row.id,
      creditorUserId: row.creditorUserId,
      debtorType: row.debtorType,
      debtorUserId: row.debtorUserId,
      sourceTransactionId: row.sourceTransactionId,
      closingTransactionId: row.closingTransactionId,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }))
  }

  // ── RBAC helpers ──────────────────────────────────────────────────────────

  /**
   * /api/balances/admin/:id — ADMIN can read **any** admin balance (needed
   * for /crm/stats where the page shows Maksym + Kostya side-by-side);
   * ACCOUNTANT can read any. Other roles are forbidden.
   *
   * Earlier wording restricted ADMIN to self only — that broke /crm/stats
   * with 403 on the non-self balance card. The page lives only behind
   * ADMIN/ACCOUNTANT navigation anyway, so widening ADMIN to "any" stays
   * inside the original threat model. `_targetAdminId` is kept in the
   * signature (with `_` prefix to satisfy the no-unused-vars rule) so future
   * per-target audit can hook in without an API change.
   */
  assertCanReadAdminBalance(viewer: SessionUser, _targetAdminId: string): void {
    if (viewer.role === 'ACCOUNTANT') return
    if (viewer.role === 'ADMIN') return
    throw new ForbiddenException('Доступ к балансу админа: ADMIN или ACCOUNTANT')
  }

  /**
   * /api/balances/senior/:id — SENIOR can read only their own; ADMIN /
   * ACCOUNTANT can read any. JUNIOR / HR / DROP forbidden.
   */
  assertCanReadSeniorBalance(viewer: SessionUser, targetSeniorId: string): void {
    if (viewer.role === 'ADMIN' || viewer.role === 'ACCOUNTANT') return
    if (viewer.role === 'SENIOR' && viewer.id === targetSeniorId) return
    throw new ForbiddenException('Доступ к балансу синьора: ADMIN, ACCOUNTANT или сам синьор')
  }

  /**
   * /api/balances/total-earned/:id — the lifetime «всего заработано» metric is
   * a privileged financial figure: only ADMIN and ACCOUNTANT may read it, for
   * ANY target user. Every other role (incl. the target viewing their own
   * profile, and SENIOR/JUNIOR/HR/DROP) is forbidden — the figure is never
   * surfaced to non-privileged viewers (AC2/AC3). No self-view exception by
   * design: the metric exists for finance oversight, not self-reporting.
   */
  assertCanReadTotalEarned(viewer: SessionUser): void {
    if (viewer.role === 'ADMIN' || viewer.role === 'ACCOUNTANT') return
    throw new ForbiddenException('Доступ к показателю «всего заработано»: ADMIN или ACCOUNTANT')
  }

  /**
   * /api/pending-obligations — SENIOR sees only `creditor=self`; ADMIN /
   * ACCOUNTANT see all. The controller forces creditorUserId=self for the
   * SENIOR caller before delegating here.
   */
  assertCanListPendingObligations(viewer: SessionUser): void {
    if (viewer.role !== 'ADMIN' && viewer.role !== 'ACCOUNTANT' && viewer.role !== 'SENIOR') {
      throw new ForbiddenException(
        'Доступ к pending obligations: ADMIN, ACCOUNTANT или SENIOR (свои)',
      )
    }
  }
}
