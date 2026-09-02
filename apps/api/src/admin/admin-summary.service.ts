import { ForbiddenException, Inject, Injectable } from '@nestjs/common'
import { desc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { SessionUser, AdminSummary } from '@crm/shared'
import { adminSummarySchema } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
// security-review PR #456 round 2: `nonDeletedTransactions` (VIEW), never the
// raw `transactions` table — this module is outside `finance/**` and the
// ESLint no-restricted-imports rule bans the raw import here. See schema.ts's
// doc on the view for why (eliminate the class, don't rely on a scanner to
// catch a caller who forgot the filter).
// task-project-draft-status: `visibleProjects` (VIEW), never the raw
// `projects` table — this module is banned from the raw import (ESLint
// no-restricted-imports) for the same "eliminate, don't detect" reason as
// `nonDeletedTransactions` above: a DRAFT/REJECTED project must never count
// toward an "active projects" KPI, and there is no WHERE clause here to
// forget.
import { interviews, nonDeletedTransactions, users, visibleProjects } from '../database/schema'

/**
 * The three actionable in-flight statuses surfaced in the «Активные транзакции»
 * table. PAID / VALIDATED / REJECTED / LOCKED are terminal-or-resolved and
 * intentionally excluded. PENDING_CASH_CONFIRM is kept for legacy rows that may
 * still carry it. Single source of truth for both the query filter and the spec.
 */
const ACTIVE_TX_STATUSES = ['PENDING', 'PENDING_PAYMENT', 'PENDING_CASH_CONFIRM'] as const

@Injectable()
export class AdminSummaryService {
  // Explicit @Inject so the service can be instantiated by Nest's DI in the
  // vitest/esbuild env (which omits `design:paramtypes`) — required by the
  // admin-summary RBAC integration spec. Mirrors TransactionsService.
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  /**
   * ADMIN dashboard «центр действий» snapshot — KPI counters + the actionable
   * transaction pipeline. ADMIN-only (defense-in-depth alongside the controller
   * RolesGuard — every other role throws 403 here too, so the company-wide
   * aggregate never leaks even if the guard wiring regresses).
   *
   * KPI semantics:
   *   - activeProjects           — non-archived projects.
   *   - employees                — ALL users (every role, incl. DROP).
   *   - projectsUnpaidThisMonth  — non-archived projects with NO incoming
   *                                (ADMIN_INCOME / TOV_INCOME / DROP_INCOME) tx
   *                                whose `tx_date` is in the current month.
   *   - activeInterviews         — interviews NOT in a terminal stage
   *                                (HIRED / REJECTED / ARCHIVED).
   *
   * activeTransactions — rows in PENDING / PENDING_PAYMENT / PENDING_CASH_CONFIRM,
   * newest `tx_date` first, with party labels resolved (explicit label OR the
   * linked user's display name) and `canPay` = (status === 'PENDING_PAYMENT').
   *
   * The full payload is validated with `adminSummarySchema.parse(...)` before it
   * leaves the service so any shape drift surfaces server-side, not on the wire.
   */
  async getSummary(currentUser: SessionUser): Promise<AdminSummary> {
    if (currentUser.role !== 'ADMIN') {
      throw new ForbiddenException('Access denied: admin summary requires ADMIN role')
    }

    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))

    const db = this.db.db

    // ── KPI: one aggregating pass per source table (counts only) ───────────────
    // activeProjects + projectsUnpaidThisMonth share a single scan over projects.
    // projectsUnpaidThisMonth uses a NOT EXISTS correlated subquery against the
    // income types whose tx_date falls in [monthStart, nextMonthStart).
    //
    // BUG FIX (found as a byproduct of task-soft-delete-and-money-audit's AC4
    // regression test — pre-existing, unrelated to soft-delete): the
    // correlation predicate used to read `where t.project_id = ${projects.id}`.
    // Drizzle's `sql` template renders an interpolated column reference by its
    // bare SQL name when the outer query has no explicit alias — `${projects.id}`
    // compiled to unqualified `"id"`. Inside the NESTED subquery (`from
    // transactions t`), Postgres resolves an unqualified `"id"` to the
    // NEAREST scope, i.e. `t.id` (transactions.id) — NOT the intended outer
    // `projects.id`. The predicate silently became `t.project_id = t.id`,
    // which is (practically) never true, so `NOT EXISTS (...)` was ALWAYS
    // true and `projectsUnpaidThisMonth` counted EVERY active project as
    // unpaid regardless of any matching income.
    //
    // security-review PR #456 (LOW, round 2): the original hand-typed
    // literal `p.id` inside the subquery below relied on an EXPLICIT
    // `alias(projects, 'p')` to guarantee the name "p" matched the FROM
    // target.
    //
    // security-review round 3 (SR-H-2, task-project-draft-status): the
    // "self-heals via full qualification" claim this comment used to make
    // about bare `${visibleProjects.id}` interpolation was WRONG. A Column
    // interpolated BARE inside a hand-written `sql` template de-qualifies to
    // just its own name (`"id"`) whenever that column's table is also the
    // OUTER query's `.from(...)` target — which it is here
    // (`.from(visibleProjects)`). Drizzle assumes "this is my own FROM
    // table, no ambiguity" and drops the table prefix — but this reference
    // sits inside a NESTED correlated subquery, where Postgres resolves the
    // bare `"id"` against the SUBQUERY's own FROM instead of the intended
    // outer row. Verified by compiling `.toSQL()` on the real query builder:
    // bare interpolation rendered `t.project_id = "id"` — always false — so
    // `projectsUnpaidThisMonth` counted EVERY visible project as unpaid
    // regardless of any matching income. Caught by
    // `transaction-soft-delete-balance-regression.integration.spec.ts`, not
    // by any unit spec — no unit double executes real SQL.
    //
    // Fix: route every predicate through drizzle's comparison helpers
    // (`eq`/`inArray`/`gte`/`lt`) instead of hand-typed `t.`-prefixed SQL
    // text. A Column wrapped by a helper is ALWAYS rendered fully qualified
    // with its real table name (verified by the same `.toSQL()` probe:
    // `"non_deleted_transactions"."project_id" = "visible_projects"."id"`) —
    // the de-qualification shortcut above only fires for a column
    // interpolated bare. This also drops the hand-typed subquery alias (`t`)
    // entirely, so there is no second name for Postgres to resolve a stray
    // bare reference against even by accident.
    const projQuery = db
      .select({
        activeProjects: sql<number>`count(*)`.mapWith(Number),
        projectsUnpaidThisMonth:
          // security-review PR #456 round 2: `nonDeletedTransactions` (VIEW) —
          // a deleted income cannot satisfy this NOT EXISTS check no matter
          // what, there is no `deleted_at is null` clause to omit (see
          // schema.ts's doc on the view).
          sql<number>`count(*) filter (where not exists (
          select 1 from ${nonDeletedTransactions}
          where ${eq(nonDeletedTransactions.projectId, visibleProjects.id)}
            and ${inArray(nonDeletedTransactions.type, ['ADMIN_INCOME', 'TOV_INCOME', 'DROP_INCOME'])}
            and ${gte(nonDeletedTransactions.txDate, monthStart)}
            and ${lt(nonDeletedTransactions.txDate, nextMonthStart)}
        ))`.mapWith(Number),
      })
      .from(visibleProjects)
    const [projRow] = await projQuery

    // employees — every user, every role (incl. DROP).
    const [userRow] = await db
      .select({ employees: sql<number>`count(*)`.mapWith(Number) })
      .from(users)

    // activeInterviews — stage NOT in the terminal set.
    const [intRow] = await db
      .select({
        activeInterviews:
          sql<number>`count(*) filter (where ${interviews.stage} not in ('HIRED', 'REJECTED', 'ARCHIVED'))`.mapWith(
            Number,
          ),
      })
      .from(interviews)

    // ── Active transactions feed ───────────────────────────────────────────────
    // security-review PR #456 round 2: sourced from `nonDeletedTransactions`
    // (VIEW) — a deleted row cannot appear in this feed no matter what (see
    // schema.ts's doc on the view). Views are not registered in Drizzle's
    // relational-query schema config, so the round-1 `db.query.transactions
    // .findMany({ with: {...} })` sugar is replaced with explicit joins —
    // `users` is joined TWICE (sender + receiver), so both sides need their
    // own `alias(...)`, same as a self-join. Newest tx_date first; rows with a
    // NULL tx_date sort by created_at via the coalesce ordering.
    const sender = alias(users, 'active_tx_sender')
    const receiver = alias(users, 'active_tx_receiver')
    const rows = await db
      .select({
        id: nonDeletedTransactions.id,
        type: nonDeletedTransactions.type,
        status: nonDeletedTransactions.status,
        senderId: nonDeletedTransactions.senderId,
        senderLabel: nonDeletedTransactions.senderLabel,
        senderDisplayName: sender.displayName,
        receiverId: nonDeletedTransactions.receiverId,
        receiverLabel: nonDeletedTransactions.receiverLabel,
        receiverDisplayName: receiver.displayName,
        projectId: nonDeletedTransactions.projectId,
        // task-project-draft-status: joined against `visibleProjects`, not
        // the raw table. A transaction can only ever have been created
        // against an `ACTIVE` project (Д2 refuses transaction creation on a
        // DRAFT/REJECTED one), so this only changes the display for a
        // project archived AFTER the fact — the same row this dashboard
        // already treats as an edge case, not the common path.
        projectName: visibleProjects.name,
        amount: nonDeletedTransactions.amount,
        currency: nonDeletedTransactions.currency,
        txDate: nonDeletedTransactions.txDate,
        createdAt: nonDeletedTransactions.createdAt,
        payoutRequestId: nonDeletedTransactions.payoutRequestId,
      })
      .from(nonDeletedTransactions)
      .leftJoin(sender, eq(sender.id, nonDeletedTransactions.senderId))
      .leftJoin(receiver, eq(receiver.id, nonDeletedTransactions.receiverId))
      .leftJoin(visibleProjects, eq(visibleProjects.id, nonDeletedTransactions.projectId))
      .where(inArray(nonDeletedTransactions.status, [...ACTIVE_TX_STATUSES]))
      .orderBy(
        desc(sql`coalesce(${nonDeletedTransactions.txDate}, ${nonDeletedTransactions.createdAt})`),
      )

    const activeTransactions = rows.map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status,
      // Raw ids + resolved user display names mirror TransactionsService.findAll
      // (senderName/receiverName = the linked user's displayName). The existing
      // *Label fields keep their resolved-label semantics; the new id/name fields
      // let the shared TransactionRow `FromTo` render a clickable participant for
      // SENIOR_PENDING_PAYOUT / DROP_INCOME instead of «—».
      senderId: r.senderId ?? null,
      senderName: r.senderDisplayName ?? null,
      senderLabel: r.senderLabel ?? r.senderDisplayName ?? null,
      receiverId: r.receiverId ?? null,
      receiverName: r.receiverDisplayName ?? null,
      receiverLabel: r.receiverLabel ?? r.receiverDisplayName ?? null,
      projectId: r.projectId ?? null,
      projectName: r.projectName ?? null,
      amount: r.amount,
      // Real DB transaction currency, passed straight through (validated against
      // `currencyEnumSchema` by the `adminSummarySchema.parse` below). Identical to
      // the Финансы page — no lossy payment-rail mapping.
      currency: r.currency,
      txDate: (r.txDate ?? r.createdAt).toISOString(),
      // Linked payout_request id (PAYOUT rows) — lets the dashboard open the SAME
      // finance ConfirmPayoutDialog (its COMPANY_ACCOUNT branch confirms off the
      // payout request id). Null for non-payout rows.
      payoutRequestId: r.payoutRequestId ?? null,
      canPay: r.status === 'PENDING_PAYMENT',
    }))

    // Validate the full payload against the shared contract before returning so
    // any drift fails server-side (loud) rather than silently on the client.
    return adminSummarySchema.parse({
      kpis: {
        activeProjects: projRow?.activeProjects ?? 0,
        employees: userRow?.employees ?? 0,
        projectsUnpaidThisMonth: projRow?.projectsUnpaidThisMonth ?? 0,
        activeInterviews: intRow?.activeInterviews ?? 0,
      },
      activeTransactions,
    })
  }
}
