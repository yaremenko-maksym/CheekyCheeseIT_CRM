import { ForbiddenException, HttpStatus, Inject, Injectable, forwardRef } from '@nestjs/common'
import { and, eq, inArray, isNull, ne } from 'drizzle-orm'
import { markSeniorDirty } from '../job-sourcing/dirty-producers'
import type { ArchiveImpact, ArchivePendingTransaction, SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import {
  projectMembers,
  projects,
  teamMembers,
  teams,
  transactions,
  users,
  type User,
} from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { TeamAuditLogService } from '../teams/team-audit-log.service'
import { TeamsService } from '../teams/teams.service'
import { ProjectAuditLogService } from '../projects/project-audit-log.service'
import { AuditLogService } from './audit-log.service'
import { loadUserById } from './user-read.util'

@Injectable()
export class UserArchiveService {
  constructor(
    private db: DatabaseService,
    @Inject(forwardRef(() => TeamAuditLogService))
    private teamAuditLogService: TeamAuditLogService,
    @Inject(forwardRef(() => ProjectAuditLogService))
    private projectAuditLogService: ProjectAuditLogService,
    private auditLogService: AuditLogService,
    @Inject(forwardRef(() => TeamsService))
    private teamsService: TeamsService,
  ) {}

  /**
   * Soft-archive a user with role-specific cascade:
   *  - SENIOR: paired with their team — archives team + active projects + sets leftAt
   *    for HR/Acc team_members (but NOT for senior's own team_member row).
   *  - HR/ACCOUNTANT: sets leftAt for their team memberships.
   *  - JUNIOR: sets leftAt for their project memberships (and any team_members).
   *  - ADMIN: just the user row.
   * Audit log entries written to user_audit_log + team_audit_log + project_audit_log.
   * All mutations in one transaction — any throw rolls back the whole cascade.
   *
   * @param id user id
   * @param actorId admin who triggered archive (for audit log)
   */
  async archive(id: string, actorId: string | null = null): Promise<User> {
    return this.db.db.transaction(async (tx) => {
      // security-review PR #584 round 2 (MED-4): SELECT ... FOR UPDATE locks
      // this row for the lifetime of the transaction. Without it, two
      // concurrent archive requests for the same user both read
      // `archivedAt: null` under READ COMMITTED, both pass the check below,
      // and both run the cascade — duplicate audit-trail rows and
      // timestamp drift (no money moves, no privilege is gained, but the
      // audit trail lies about how many times this happened). The second
      // concurrent caller now blocks here until the first commits, then
      // re-reads `archivedAt` already set and hits the throw below instead.
      const user = await tx
        .select()
        .from(users)
        .where(eq(users.id, id))
        .for('update')
        .then((rows) => rows[0])
      if (!user) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
      if (user.archivedAt) throw apiError('USER_ALREADY_ARCHIVED', HttpStatus.BAD_REQUEST)
      // Defense-in-depth: ADMIN cannot archive another ADMIN. The controller
      // already blocks self-archive; this guard makes ADMINs mutually
      // indestructible regardless of how the endpoint is called.
      if (user.role === 'ADMIN' && actorId !== null && user.id !== actorId) {
        throw apiError('CANNOT_ARCHIVE_ANOTHER_ADMIN', HttpStatus.FORBIDDEN)
      }

      const now = new Date()

      await tx.update(users).set({ archivedAt: now, updatedAt: now }).where(eq(users.id, id))
      await markSeniorDirty(tx, id, 'senior.archive')

      if (user.role === 'SENIOR') {
        // Pair-archive: senior's team + projects. SENIOR's own team_member row is NOT touched.
        //
        // task-archive-pending-modal (AC7/AC9, owner decision 2026-08-19):
        // archiving the team/projects here must NOT touch anyone ELSE's
        // membership — HR/ACCOUNTANT on the team, JUNIOR on the projects stay
        // exactly as they were. `archivedAt` on a TEAM/PROJECT is not the same
        // thing as `archivedAt` on a PERSON: the salary cron
        // (`TransactionsService.createMonthlySalaries`) decides whether to
        // accrue a JUNIOR/HR/ACCOUNTANT their next PENDING salary by reading
        // ONLY their own `users.archivedAt` — never `projects.archivedAt` or
        // `teams.archivedAt` — so leaving `leftAt` untouched here is exactly
        // what keeps their pay flowing, not an oversight. An earlier revision
        // of this cascade DID set `leftAt` on both (see git history) — that
        // was a deliberate removal, not a regression.
        const seniorMembership = await tx
          .select()
          .from(teamMembers)
          .where(and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)))
          .then((rows) => rows[0])
        if (seniorMembership) {
          const teamId = seniorMembership.teamId
          await tx
            .update(teams)
            .set({ archivedAt: now, updatedAt: now })
            .where(eq(teams.id, teamId))
          await this.teamAuditLogService.record(
            {
              actorId,
              targetId: teamId,
              action: 'team_archived',
              changes: { archivedAt: { before: null, after: now.toISOString() } },
            },
            tx,
          )
        }

        // Archive all of senior's active projects. JUNIOR project_members are
        // left untouched — see the AC9 note above.
        const ownedProjects = await tx
          .select()
          .from(projects)
          .where(and(eq(projects.seniorId, id), isNull(projects.archivedAt)))

        for (const p of ownedProjects) {
          await tx
            .update(projects)
            .set({ archivedAt: now, updatedAt: now })
            .where(eq(projects.id, p.id))
          await this.projectAuditLogService.record(
            {
              actorId,
              targetId: p.id,
              action: 'project_archived',
              changes: { archivedAt: { before: null, after: now.toISOString() } },
            },
            tx,
          )
        }
      } else if (user.role === 'HR' || user.role === 'ACCOUNTANT') {
        // Set leftAt across all team memberships.
        const memberships = await tx
          .select({ id: teamMembers.id, teamId: teamMembers.teamId })
          .from(teamMembers)
          .where(and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)))
        if (memberships.length > 0) {
          await tx
            .update(teamMembers)
            .set({ leftAt: now })
            .where(and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)))
          for (const m of memberships) {
            await this.teamAuditLogService.record(
              {
                actorId,
                targetId: m.teamId,
                action: 'team_member_removed',
                changes: {
                  userId: { before: id, after: null },
                  role: { before: user.role, after: null },
                },
              },
              tx,
            )
          }
        }
      } else if (user.role === 'JUNIOR') {
        // Detach JUNIOR from all active project memberships.
        // NB: JUNIOR is never persisted in `team_members` — team membership for
        // JUNIORs is derived state (project membership ⇒ implicit team), see
        // CLAUDE.md §Teams. So we deliberately do NOT update team_members here.
        const projectMemberships = await tx
          .select({ id: projectMembers.id, projectId: projectMembers.projectId })
          .from(projectMembers)
          .where(and(eq(projectMembers.userId, id), isNull(projectMembers.leftAt)))
        if (projectMemberships.length > 0) {
          await tx
            .update(projectMembers)
            .set({ leftAt: now })
            .where(and(eq(projectMembers.userId, id), isNull(projectMembers.leftAt)))
          for (const pm of projectMemberships) {
            await this.projectAuditLogService.record(
              {
                actorId,
                targetId: pm.projectId,
                action: 'project_member_removed',
                changes: { userId: { before: id, after: null } },
              },
              tx,
            )
          }
        }
      } else if (user.role === 'DROP') {
        // Drop role - phase 1: pair-archive drop + drop-team + drop-projects.
        // Active SENIOR (if any) is detached but NOT archived. Delegated to
        // TeamsService.archiveDropTeam inside the same transaction.
        const dropMembership = await tx
          .select()
          .from(teamMembers)
          .where(and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)))
          .then((rows) => rows[0])
        if (dropMembership) {
          await this.teamsService.archiveDropTeam(dropMembership.teamId, tx)
          await this.teamAuditLogService.record(
            {
              actorId,
              targetId: dropMembership.teamId,
              action: 'team_archived',
              changes: { archivedAt: { before: null, after: now.toISOString() } },
            },
            tx,
          )
        }
      }
      // ADMIN: no dependencies.

      // Final user_audit_log entry.
      await this.auditLogService.record(
        {
          actorId,
          targetId: id,
          action: 'user_archived',
          changes: { archivedAt: { before: null, after: now.toISOString() } },
        },
        tx,
      )

      const updated = await tx
        .select()
        .from(users)
        .where(eq(users.id, id))
        .then((rows) => rows[0])
      // Stryker disable next-line ConditionalExpression: task-i18n-stage4-task1
      // mutation-gate finding — provably unreachable, not merely untested.
      // The guard at the top of this same transaction (`if (!user) throw ...`,
      // under a `FOR UPDATE` lock) already confirmed this row exists, and the
      // `tx.update(users)...` a few lines up wrote to that same locked row and
      // has not committed. No peer transaction can delete a row this one
      // holds locked, and this method issues no DELETE of its own, so between
      // that write and this re-read the row cannot have vanished — a unit
      // mock could only "kill" this mutant by asserting a scenario Postgres
      // itself rules out.
      if (!updated) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
      return updated
    })
  }

  /**
   * Restore an archived user. SENIOR restoration is paired with their team —
   * projects remain archived; HR/Acc team_members.leftAt is NOT restored.
   * For HR/Acc/Junior/Admin — only the user row is restored, memberships stay closed.
   */
  async unarchive(id: string, actorId: string | null = null): Promise<User> {
    return this.db.db.transaction(async (tx) => {
      await this.unarchivePairTx(tx, id, actorId)
      const updated = await tx
        .select()
        .from(users)
        .where(eq(users.id, id))
        .then((rows) => rows[0])
      // Stryker disable next-line ConditionalExpression: task-i18n-stage4-task1
      // mutation-gate finding — provably unreachable, not merely untested.
      // `unarchivePairTx` just above already confirmed this row exists (its
      // own `if (!user) throw ...`) and issued a `tx.update(users)...` write
      // to it within this SAME still-open transaction — an implicit row lock
      // that holds until commit. No peer transaction can delete a row this
      // one holds locked, and neither this method nor `unarchivePairTx`
      // issues a DELETE, so between that write and this re-read the row
      // cannot have vanished — a unit mock could only "kill" this mutant by
      // asserting a scenario Postgres itself rules out.
      if (!updated) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
      return updated
    })
  }

  /**
   * Pair-unarchive primitive that runs ENTIRELY within the caller's transaction.
   * Used by:
   *   - `UsersService.unarchive()` — wraps this in its own tx
   *   - `ProjectsService.unarchive(cascade=true)` — passes its outer tx so the
   *     project unarchive + senior/team unarchive commit atomically (no nested
   *     transactions, no orphaned state if the outer flow throws).
   *
   * IMPORTANT: All mutations and audit log writes use the supplied `tx` — never
   * `this.db.db` — so rollback discards everything together. Caller is
   * responsible for opening the transaction.
   */
  async unarchivePairTx(tx: DrizzleTx, id: string, actorId: string | null = null): Promise<void> {
    const user = await tx
      .select()
      .from(users)
      .where(eq(users.id, id))
      .then((rows) => rows[0])
    if (!user) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
    if (!user.archivedAt) throw apiError('USER_NOT_ARCHIVED', HttpStatus.BAD_REQUEST)

    const now = new Date()
    const previousArchivedAt = user.archivedAt

    await tx.update(users).set({ archivedAt: null, updatedAt: now }).where(eq(users.id, id))
    await markSeniorDirty(tx, id, 'senior.unarchive')

    await this.auditLogService.record(
      {
        actorId,
        targetId: id,
        action: 'user_unarchived',
        // Stryker disable next-line OptionalChaining: equivalent mutant — `user.archivedAt` was
        // checked non-null a few lines up (`USER_NOT_ARCHIVED` throw), so `previousArchivedAt`
        // can never be nullish here and `?.` vs `.` is unobservable.
        changes: { archivedAt: { before: previousArchivedAt?.toISOString() ?? null, after: null } },
      },
      tx,
    )

    if (user.role === 'SENIOR') {
      // Pair-unarchive: also unarchive the team via senior's team_member row.
      // We require `leftAt IS NULL` because senior's own membership is the
      // permanent identity link and stays active even while archived. A row
      // with `leftAt != NULL` would be stale data we shouldn't follow.
      const seniorMembership = await tx
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)))
        .then((rows) => rows[0])
      if (seniorMembership) {
        const team = await tx
          .select()
          .from(teams)
          .where(eq(teams.id, seniorMembership.teamId))
          .then((rows) => rows[0])
        if (team?.archivedAt) {
          const teamPreviousArchivedAt = team.archivedAt
          await tx
            .update(teams)
            .set({ archivedAt: null, updatedAt: now })
            .where(eq(teams.id, team.id))
          await this.teamAuditLogService.record(
            {
              actorId,
              targetId: team.id,
              action: 'team_unarchived',
              changes: {
                archivedAt: { before: teamPreviousArchivedAt.toISOString(), after: null },
              },
            },
            tx,
          )
        }
      }
      // Projects intentionally stay archived (admin re-unarchives them
      // separately, with cascade if needed — see ProjectsService.unarchive).
      // HR/ACCOUNTANT team_members.leftAt was never touched by archive() in
      // the first place (task-archive-pending-modal AC9) — nothing to restore.
    }
  }

  /**
   * task-archive-pending-modal (AC2). Earned-but-unpaid rows addressed to this
   * user that will survive the archive — scope matches AC1 exactly (SALARY /
   * SENIOR_INCOME / DROP_INCOME, `status='PENDING'`). Deliberately excludes
   * the `*_PENDING_PAYMENT` obligation rows — those were never blocked from an
   * archived receiver (AC4), so there is nothing new to warn about there.
   */
  private async getPendingTransactionsForArchiveWarning(
    userId: string,
  ): Promise<ArchivePendingTransaction[]> {
    const rows = await this.db.db
      .select({
        id: transactions.id,
        type: transactions.type,
        salaryMonth: transactions.salaryMonth,
        txDate: transactions.txDate,
        amount: transactions.amount,
        currency: transactions.currency,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.receiverId, userId),
          eq(transactions.status, 'PENDING'),
          inArray(transactions.type, ['SALARY', 'SENIOR_INCOME', 'DROP_INCOME']),
          isNull(transactions.deletedAt),
        ),
      )
    return rows as ArchivePendingTransaction[]
  }

  /**
   * Returns the cascade impact summary the UI shows before the admin confirms archive.
   * Shape varies by role — see ArchiveImpact union in @crm/shared.
   */
  async getArchiveImpact(id: string, currentUser: SessionUser): Promise<ArchiveImpact> {
    // security-review PR #584 (round 2, MED-2): this payload now carries
    // salary/income sums (`pendingTransactions`) — mirror the inline RBAC
    // TeamsService/ProjectsService.getArchiveImpact already do, so
    // enforcement on the money-bearing path isn't single-point (controller
    // @Roles only).
    if (currentUser.role !== 'ADMIN') throw new ForbiddenException()
    const user = await loadUserById(this.db.db, id)
    if (!user) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)

    const pendingTransactions = await this.getPendingTransactionsForArchiveWarning(id)

    if (user.role === 'SENIOR') {
      // Find senior's team via team_members.
      const seniorMembership = await this.db.db.query.teamMembers.findFirst({
        where: and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)),
      })
      let teamName: string | null = null
      let hrAccountantsOnTeam = 0
      if (seniorMembership) {
        const team = await this.db.db.query.teams.findFirst({
          where: eq(teams.id, seniorMembership.teamId),
        })
        teamName = team?.name ?? null
        const others = await this.db.db
          .select({ userId: teamMembers.userId })
          .from(teamMembers)
          .where(
            and(
              eq(teamMembers.teamId, seniorMembership.teamId),
              isNull(teamMembers.leftAt),
              ne(teamMembers.userId, id),
            ),
          )
        hrAccountantsOnTeam = others.length
      }
      const seniorProjects = await this.db.db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(and(eq(projects.seniorId, id), isNull(projects.archivedAt)))
      const projectIds = seniorProjects.map((p) => p.id)
      let juniorsAffected = 0
      if (projectIds.length > 0) {
        const activeJuniors = await this.db.db
          .select({ userId: projectMembers.userId })
          .from(projectMembers)
          .where(and(inArray(projectMembers.projectId, projectIds), isNull(projectMembers.leftAt)))
        juniorsAffected = activeJuniors.length
      }
      return {
        type: 'user',
        role: 'SENIOR',
        isPaired: true,
        teamName,
        projectsCount: seniorProjects.length,
        projectNames: seniorProjects.map((p) => p.name),
        juniorsAffected,
        hrAccountantsOnTeam,
        pendingTransactions,
      }
    }

    if (user.role === 'HR' || user.role === 'ACCOUNTANT') {
      const memberships = await this.db.db
        .select({ teamId: teamMembers.teamId })
        .from(teamMembers)
        .where(and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)))
      return { type: 'user', role: user.role, teamsCount: memberships.length, pendingTransactions }
    }

    if (user.role === 'JUNIOR') {
      const memberships = await this.db.db
        .select({ projectId: projectMembers.projectId })
        .from(projectMembers)
        .where(and(eq(projectMembers.userId, id), isNull(projectMembers.leftAt)))
      return {
        type: 'user',
        role: 'JUNIOR',
        projectsCount: memberships.length,
        pendingTransactions,
      }
    }

    if (user.role === 'DROP') {
      // Drop role - phase 1: archive impact mirrors SENIOR pair behavior.
      // teamName + projectsCount come from the drop's team + drop-projects.
      const dropMembership = await this.db.db.query.teamMembers.findFirst({
        where: and(eq(teamMembers.userId, id), isNull(teamMembers.leftAt)),
      })
      let teamName: string | null = null
      let hrAccountantsOnTeam = 0
      if (dropMembership) {
        const team = await this.db.db.query.teams.findFirst({
          where: eq(teams.id, dropMembership.teamId),
        })
        teamName = team?.name ?? null
        const others = await this.db.db
          .select({ userId: teamMembers.userId })
          .from(teamMembers)
          .where(
            and(
              eq(teamMembers.teamId, dropMembership.teamId),
              isNull(teamMembers.leftAt),
              ne(teamMembers.userId, id),
            ),
          )
        hrAccountantsOnTeam = others.length
      }
      const dropProjects = await this.db.db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(and(eq(projects.dropId, id), isNull(projects.archivedAt)))
      const dropProjectIds = dropProjects.map((p) => p.id)
      let juniorsAffected = 0
      if (dropProjectIds.length > 0) {
        const activeJuniors = await this.db.db
          .select({ userId: projectMembers.userId })
          .from(projectMembers)
          .where(
            and(inArray(projectMembers.projectId, dropProjectIds), isNull(projectMembers.leftAt)),
          )
        juniorsAffected = activeJuniors.length
      }
      return {
        type: 'user',
        role: 'DROP',
        isPaired: true,
        teamName,
        projectsCount: dropProjects.length,
        projectNames: dropProjects.map((p) => p.name),
        juniorsAffected,
        hrAccountantsOnTeam,
        pendingTransactions,
      }
    }

    // ADMIN
    return { type: 'user', role: 'ADMIN', noDependencies: true, pendingTransactions }
  }

  /**
   * Soft-archive a DROP user with the full cascade:
   *  - Drop-team → archived (HR/Accountant detached).
   *  - Drop-projects → archived (project_members.leftAt set).
   *  - Active SENIOR (if any) → DETACHED from team_members but user row
   *    stays active. Becomes "teamless"; controller layer guards their
   *    sensitive endpoints (interviews → 403, projects → empty).
   *
   * Returns `{ archivedProjects, detachedSeniorId }` for UI confirmation.
   * RBAC: ADMIN only (enforced in controller; defensive guard here).
   */
  async archiveDrop(
    dropId: string,
    actor: SessionUser,
  ): Promise<{ archivedProjects: number; detachedSeniorId: string | null }> {
    if (actor.role !== 'ADMIN') {
      throw apiError('DROP_ARCHIVE_ADMIN_ONLY', HttpStatus.FORBIDDEN)
    }
    // security-review round 2 (authz-hardening) — see createDrop's identical
    // comment above for the full rationale.
    const effectiveActorId = actor.impersonatorId ?? actor.id
    return this.db.db.transaction(async (tx) => {
      // security-review PR #584 round 2 (MED-4): same row-lock rationale as
      // `archive()` above — prevents two concurrent DELETE /users/drops/:id
      // calls on the same drop from both passing the archivedAt check and
      // both running archiveDropTeam's cascade.
      const user = await tx
        .select()
        .from(users)
        .where(eq(users.id, dropId))
        .for('update')
        .then((rows) => rows[0])
      if (!user) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
      if (user.role !== 'DROP') {
        throw apiError('METHOD_DROP_ONLY', HttpStatus.BAD_REQUEST)
      }
      if (user.archivedAt) throw apiError('DROP_ARCHIVED', HttpStatus.BAD_REQUEST)

      const dropMembership = await tx
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.userId, dropId), isNull(teamMembers.leftAt)))
        .then((rows) => rows[0])

      let result = { archivedProjects: 0, detachedSeniorId: null as string | null }
      if (dropMembership) {
        result = await this.teamsService.archiveDropTeam(dropMembership.teamId, tx)
      }

      const now = new Date()
      await tx.update(users).set({ archivedAt: now, updatedAt: now }).where(eq(users.id, dropId))

      await this.auditLogService.record(
        {
          actorId: effectiveActorId,
          targetId: dropId,
          action: 'user_archived',
          changes: { archivedAt: { before: null, after: now.toISOString() } },
        },
        tx,
      )

      return result
    })
  }
}
