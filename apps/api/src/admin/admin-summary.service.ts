import { ForbiddenException, Inject, Injectable } from '@nestjs/common'
import { desc, eq, inArray, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { SessionUser, AdminSummary } from '@crm/shared'
import { adminSummarySchema } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
// security-review PR #456 round 2: `nonDeletedTransactions` (VIEW), never the
// raw `transactions` table — this module is outside `finance/**` and the
// ESLint no-restricted-imports rule bans the raw import here. See schema.ts's
// doc on the view for why (eliminate the class, don't rely on a scanner to
// catch a caller who forgot the filter).
import { interviews, nonDeletedTransactions, projects, users } from '../database/schema'

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
    // security-review PR #456 (LOW, round 2 — precise about what each fix
    // covers, the round-1 comment here overclaimed): TWO INDEPENDENT
    // mechanisms are at play, not one:
    //   1. `p.id` — hand-typed literal SQL TEXT in the subquery below — is
    //      made safe by using an EXPLICIT alias (`const p = alias(projects,
    //      'p')`): the name "p" is what we typed, so it can never silently
    //      stop matching the FROM target's name, join or no join.
    //   2. `${p.archivedAt}` — an INTERPOLATED column reference — is safe for
    //      a DIFFERENT reason: Drizzle renders it bare ("archived_at", not
    //      "p"."archived_at") ONLY because this is currently a single-table
    //      select; empirically verified (`.toSQL()`, drizzle-orm 0.45.2) that
    //      it automatically becomes fully qualified ("p"."archived_at") the
    //      moment ANY join is added to this query — i.e. it self-heals, it
    //      was never "fixed" by the alias the way #1 was.
    // Both are safe, but for unrelated reasons — worth keeping distinct so a
    // future reader does not assume `alias(...)` is what protects #2.
    const p = alias(projects, 'p')
    const projQuery = db
      .select({
        activeProjects: sql<number>`count(*) filter (where ${p.archivedAt} is null)`.mapWith(
          Number,
        ),
        projectsUnpaidThisMonth:
          // security-review PR #456 round 2: `nonDeletedTransactions` (VIEW) —
          // a deleted income cannot satisfy this NOT EXISTS check no matter
          // what, there is no `deleted_at is null` clause to omit (see
          // schema.ts's doc on the view). Replaces the round-1 hand-written
          // `and t.deleted_at is null` line.
          sql<number>`count(*) filter (where ${p.archivedAt} is null and not exists (
          select 1 from ${nonDeletedTransactions} t
          where t.project_id = p.id
            and t.type in ('ADMIN_INCOME', 'TOV_INCOME', 'DROP_INCOME')
            and t.tx_date >= ${monthStart}
            and t.tx_date < ${nextMonthStart}
        ))`.mapWith(Number),
      })
      .from(p)
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
        projectName: projects.name,
        amount: nonDeletedTransactions.amount,
        currency: nonDeletedTransactions.currency,
        txDate: nonDeletedTransactions.txDate,
        createdAt: nonDeletedTransactions.createdAt,
        payoutRequestId: nonDeletedTransactions.payoutRequestId,
      })
      .from(nonDeletedTransactions)
      .leftJoin(sender, eq(sender.id, nonDeletedTransactions.senderId))
      .leftJoin(receiver, eq(receiver.id, nonDeletedTransactions.receiverId))
      .leftJoin(projects, eq(projects.id, nonDeletedTransactions.projectId))
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
