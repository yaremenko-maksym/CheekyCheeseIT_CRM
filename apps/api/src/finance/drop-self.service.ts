import { HttpStatus, Injectable } from '@nestjs/common'
import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm'
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
 * CR-809-M-6: the business date of a transaction — the operator-chosen
 * `tx_date` when there is one, else the row's `created_at`. Since #809 shipped
 * custom dates the two are no longer interchangeable, and every place that
 * answers "when did this money happen" has to key on this one expression.
 *
 * Declared once, as a function rather than a constant, because a Drizzle `SQL`
 * fragment is consumed when it is embedded in a query — sharing a single
 * instance across the order-by and both window bounds of the same query is not
 * safe. Mirrors the same expression in `admin-summary.service` (active-tx feed),
 * `transactions.service.findAll` and `summary.service`'s paid-this-month tile.
 */
const businessDate = () => sql`coalesce(${transactions.txDate}, ${transactions.createdAt})`

/**
 * A timestamp column as an ISO string. `node-postgres` hands back a `Date` for
 * `timestamptz`, but the stubbed-executor unit specs hand back whatever the
 * fixture holds, so both shapes are accepted — the previous inline ternary did
 * the same thing in three places and is collapsed here.
 */
const toIso = (v: Date | string): string =>
  v instanceof Date ? v.toISOString() : new Date(v).toISOString()

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

    // CR-809-M-6: the from/to window is a BUSINESS-date window and it is applied
    // in SQL, not in JS over a full table read.
    //
    // Both halves of that matter. Keyed on `created_at`, a row the drop
    // backdated (or that an admin booked for last month) fell into the bucket
    // for the month it was ENTERED, so the period filter disagreed with the
    // date the same row shows in the finance tables. And the filter ran after
    // `findMany` had already fetched every one of the drop's rows, so the
    // window did no work for the database at all.
    //
    // Boundary semantics are carried over unchanged, deliberately: `from` is a
    // YYYY-MM-DD string whose `Date.parse` is that day's midnight UTC
    // (inclusive), and `to` is extended by 86_399_999 ms (= 23:59:59.999) so a
    // row anywhere inside the last requested day is included rather than only
    // one landing exactly at 00:00:00 UTC (MED review finding code-review-2).
    // Those two bounds are now bound as query parameters instead of compared in
    // JS; `drop-self.service.spec.ts` asserts the compiled predicate and the
    // bound values, and the real-DB spec asserts the inclusive edges.
    //
    // Index note: no index serves this. The only date index on `transactions`
    // is `idx_transactions_active_created_at (created_at) WHERE deleted_at IS
    // NULL`, and a btree on a bare column cannot answer a `coalesce(...)`
    // range. The predicate is still strictly better than before — Postgres now
    // discards the out-of-window rows during the scan instead of shipping them
    // all to Node — but it is a filtered scan, not an index range scan. The
    // index that would serve it is
    // `((coalesce(tx_date, created_at))) WHERE deleted_at IS NULL`; it is not
    // added here because the scan is already bounded to ONE drop's rows by the
    // `receiver_id` equality in the same predicate.
    const fromBound = query.from ? new Date(Date.parse(query.from)) : undefined
    const toBound = query.to ? new Date(Date.parse(query.to) + 86_399_999) : undefined

    // Self-scope at the DB level: only this drop's rows across BOTH income
    // models (see docstring). AC2: DROP is non-privileged — a deleted own
    // income must not resurface here.
    const rows = await this.db.db.query.transactions.findMany({
      where: and(
        inArray(transactions.type, ['DROP_INCOME', 'DROP_PENDING_PAYOUT', 'PAYOUT_DROP']),
        eq(transactions.receiverId, currentUser.id),
        isNull(transactions.deletedAt),
        ...(fromBound ? [gte(businessDate(), fromBound)] : []),
        ...(toBound ? [lte(businessDate(), toBound)] : []),
      ),
      orderBy: [desc(businessDate())],
      with: { project: { columns: { companyName: true } } },
    })

    // The status filter stays in memory: it compares the MAPPED status so the
    // FE contract (pending|validated|paid|rejected) is honoured for EITHER
    // income model, and that mapping lives in `drop-status.util`. Pushing it to
    // SQL would mean duplicating the DB-status → FE-status table in a CASE
    // expression, i.e. two places to keep in step for no correctness gain.
    const mappedStatusOf = (tx: { type: string; status: string }): DropIncomeStatus =>
      tx.type === 'DROP_INCOME'
        ? mapDropIncomeStatus(tx.status)
        : mapDropObligationStatus(tx.status)

    const filtered = query.status ? rows.filter((tx) => mappedStatusOf(tx) === query.status) : rows

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
      createdAt: toIso(tx.createdAt),
      // CR-809-M-6: the date the row is ORDERED and WINDOWED by is now the
      // business date, so the caller has to be able to read it — a list sorted
      // and bucketed by a key the client cannot see is the defect, not the fix.
      // The mapper stays an explicit allow-list (no row spread): this adds one
      // field of the viewer's OWN row, and `createdAt` of that same row is
      // already returned, so no new information class is exposed. NULL for
      // every row that predates #809.
      txDate: tx.txDate ? toIso(tx.txDate) : null,
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
      // CR-809-M-6 lists `both drop-self.service queries` — this is the second.
      // A payout the drop made can carry an operator-chosen date too, so the
      // same ordering key applies, and for the same reason: this feed renders
      // the business date, so it must be sorted by it.
      orderBy: [desc(businessDate())],
    })

    return rows.map((tx) => ({
      id: tx.id,
      amount: parseFloat(tx.amount),
      currency: tx.currency,
      ...(tx.txHash ? { txHash: tx.txHash } : {}),
      status: mapDropPaymentStatus(tx.status),
      createdAt: toIso(tx.createdAt),
      // Same reasoning as the incomes feed above: ordered by the business date,
      // so the business date is readable. Self-scoped (`senderId = self.id`).
      txDate: tx.txDate ? toIso(tx.txDate) : null,
    }))
  }
}
