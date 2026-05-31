/**
 * Drop role - phase 4-A. Balance infrastructure for the Phase 4-B payment
 * channels.
 *
 * Balances are derived on-demand from the unified `transactions` ledger and
 * the auxiliary `pending_obligations` table. NO stored balance columns; the
 * ledger is the single source of truth.
 *
 * Multi-currency: each balance method accepts a `currency` (default 'USD').
 * Rows in other currencies are converted to the requested base through
 * `NbuCurrencyService` rates. USDT is pegged 1:1 to USD; UAH/EUR convert via
 * NBU. The conversion is intentionally simple — one snapshot of "today's"
 * rate is applied to every row regardless of the historical txDate. The
 * Phase 4-B settlement UI surfaces historical rates separately when
 * required; for the running balance view this trade-off keeps the math
 * readable and deterministic for tests.
 *
 * Parallel to legacy `TransactionsService.getSummary` — see task spec AC6.
 * Both services read the same ledger and stay independent: getSummary keeps
 * its `PAYOUT_ADMIN + ADMIN_INCOME + ADMIN_TRANSFER + PAYOUT_CONFIRMED` map,
 * BalanceService reads only the new Phase 4-A types. Mixing is intentional:
 * existing dashboards keep showing what they show today; new dashboards
 * (Phase 4-B) consume BalanceService.
 */
import { ForbiddenException, Injectable } from '@nestjs/common'
import { and, eq } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { pendingObligations } from '../database/schema'
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
   * Corporate (ТОВ) balance = sum of TOV_INCOME − sum of DIVIDEND_TO_ADMIN −
   * sum of EXPENSE (where the legacy receiverLabel marks a FIAT_TOV channel)
   * − sum of DIVIDEND_TAX. The breakdown surfaces each line item so the
   * Phase 4-B UI can render a "where did the money go" mini-statement.
   *
   * Phase 4-A note on EXPENSE attribution: the FIAT_TOV channel marker is
   * carried in `receiverLabel` until Phase 4-B introduces an explicit channel
   * column. For Phase 4-A we count EXPENSE rows whose `receiverLabel` matches
   * `FIAT_TOV` (case-insensitive prefix). Legacy expenses without the marker
   * are not double-counted by the new balance — they continue to flow through
   * `getSummary` only.
   */
  async getTOVBalance(currency: BalanceCurrency = 'USD'): Promise<BalanceResult> {
    const rates = await this.nbu.getRates()
    const allTxs = await this.db.db.query.transactions.findMany()

    let income = 0
    let dividendsPaid = 0
    let expenses = 0
    let tax = 0
    for (const tx of allTxs) {
      const amt = parseFloat(tx.amount)
      if (!Number.isFinite(amt)) continue
      const converted = convertToBase(amt, tx.currency as BalanceCurrency, currency, rates)
      if (tx.type === 'TOV_INCOME') {
        income += converted
      } else if (tx.type === 'DIVIDEND_TO_ADMIN') {
        dividendsPaid += converted
      } else if (tx.type === 'DIVIDEND_TAX') {
        tax += converted
      } else if (tx.type === 'EXPENSE' && this.isFiatTovExpense(tx.receiverLabel)) {
        expenses += converted
      }
    }

    const balance = income - dividendsPaid - expenses - tax
    return {
      balance,
      currency,
      breakdown: { income, dividends_paid: dividendsPaid, expenses, tax },
    }
  }

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
   * /api/balances/tov — only ADMIN/ACCOUNTANT. The corporate balance is a
   * sensitive aggregate (it implies overall profitability) so seniors are
   * intentionally excluded.
   */
  assertCanReadTOV(user: SessionUser): void {
    if (user.role !== 'ADMIN' && user.role !== 'ACCOUNTANT') {
      throw new ForbiddenException('Доступ к балансу ТОВ только для ADMIN/ACCOUNTANT')
    }
  }

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

  /**
   * Counts EXPENSE rows where the receiverLabel marks the corporate (ТОВ)
   * fiat channel. Phase 4-B will replace this label heuristic with an
   * explicit channel column on the transactions row; for Phase 4-A we keep
   * the heuristic narrow (prefix match) so legacy expenses don't leak in.
   */
  private isFiatTovExpense(receiverLabel: string | null): boolean {
    if (!receiverLabel) return false
    return receiverLabel.toUpperCase().startsWith('FIAT_TOV')
  }
}
