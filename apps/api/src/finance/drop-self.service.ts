import { HttpStatus, Injectable } from '@nestjs/common'
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import type {
  SessionUser,
  DropIncomeDto,
  DropIncomeStatus,
  DropIncomesQuery,
  DropPaymentDto,
  PaginatedDropIncomes,
} from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import { transactions, users } from '../database/schema'
import { NbuCurrencyService } from './nbu-currency.service'
import {
  mapDropIncomeStatus,
  mapDropObligationStatus,
  mapDropPaymentStatus,
} from './drop-status.util'
import { computeDropAggregate } from './drop-distribution.util'

/**
 * Self-only DROP read path: summary, incomes feed and outgoing-payments feed
 * for the calling DROP user. Every query is scoped to the caller's own rows.
 * Depends on the database and NBU rates only, never on TransactionsService.
 */
@Injectable()
export class DropSelfService {
  constructor(
    private readonly db: DatabaseService,
    private readonly nbuCurrency: NbuCurrencyService,
  ) {}

  /**
   * Self-only DROP summary for `GET /api/finance/drop/me/summary`.
   *
   * Drop role - phase 1 (task-drop-1-backend). RBAC: DROP only — every other
   * role (SENIOR / JUNIOR / HR / ACCOUNTANT / ADMIN) gets 403. The drop only
   * ever sees THEIR OWN aggregate — the method filters the ledger to the
   * caller's own rows inside `computeDropAggregate(self, …)`, so no other
   * drop's balance / debt can leak out of this endpoint.
   */
  async getDropSelfSummary(currentUser: SessionUser): Promise<{
    balance: number
    dropSharePercent: number
    pendingIncomesCount: number
    debtToCompany: number
    pendingObligationAmount: number
    pendingObligationCount: number
  }> {
    if (currentUser.role !== 'DROP') {
      throw apiError('FINANCE_DROP_SUMMARY_FORBIDDEN', HttpStatus.FORBIDDEN)
    }

    const self = await this.db.db.query.users.findFirst({
      where: eq(users.id, currentUser.id),
    })
    if (!self) throw apiError('DROP_NOT_FOUND', HttpStatus.NOT_FOUND)

    // task-soft-delete-and-money-audit (AC4): a deleted row must not move the
    // drop's own balance/debt figures.
    //
    // security-review PR #523 round 1 (MED-1): scoped at the SQL level instead
    // of pulling the WHOLE `transactions` table into memory for a single
    // drop's summary. `computeDropAggregate` only ever reads a row where
    // (receiverId = self OR senderId = self) AND type is one of these four —
    // every one of its four filters (balance/pendingCount/debtToCompany/
    // pendingObligationAmount) requires BOTH conditions, so this predicate is
    // exactly equivalent to the old unscoped scan, never a behaviour change —
    // it just stops fetching every OTHER drop's/senior's/admin's rows too.
    const allTxs = (await this.db.db.query.transactions.findMany({
      where: and(
        isNull(transactions.deletedAt),
        or(eq(transactions.receiverId, self.id), eq(transactions.senderId, self.id)),
        inArray(transactions.type, ['PAYOUT_DROP', 'DROP_INCOME', 'PAYOUT', 'DROP_PENDING_PAYOUT']),
      ),
    })) as Array<{
      type: string
      status: string
      amount: string
      currency?: string
      senderId: string | null
      receiverId: string | null
    }>

    // Audit 2026-06-28 (#4): pass the NBU snapshot so a mixed-currency drop ledger
    // aggregates in one base. USD/USDT short-circuits to identity in convertToBase.
    const rates = await this.nbuCurrency.getRates()
    const aggregate = computeDropAggregate(
      { id: self.id, displayName: self.displayName, dropSharePercent: self.dropSharePercent },
      allTxs,
      rates,
    )

    return {
      balance: aggregate.balance,
      dropSharePercent: aggregate.dropSharePercent,
      pendingIncomesCount: aggregate.pendingCount,
      debtToCompany: aggregate.debtToCompany,
      pendingObligationAmount: aggregate.pendingObligationAmount,
      pendingObligationCount: aggregate.pendingObligationCount,
    }
  }

  /**
   * Self-only DROP income feed for `GET /api/finance/drop/me/incomes`.
   *
   * Drop role - phase 2 (task-drop-2-backend). RBAC: DROP only — every other
   * role gets 403. The drop only ever sees THEIR OWN incomes — the query is
   * scoped to `receiverId = self.id` at the DB level, so no other drop's
   * income can leak. Supports status / date-window filters and offset
   * pagination; `total` is the count BEFORE the page slice.
   *
   * task-drop-sees-own-obligations: the feed covers BOTH income models a drop
   * can carry — `DROP_INCOME` is `receiverId`-scoped by design (see
   * `createDropIncome`); `receiverId` is likewise the invariant for every
   * DROP_PENDING_PAYOUT / PAYOUT_DROP row (`bookCompanyObligations` always
   * sets `receiverId: drop.id`), so ONE `receiverId = self.id` predicate
   * safely covers all three types — no widening of WHO can be seen, only of
   * WHICH of the caller's OWN rows are included (§AC5).
   *   - 'DROP_INCOME'                    → the old self-declared model.
   *   - 'DROP_PENDING_PAYOUT'/'PAYOUT_DROP' → the SAME obligation row across
   *     its lifecycle (booked PENDING_PAYMENT, settled IN PLACE to PAYOUT_DROP
   *     PAID — never two rows for one obligation), from the admin-USDT
   *     declare path or the drop-payout cascade.
   * `model` on the returned DTO discriminates which one produced each row.
   *
   * `companyName`: for a DROP_INCOME row, sourced from `senderLabel` (set to
   * `project.companyName` at creation), falling back to the linked project's
   * companyName, then ''. For an obligation row `senderLabel` is always the
   * literal 'COMPANY' marker (see `bookCompanyObligations`), which is not a
   * company name — those rows use `companyNameSnapshot` (frozen at booking
   * time — security-review PR #523 round 1, MED-4: a live `project.companyName`
   * join would let a LATER project rename silently rewrite the company name on
   * money already booked under the old one), falling back to the live
   * `project.companyName` join only for the rare pre-migration row that
   * predates the snapshot column (NULL), then '' if even the project link is
   * gone.
   */
  async getDropSelfIncomes(
    currentUser: SessionUser,
    query: DropIncomesQuery,
  ): Promise<PaginatedDropIncomes> {
    if (currentUser.role !== 'DROP') {
      throw apiError('FINANCE_DROP_INCOMES_FORBIDDEN', HttpStatus.FORBIDDEN)
    }

    // Self-scope at the DB level: only this drop's rows across BOTH income
    // models (see docstring). AC2: DROP is non-privileged — a deleted own
    // income must not resurface here.
    const rows = await this.db.db.query.transactions.findMany({
      where: and(
        inArray(transactions.type, ['DROP_INCOME', 'DROP_PENDING_PAYOUT', 'PAYOUT_DROP']),
        eq(transactions.receiverId, currentUser.id),
        isNull(transactions.deletedAt),
      ),
      orderBy: [desc(transactions.createdAt)],
      with: { project: { columns: { companyName: true } } },
    })

    // In-memory status + date-window filters (the feed per drop is small;
    // pushing these to SQL would not change correctness and keeps the status
    // mapping in one place). The status filter compares the MAPPED status so
    // the FE contract (pending|validated|paid|rejected) is honoured, for
    // EITHER model.
    const fromTs = query.from ? Date.parse(query.from) : -Infinity
    // `to` is a YYYY-MM-DD date string: Date.parse gives midnight UTC (start of
    // that day). Add 86_399_999 ms (= 23:59:59.999) so that incomes created
    // anywhere during the last requested day are included — not just those at
    // exactly 00:00:00 UTC. Fix: MED review finding code-review-2.
    const toTs = query.to ? Date.parse(query.to) + 86_399_999 : Infinity

    const mappedStatusOf = (tx: { type: string; status: string }): DropIncomeStatus =>
      tx.type === 'DROP_INCOME'
        ? mapDropIncomeStatus(tx.status)
        : mapDropObligationStatus(tx.status)

    const filtered = rows.filter((tx) => {
      if (query.status && mappedStatusOf(tx) !== query.status) return false
      const created =
        tx.createdAt instanceof Date ? tx.createdAt.getTime() : Date.parse(String(tx.createdAt))
      if (created < fromTs) return false
      if (created > toTs) return false
      return true
    })

    const total = filtered.length
    const start = (query.page - 1) * query.limit
    const pageRows = filtered.slice(start, start + query.limit)

    const items: DropIncomeDto[] = pageRows.map((tx) => ({
      id: tx.id,
      companyName:
        tx.type === 'DROP_INCOME'
          ? (tx.senderLabel ?? tx.project?.companyName ?? '')
          : (tx.companyNameSnapshot ?? tx.project?.companyName ?? ''),
      amount: parseFloat(tx.amount),
      currency: tx.currency,
      createdAt:
        tx.createdAt instanceof Date
          ? tx.createdAt.toISOString()
          : new Date(tx.createdAt).toISOString(),
      status: mappedStatusOf(tx),
      model: tx.type === 'DROP_INCOME' ? 'declared' : 'obligation',
    }))

    return { items, total, page: query.page, limit: query.limit }
  }

  /**
   * Self-only DROP outgoing-payments feed for
   * `GET /api/finance/drop/me/payments`.
   *
   * Drop role - phase 2 (task-drop-2-backend). RBAC: DROP only — every other
   * role gets 403. Lists the PAYOUT rows the drop owes / has paid the company,
   * scoped to `type = 'PAYOUT' AND senderId = self.id` at the DB level (same
   * rows that feed `debtToCompany` in `computeDropAggregate`), so no other
   * drop's payments can leak.
   */
  async getDropSelfPayments(currentUser: SessionUser): Promise<DropPaymentDto[]> {
    if (currentUser.role !== 'DROP') {
      throw apiError('FINANCE_DROP_PAYMENTS_FORBIDDEN', HttpStatus.FORBIDDEN)
    }

    const rows = await this.db.db.query.transactions.findMany({
      where: and(eq(transactions.type, 'PAYOUT'), eq(transactions.senderId, currentUser.id)),
      orderBy: [desc(transactions.createdAt)],
    })

    return rows.map((tx) => ({
      id: tx.id,
      amount: parseFloat(tx.amount),
      currency: tx.currency,
      ...(tx.txHash ? { txHash: tx.txHash } : {}),
      status: mapDropPaymentStatus(tx.status),
      createdAt:
        tx.createdAt instanceof Date
          ? tx.createdAt.toISOString()
          : new Date(tx.createdAt).toISOString(),
    }))
  }
}
