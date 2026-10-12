import { ForbiddenException, HttpStatus } from '@nestjs/common'
import { and, eq, isNull } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import { teamMembers, teams, users } from '../database/schema'
import type { DrizzleTx } from '../database/types'
import type { NotificationsService } from '../notifications/notifications.service'
import { isHrOfTeam } from './team-access.util'
import type { TeamAuditLogService } from './team-audit-log.service'
import type { ProjectWithMembers } from './team-mapping.util'
import type { TeamsDb } from './team-membership-read.util'
import { buildTeamMemberAddedNotifications } from './team-notifications.util'

/**
 * Collaborators the membership-mutation pair needs from `TeamsService`.
 * Passed per call so this util never injects anything and the Users<->Teams
 * forwardRef cycle is untouched.
 */
export interface TeamMembershipDeps {
  db: TeamsDb
  teamAuditLogService: Pick<TeamAuditLogService, 'record'>
  notifications: Pick<NotificationsService, 'emitInTx' | 'createManyInTx'>
  fetchAllProjects: () => Promise<ProjectWithMembers[]>
}

export async function addTeamMember(
  deps: TeamMembershipDeps,
  teamId: string,
  userId: string,
  currentUser: SessionUser,
) {
  if (currentUser.role !== 'ADMIN' && currentUser.role !== 'HR') {
    throw new ForbiddenException()
  }

  const team = await deps.db.query.teams.findFirst({
    where: eq(teams.id, teamId),
    with: { members: { with: { user: true } } },
  })
  if (!team) throw apiError('TEAM_NOT_FOUND', HttpStatus.NOT_FOUND)

  if (currentUser.role === 'HR' && !isHrOfTeam(team, currentUser.id)) {
    throw new ForbiddenException()
  }

  const user = await deps.db.query.users.findFirst({ where: eq(users.id, userId) })
  if (!user) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
  if (user.role === 'ADMIN') throw apiError('TEAM_ADMIN_CANNOT_BE_MEMBER', HttpStatus.BAD_REQUEST)

  // SEC-02 (HIGH) addMember vector: HR adding an arbitrary SENIOR via
  // POST /teams/:id/members is the same BOLA class as the create() vector —
  // HR gains getHrSeniorIds-based scope over a senior they had no prior
  // relationship with. The legitimate way to assign a SENIOR to a team is
  // via POST /api/teams (create, ADMIN-only) or rotateSenior. Restrict
  // SENIOR additions through addMember to ADMIN-only; HR may still add
  // JUNIOR / HR / ACCOUNTANT members (their established recruiting workflow).
  if (user.role === 'SENIOR' && currentUser.role !== 'ADMIN') {
    throw apiError('TEAM_ADD_SENIOR_ADMIN_ONLY', HttpStatus.FORBIDDEN)
  }

  // Prevent adding a second SENIOR
  // MED-2 (security-review round 2, informational — consistency, not a
  // security fix): `leftAt === null` — without it a rotated-out senior's
  // stale row permanently blocks ever adding a new senior to this team
  // (conservative failure, not an access bug), even though the team is
  // legitimately senior-less after rotation. Brought in line with every
  // other SENIOR lookup in this file.
  if (user.role === 'SENIOR') {
    const hasSenior = team.members.some((m) => m.user?.role === 'SENIOR' && m.leftAt === null)
    if (hasSenior) throw apiError('TEAM_ALREADY_HAS_SENIOR', HttpStatus.BAD_REQUEST)
  }

  // Prevent adding a JUNIOR who has an active project
  if (user.role === 'JUNIOR') {
    const allProjects = await deps.fetchAllProjects()
    const hasActiveProject = allProjects.some((p) =>
      p.members.some((m) => m.userId === userId && m.leftAt === null),
    )
    if (hasActiveProject)
      throw apiError('JUNIOR_ALREADY_ON_ANOTHER_PROJECT', HttpStatus.BAD_REQUEST)
  }

  // Re-add semantics after the soft-delete change to removeMember: a removed
  // member leaves a soft-deleted row (leftAt != null). Reject only ACTIVE
  // duplicates; reactivate a soft-deleted row instead of inserting a second
  // one (mirrors UsersService.upsertTeamMemberTx). Without this, re-adding a
  // previously removed member would 400 ("User is already a member").
  //
  // HIGH-1: reactivating a soft-deleted row is intentionally gated by the
  // SAME guard as the rest of this method (:611-613 role check + :619-621
  // isHrOfTeam, now leftAt-filtered) — only ADMIN or an ACTIVE HR of THIS
  // team can ever reach this line. A removed HR calling addMember on
  // themselves (the attack chain this fix closes) is rejected by the
  // isHrOfTeam check above and never gets here.
  const existing = await deps.db.query.teamMembers.findFirst({
    where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)),
  })
  // task-notification-types-producers (позиция 6). Членство и уведомления о
  // нём — ОДНА транзакция: «уведомление о несостоявшемся событии
  // недопустимо», и здесь это не дисциплина, а свойство — откатилось
  // членство, откатились и записи.
  //
  // Обе ветки ниже — свежая вставка и возврат ранее удалённого участника —
  // одинаковы с точки зрения человека: его добавили в команду. Раньше ветка
  // реактивации отличалась только `return`, и уведомление, дописанное лишь в
  // конец метода, тихо пропустило бы половину случаев.
  const notifyInput = {
    teamId,
    teamName: team.name,
    addedUserId: userId,
    addedUserRole: user.role,
    addedUserName: user.displayName,
    members: team.members,
    currentUser,
  }

  // SR-H-2 (security-review круг 2): путь производителя целиком — во
  // ВЛОЖЕННОЙ транзакции (SAVEPOINT), включая отбор получателей. Отбор
  // переехал ВНУТРЬ по той же причине: пока он стоял до транзакции, его
  // падение отменяло само членство — то есть уведомление имело вето над
  // событием ещё до того, как событие случилось.
  const notify = async (tx: DrizzleTx): Promise<void> => {
    await deps.notifications.emitInTx(tx, async (sp) => {
      await deps.notifications.createManyInTx(sp, buildTeamMemberAddedNotifications(notifyInput))
    })
  }

  if (existing) {
    if (existing.leftAt === null) {
      throw apiError('TEAM_USER_ALREADY_MEMBER', HttpStatus.BAD_REQUEST)
    }
    await deps.db.transaction(async (tx) => {
      await tx.update(teamMembers).set({ leftAt: null }).where(eq(teamMembers.id, existing.id))
      await notify(tx)
    })
    return
  }

  await deps.db.transaction(async (tx) => {
    await tx.insert(teamMembers).values({ teamId, userId })
    await notify(tx)
  })
}

export async function removeTeamMember(
  deps: TeamMembershipDeps,
  teamId: string,
  userId: string,
  currentUser: SessionUser,
) {
  if (currentUser.role !== 'ADMIN' && currentUser.role !== 'HR') {
    throw new ForbiddenException()
  }

  const team = await deps.db.query.teams.findFirst({
    where: eq(teams.id, teamId),
    with: { members: { with: { user: true } } },
  })
  if (!team) throw apiError('TEAM_NOT_FOUND', HttpStatus.NOT_FOUND)

  if (currentUser.role === 'HR' && !isHrOfTeam(team, currentUser.id)) {
    throw new ForbiddenException()
  }

  // The `members` relation returns ALL rows including soft-deleted ones
  // (leftAt != null). Since removeMember now soft-deletes, every check below
  // must consider only ACTIVE members — otherwise a previously-removed row
  // would (a) be re-"found" as removable, and (b) inflate the HR/ACCOUNTANT
  // minimum-count guards.
  const activeMembers = team.members.filter((m) => m.leftAt === null)

  const memberToRemove = activeMembers.find((m) => m.userId === userId)
  if (!memberToRemove) throw apiError('TEAM_MEMBER_NOT_FOUND', HttpStatus.NOT_FOUND)

  const removedRole = memberToRemove.user?.role
  if (removedRole === 'SENIOR') {
    throw apiError('TEAM_CANNOT_REMOVE_SENIOR', HttpStatus.BAD_REQUEST)
  }

  if (removedRole === 'HR') {
    const hrCount = activeMembers.filter((m) => m.user?.role === 'HR').length
    if (hrCount <= 1) {
      throw apiError('HR_REQUIRED_MINIMUM_ONE', HttpStatus.BAD_REQUEST)
    }
  }

  if (removedRole === 'ACCOUNTANT') {
    const accountantCount = activeMembers.filter((m) => m.user?.role === 'ACCOUNTANT').length
    if (accountantCount <= 1) {
      throw apiError('TEAM_ACCOUNTANT_REQUIRED_MINIMUM_ONE', HttpStatus.BAD_REQUEST)
    }
  }

  // Soft-delete the membership (set leftAt=now) instead of a physical DELETE,
  // so the row survives for audit/history — consistent with every other exit
  // path (archiveDropTeam, rotateSenior). A physical delete erased the
  // membership entirely and skipped the audit trail (pre-deploy MEDIUM).
  // The audit insert is part of the same transaction: a rollback discards both.
  const now = new Date()
  await deps.db.transaction(async (tx) => {
    await tx
      .update(teamMembers)
      .set({ leftAt: now })
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, userId),
          isNull(teamMembers.leftAt),
        ),
      )
    // security-review round 2 (authz-hardening): attribute to the real
    // operator under impersonation — see sessionUserSchema.impersonatorId's
    // doc for the full rationale.
    await deps.teamAuditLogService.record(
      {
        actorId: currentUser.impersonatorId ?? currentUser.id,
        targetId: teamId,
        action: 'team_member_removed',
        changes: {
          userId: { before: userId, after: null },
          role: { before: removedRole ?? null, after: null },
        },
      },
      tx,
    )
  })
}
