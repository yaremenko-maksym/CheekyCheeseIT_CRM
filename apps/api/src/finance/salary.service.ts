import { HttpStatus, Injectable } from '@nestjs/common'
import { and, eq, inArray, isNotNull, isNull, notExists, or } from 'drizzle-orm'
// QueryBuilder assembles SQL without a client — used by
// `salaryReceiverNotArchivedFilter` to build a correlated sub-select that some
// OTHER statement executes. See that method for why it must not go through `db`.
import { QueryBuilder } from 'drizzle-orm/pg-core'
import type { SessionUser, SalaryMonthGapReportDto, SalaryMonthGapReceiverDto } from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import {
  projectFinanceSettings,
  projectMembers,
  projects,
  salaryMonthInitializations,
  transactions,
  users,
} from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { previousSalaryMonthKey } from './salary-month.util'

/**
 * Salary logic that depends on the database ONLY (no shared TransactionsService
 * helpers): receiver resolution for the monthly cron, the archived-receiver
 * money-safety guard, and the month-gap report. Extracted from
 * `TransactionsService` (decomposition stage T-L6). It must never depend on
 * `TransactionsService` — `paySalary` / `createMonthlySalaries` stay there and
 * call INTO this provider.
 */
@Injectable()
export class SalaryService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Refuse to pay a salary whose receiver has been dismissed.
   *
   * task-finance-fix-wave1 (E-1). Used in THREE places inside `paySalary`: as
   * the up-front gate (so the operator gets this message, not a generic one),
   * and after each of the two write paths reports zero affected rows — where it
   * turns "nothing was written" into the actual reason.
   *
   * Deliberately keyed on the row's OWN `receiverId`: `receiverId` is nullable
   * on `transactions` (label-only counterparties exist for other types), a row
   * with no receiver has no archival to check, and a null id must never reach
   * the query.
   *
   * `db` is the executor to read through, and it is a REQUIRED parameter rather
   * than a default of `this.db.db` (round 3, LOW): one of the callers runs inside
   * `db.transaction()`, and reaching for `this.db.db` there would check out a
   * SECOND pooled connection while the first is still held by the transaction.
   * On a saturated pool that is not a failure, it is a wait for a connection
   * that only frees when the transaction it is nested in finishes — which is
   * waiting on itself. Making the parameter explicit means a caller has to name
   * its executor, so the nesting cannot reappear by omission.
   */
  async assertSalaryReceiverNotArchived(
    db: DatabaseService['db'] | DrizzleTx,
    receiverId: string | null,
  ): Promise<void> {
    if (!receiverId) return
    const receiver = await db.query.users.findFirst({ where: eq(users.id, receiverId) })
    if (receiver && receiver.archivedAt) {
      throw apiError('FINANCE_SALARY_PAYOUT_RECEIVER_ARCHIVED', HttpStatus.BAD_REQUEST)
    }
  }

  /**
   * The same refusal as `assertSalaryReceiverNotArchived`, expressed as a
   * predicate that lives INSIDE the write statement.
   *
   * security-review round 2 (MED-3): the up-front gate alone is a TOCTOU
   * window — the receiver is read before the transaction opens, and an archive
   * committing in between would let the salary go out to a dismissed employee.
   * That window is not microscopic: between the pre-read and the write sit the
   * receipt validation, the amount checks, opening the transaction and WAITING
   * on the company-account advisory lock (i.e. possibly behind another payment).
   * This file already answered the same argument once — PR #456 (MED-1) refused
   * to trust a pre-read for `deleted_at` and moved the condition into the write.
   * Same move here, and it fails CLOSED.
   *
   * WHAT THIS DOES AND DOES NOT GUARANTEE (round 3 — the earlier wording claimed
   * "no instant between check and write", which is half a step stronger than the
   * mechanics, and this PR is the wrong place to leave an absolute that is
   * subtly false). The correlated sub-query reads `users` under the statement's
   * own snapshot; Postgres's re-check-on-lock (EvalPlanQual) applies to the
   * LOCKED row — the `transactions` row — not to `users`. So an archive that
   * commits DURING this UPDATE is not seen by the sub-query. The window
   * therefore shrinks from "several awaits plus a lock wait" to "the duration of
   * one statement", which is the real gain; it does not become zero.
   *
   * Why no row lock on the receiver. `FOR KEY SHARE` — the obvious candidate —
   * does NOT help: measured on Postgres 15, a holder taking `FOR KEY SHARE` on
   * the users row does not block `UPDATE users SET archived_at = now()`, because
   * that UPDATE touches no key column and so takes FOR NO KEY UPDATE, which
   * `FOR KEY SHARE` does not conflict with. `FOR SHARE` and `FOR UPDATE` do
   * block it (also measured). We deliberately take neither:
   *   - it would only cover this path. The ADMIN_PERSONAL flip below runs in NO
   *     transaction by design (nothing to serialise — the company balance is not
   *     touched), and its write already IS a single statement; adding a lock
   *     there means wrapping it in a transaction and changing that contract.
   *   - `FOR SHARE` on a `users` row makes paying a salary serialise against
   *     every ordinary write to that person's row — a display-name edit, an
   *     avatar, a salary-figure change — for as long as this transaction holds,
   *     advisory-lock wait included.
   *   - the residual exposure is qualitatively unlike the bug being fixed:
   *     settling an accrual that already existed before the dismissal (a row an
   *     ADMIN can soft-delete), versus the original defect, which minted a FRESH
   *     accrual every month and left it silently payable forever.
   * The durable fix belongs at the other end — voiding PENDING salaries when a
   * user is archived, in `UsersService.archive`. That is a different zone and a
   * separate task (backlog 88 follow-up), deliberately not smuggled in here.
   *
   * `NOT EXISTS (SELECT id FROM users WHERE users.id = transactions.receiver_id
   * AND users.archived_at IS NOT NULL)` — note this is TRUE when the receiver
   * row is missing entirely, which matches the up-front gate (an absent user is
   * not an archived one) instead of silently blocking the payment.
   *
   * Built with Drizzle's client-less `QueryBuilder`, NOT `this.db.db.select`:
   * this method only assembles SQL (the enclosing UPDATE is what executes it),
   * so it has no business needing a connection. The first version did go through
   * `this.db.db`, and the cost showed up immediately — every existing unit spec
   * that reaches `paySalary` suddenly had to stub `select` or die with
   * `this.db.db.select is not a function` (transactions.finance-audit.spec.ts
   * did, caught by the pre-push suite). A predicate builder that radiates stub
   * requirements into unrelated specs is the wrong shape.
   */
  salaryReceiverNotArchivedFilter() {
    return notExists(
      new QueryBuilder()
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, transactions.receiverId), isNotNull(users.archivedAt))),
    )
  }

  // task-salary-month-gap-and-status (E-5): the two resolvers below are the
  // ONLY definition of "who does the monthly cron accrue a SALARY to, and how
  // much". Extracted (2026-08) out of `createMonthlySalaries` itself so the
  // gap report / backfill (`resolveSalaryMonthGap`, further down) share the
  // EXACT SAME query — not a hand-duplicated read that could silently drift
  // from what the cron actually does. Read-only; the insert + idempotency
  // (unique index + ON CONFLICT DO NOTHING) stays in `createMonthlySalaries`,
  // the only writer.

  /**
   * HR / ACCOUNTANT eligible for this month's salary — unconditional on
   * `monthlySalary` being set, same as the cron always was.
   *
   * task-finance-fix-wave1 (E-1): the `archivedAt` term is NOT decoration —
   * without it a DISMISSED employee kept being paid. `UsersService.archive`
   * does exactly one thing for these two roles beyond stamping `archivedAt`:
   * it sets `leftAt` on their `team_members` rows. It does NOT zero
   * `monthlySalary` and does NOT change the role — so a role-only SELECT went
   * on matching them forever, the `if (!emp.monthlySalary) continue` guard
   * below waved them through, and the partial unique index only dedupes
   * WITHIN one month, so every following month produced a fresh PENDING
   * salary. Those rows are not hidden anywhere in the UI either: paying one
   * was an ordinary ADMIN click on the finance page.
   *
   * The filter belongs in the QUERY, not in the loop below: the loop's only
   * guard is about a MISSING salary figure, and a reader adding the next
   * condition there would have no reason to suspect archival is handled
   * elsewhere. (The JUNIOR resolver needs no equivalent QUERY term — it
   * selects through `projectMembers` with `isNull(projectMembers.leftAt)`,
   * and archiving a junior sets that `leftAt`. See that resolver's comment.)
   */
  async resolveHrAccountantSalaryReceivers(): Promise<
    Array<{
      id: string
      email: string
      displayName: string
      role: 'HR' | 'ACCOUNTANT'
      monthlySalary: string
    }>
  > {
    const employees = await this.db.db.query.users.findMany({
      where: and(or(eq(users.role, 'HR'), eq(users.role, 'ACCOUNTANT')), isNull(users.archivedAt)),
    })

    const receivers: Array<{
      id: string
      email: string
      displayName: string
      role: 'HR' | 'ACCOUNTANT'
      monthlySalary: string
    }> = []
    for (const emp of employees) {
      if (!emp.monthlySalary) continue
      receivers.push({
        id: emp.id,
        email: emp.email,
        displayName: emp.displayName,
        role: emp.role as 'HR' | 'ACCOUNTANT',
        monthlySalary: emp.monthlySalary,
      })
    }
    return receivers
  }

  /**
   * JUNIORs on an active project membership — salary = project override ??
   * user default.
   *
   * task-salary-company-account: the LOCKED-until-validated-income mechanic is
   * GONE — juniors always get a PENDING salary regardless of whether the
   * project's senior/drop income has been validated yet. (The
   * unlockJuniorSalaryForProject method + its callers were removed.)
   *
   * task-finance-fix-wave1 (E-1), round-2 correction (MED-1). The first
   * version of this fix left the JUNIOR branch alone, reasoning that
   * archiving a junior sets `leftAt` on their memberships and
   * `isNull(projectMembers.leftAt)` below therefore excludes them. A reviewer
   * showed that holds only AT THE MOMENT of archiving: `ProjectsService`
   * re-opens a membership (`leftAt = null`) when someone is added to a
   * project, without consulting `archivedAt` — so an archived junior can be
   * re-attached and start collecting monthly salaries again. `leftAt` tracks
   * PROJECT membership; `archivedAt` tracks EMPLOYMENT. They are not
   * interchangeable, and the salary decision belongs to the second one.
   *
   * The archival term sits in the LOOP here, not in the query as it does for
   * HR/ACCOUNTANT, for a mechanical reason: this query selects
   * `project_members` and reaches the person through a `with: { user }`
   * relation, and Drizzle's relational API cannot filter parent rows by a
   * related table's column. The loop below is already where every USER-level
   * condition is applied (`user.role !== 'JUNIOR'`), so the check is next to
   * its siblings rather than in a place a reader would not look.
   *
   * Not fixed here (deliberately, different zone + PR #541, since merged): the
   * re-attach itself in `ProjectsService.addMember`. Tracked separately.
   *
   * security-review round 3 (SR-H-1, task-project-draft-status): same shape
   * of gap, one door over. `ProjectsService.addMember` does not gate on
   * `project.status` either — a JUNIOR can be seated on a DRAFT (or
   * REJECTED) project, and until this check existed this resolver minted
   * them a fresh PENDING salary every month regardless, bypassing
   * `assertProjectActive` entirely (that guard only sits on the 4
   * income-CREATION entry points in this file — the salary cron is a 5th
   * door with no fetch+check call site to fuse it into). Per the SAME
   * precedent as the archival check three paragraphs up: the fix belongs in
   * THIS resolver's loop, not in `addMember` — Drizzle's relational API
   * cannot filter `project_members` parent rows by the related `project`'s
   * `status` column either, so the check joins its sibling `user.archivedAt`
   * check below rather than living in the query. `project.status` is read
   * off the SAME already-fetched `with: { project }` relation this resolver
   * already loads — no extra query.
   */
  async resolveJuniorSalaryReceivers(): Promise<
    Array<{
      id: string
      email: string
      displayName: string
      monthlySalary: string
      projectId: string
      projectName: string
    }>
  > {
    const activeMembers = await this.db.db.query.projectMembers.findMany({
      where: isNull(projectMembers.leftAt),
      with: {
        user: true,
        project: { with: { financeSettings: true } },
      },
    })

    const receivers: Array<{
      id: string
      email: string
      displayName: string
      monthlySalary: string
      projectId: string
      projectName: string
    }> = []
    // security-review MED-2: a junior on MULTIPLE active projects used to
    // push ONE receiver entry PER MEMBERSHIP, each carrying the FULL resolved
    // amount — harmless for `createMonthlySalaries`'s actual INSERT loop
    // (the unique index + ON CONFLICT DO NOTHING already lets only the FIRST
    // attempt for a given receiver+month succeed, so the real DB state was
    // never double-booked), but the E-5 gap report SUMS `expectedAmount`
    // across every entry it is handed — a junior on 2 projects inflated the
    // reported total by their FULL salary a second time (measured on real
    // data: +21%). Track which receivers already have an entry and skip
    // their later memberships — preserving the SAME "first membership in
    // iteration order wins" semantics the DB constraint already enforces for
    // actual inserts, so this list and what the cron would actually WRITE
    // agree on both WHO and HOW MUCH.
    const seenReceiverIds = new Set<string>()
    for (const member of activeMembers) {
      const user = (member as typeof member & { user: typeof users.$inferSelect | null }).user
      const project = (
        member as typeof member & {
          project:
            | (typeof projects.$inferSelect & {
                financeSettings: typeof projectFinanceSettings.$inferSelect | null
              })
            | null
        }
      ).project

      // `user.archivedAt` — see the method comment: a dismissed junior whose
      // membership was re-opened must not be accrued a new salary.
      if (!user || user.role !== 'JUNIOR' || user.archivedAt || !project) continue
      // SR-H-1 — see the method comment: a DRAFT (never agreed) or REJECTED
      // (explicitly declined) project must not mint money, same Д2 rule
      // `assertProjectActive` enforces on the 4 income-creation entry
      // points. `project.status` comes off the relation already loaded
      // above — no extra fetch.
      if (project.status !== 'ACTIVE') continue
      if (seenReceiverIds.has(user.id)) continue

      // Resolve salary: project override → user default
      const salaryAmount = project.financeSettings?.juniorSalaryOverride ?? user.monthlySalary
      if (!salaryAmount) continue

      seenReceiverIds.add(user.id)
      receivers.push({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        monthlySalary: String(salaryAmount),
        projectId: project.id,
        projectName: project.name,
      })
    }
    return receivers
  }

  /**
   * task-salary-month-gap-and-status (E-5) — «who was the cron supposed to
   * accrue this month, and didn't». Pure read: resolves the SAME two
   * populations `createMonthlySalaries` targets (see the resolvers above),
   * then subtracts whoever already has an automatic/legacy salary component
   * or a durable initialization marker for `month`.
   * No RBAC here — both public callers below gate first, this is shared,
   * unauthenticated-by-itself plumbing.
   */
  async resolveSalaryMonthGap(month: string): Promise<SalaryMonthGapReportDto> {
    const [hrAccountant, juniors] = await Promise.all([
      this.resolveHrAccountantSalaryReceivers(),
      this.resolveJuniorSalaryReceivers(),
    ])

    const expected: SalaryMonthGapReceiverDto[] = [
      ...hrAccountant.map((r) => ({
        userId: r.id,
        displayName: r.displayName,
        role: r.role,
        expectedAmount: Number(r.monthlySalary),
        projectId: null,
        projectName: null,
      })),
      ...juniors.map((r) => ({
        userId: r.id,
        displayName: r.displayName,
        role: 'JUNIOR' as const,
        expectedAmount: Number(r.monthlySalary),
        projectId: r.projectId,
        projectName: r.projectName,
      })),
    ]

    if (expected.length === 0) return { month, missing: [] }

    // A manual salary part is intentionally NOT evidence that cron has run:
    // manual and automatic parts may coexist. Markers are authoritative after
    // this feature ships. Legacy rows (salary_origin IS NULL) and existing CRON
    // rows are also accepted so the first post-upgrade gap check/backfill does
    // not falsely advertise an already-accrued salary. Raw transactions are
    // deliberate here: a soft-deleted automatic component must not be
    // resurrected by backfill.
    const receiverIds = expected.map((r) => r.userId)
    const [markers, automaticRows] = await Promise.all([
      this.db.db
        .select({ receiverId: salaryMonthInitializations.receiverId })
        .from(salaryMonthInitializations)
        .where(
          and(
            eq(salaryMonthInitializations.salaryMonth, month),
            inArray(salaryMonthInitializations.receiverId, receiverIds),
          ),
        ),
      this.db.db
        .select({ receiverId: transactions.receiverId })
        .from(transactions)
        .where(
          and(
            eq(transactions.type, 'SALARY'),
            eq(transactions.salaryMonth, month),
            inArray(transactions.receiverId, receiverIds),
            or(isNull(transactions.salaryOrigin), eq(transactions.salaryOrigin, 'CRON')),
          ),
        ),
    ])
    const existingReceiverIds = new Set([
      ...markers.map((r) => r.receiverId),
      ...automaticRows.map((r) => r.receiverId),
    ])

    return {
      month,
      missing: expected.filter((r) => !existingReceiverIds.has(r.userId)),
    }
  }

  /** GET /api/finance/salary-month-gap — ADMIN + ACCOUNTANT only. */
  async getSalaryMonthGapReport(
    currentUser: SessionUser,
    month?: string,
  ): Promise<SalaryMonthGapReportDto> {
    if (currentUser.role !== 'ADMIN' && currentUser.role !== 'ACCOUNTANT') {
      throw apiError('FINANCE_SALARY_MONTH_GAP_FORBIDDEN', HttpStatus.FORBIDDEN)
    }
    // security-review HIGH-2: default to the PREVIOUS calendar month — the
    // one `createMonthlySalaries` last targeted — NOT the current month
    // (which the cron never touches; see salary-month.util.ts). Shares the
    // EXACT resolver `SalaryCronService` uses so the two can never drift.
    const targetMonth = month ?? previousSalaryMonthKey()
    return this.resolveSalaryMonthGap(targetMonth)
  }
}
