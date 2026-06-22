import { ForbiddenException, Inject, Injectable } from '@nestjs/common'
import { desc, sql } from 'drizzle-orm'
import type { SessionUser, AdminSummary } from '@crm/shared'
import { adminSummarySchema } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { interviews, projects, transactions, users } from '../database/schema'

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
    const [projRow] = await db
      .select({
        activeProjects: sql<number>`count(*) filter (where ${projects.archivedAt} is null)`.mapWith(
          Number,
        ),
        projectsUnpaidThisMonth:
          sql<number>`count(*) filter (where ${projects.archivedAt} is null and not exists (
          select 1 from ${transactions} t
          where t.project_id = ${projects.id}
            and t.type in ('ADMIN_INCOME', 'TOV_INCOME', 'DROP_INCOME')
            and t.tx_date >= ${monthStart}
            and t.tx_date < ${nextMonthStart}
        ))`.mapWith(Number),
      })
      .from(projects)

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
    // Relational query API resolves sender/receiver display names + project name
    // (same pattern as TransactionsService.findAll). Newest tx_date first; rows
    // with a NULL tx_date sort by created_at via the coalesce ordering.
    const rows = await db.query.transactions.findMany({
      where: (tx, { inArray }) => inArray(tx.status, [...ACTIVE_TX_STATUSES]),
      with: {
        sender: { columns: { displayName: true } },
        receiver: { columns: { displayName: true } },
        project: { columns: { name: true } },
      },
      orderBy: [desc(sql`coalesce(${transactions.txDate}, ${transactions.createdAt})`)],
    })

    const activeTransactions = rows.map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status,
      senderLabel: r.senderLabel ?? r.sender?.displayName ?? null,
      receiverLabel: r.receiverLabel ?? r.receiver?.displayName ?? null,
      projectName: r.project?.name ?? null,
      amount: r.amount,
      // Real DB transaction currency, passed straight through (validated against
      // `currencyEnumSchema` by the `adminSummarySchema.parse` below). Identical to
      // the Финансы page — no lossy payment-rail mapping.
      currency: r.currency,
      txDate: (r.txDate ?? r.createdAt).toISOString(),
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
