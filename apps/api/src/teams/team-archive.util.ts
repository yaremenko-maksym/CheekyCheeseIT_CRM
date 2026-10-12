import { ForbiddenException, HttpStatus } from '@nestjs/common'
import { and, eq, isNull } from 'drizzle-orm'
import type { ArchiveImpact, SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import { projects, teamMembers, teams, users } from '../database/schema'
import type { DrizzleTx } from '../database/types'
import type { UsersService } from '../users/users.service'
import type { TeamsDb } from './team-membership-read.util'

/**
 * Collaborators the archive cluster needs from `TeamsService`. Passed per call
 * as closures so the DROP branch still dispatches through
 * `TeamsService.archiveDropTeam` (spied in specs) and the Users<->Teams
 * forwardRef cycle is untouched: this util never injects anything.
 */
export interface TeamArchiveDeps {
  db: TeamsDb
  usersService: Pick<UsersService, 'archive' | 'unarchive' | 'getArchiveImpact'>
  archiveDropTeam: (
    teamId: string,
    tx?: DrizzleTx,
  ) => Promise<{ archivedProjects: number; detachedSeniorId: string | null }>
  findOne: (teamId: string, currentUser: SessionUser) => Promise<unknown>
}

/**
 * Soft-archive a team. By business invariant, archiving the team is equivalent
 * to archiving its SENIOR — the two are inseparable. We delegate to
 * UsersService.archive(team.seniorId) which performs the pair-cascade
 * (archive senior + projects; membership of HR/Acc/Junior is left alone —
 * see task-archive-pending-modal AC9).
 */
export async function archiveTeam(deps: TeamArchiveDeps, teamId: string, currentUser: SessionUser) {
  if (currentUser.role !== 'ADMIN') throw new ForbiddenException()
  const team = await deps.db.query.teams.findFirst({
    where: eq(teams.id, teamId),
    with: { members: { with: { user: true } } },
  })
  if (!team) throw apiError('TEAM_NOT_FOUND', HttpStatus.NOT_FOUND)
  if (team.archivedAt) throw apiError('TEAM_ALREADY_ARCHIVED', HttpStatus.BAD_REQUEST)

  // Drop-archive round 2 (B1): dispatch by team type. Drop-teams use the
  // dedicated `archiveDropTeam` primitive (drop archived + projects
  // cascade + senior detached *without* archiving).
  //
  // task-archive-pending-modal (AC10): `archiveDropTeam` issues several
  // sequential writes (team, projects, the drop's own user row) — calling
  // it bare (no `tx`) meant a failure partway left the DB in whatever state
  // the writes-so-far produced. Wrapping the call in `db.transaction()` is
  // what makes AC7's "одной операцией, а не по одному" true at the
  // database level, not just in the code's shape.
  if (team.type === 'DROP') {
    await deps.db.transaction((tx) => deps.archiveDropTeam(teamId, tx))
    return deps.findOne(teamId, currentUser)
  }

  const seniorMember = team.members.find((m) => m.user?.role === 'SENIOR' && m.leftAt === null)
  if (!seniorMember) {
    throw apiError('TEAM_NO_ACTIVE_SENIOR_FOR_ARCHIVE', HttpStatus.BAD_REQUEST)
  }
  await deps.usersService.archive(seniorMember.userId, currentUser.id)
  return deps.findOne(teamId, currentUser)
}

/**
 * Pair-unarchive: restore SENIOR + team. Projects remain archived;
 * HR/Acc memberships remain closed (admin re-adds via Teams page).
 */
export async function unarchiveTeam(
  deps: TeamArchiveDeps,
  teamId: string,
  currentUser: SessionUser,
) {
  if (currentUser.role !== 'ADMIN') throw new ForbiddenException()
  const team = await deps.db.query.teams.findFirst({
    where: eq(teams.id, teamId),
    with: { members: true },
  })
  if (!team) throw apiError('TEAM_NOT_FOUND', HttpStatus.NOT_FOUND)
  if (!team.archivedAt) throw apiError('TEAM_NOT_ARCHIVED', HttpStatus.BAD_REQUEST)

  // Find SENIOR via team_members + users join — `with: { members: true }`
  // above doesn't include user.role, so we run a focused lookup here.
  // MED-2 (security-review round 2): `isNull(leftAt)` — without it, a
  // team with rotation history (a detached ex-senior row PLUS the current
  // active senior row, both role=SENIOR) has no ORDER BY guarantee on
  // which row `rows[0]` picks. Picking the detached one would silently
  // restore access to the WRONG (possibly still-fired) person instead of
  // the team's actual current senior.
  const seniorRow = await deps.db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(
      and(eq(teamMembers.teamId, teamId), eq(users.role, 'SENIOR'), isNull(teamMembers.leftAt)),
    )
    .then((rows) => rows[0])
  if (!seniorRow) {
    throw apiError('SENIOR_NOT_FOUND', HttpStatus.NOT_FOUND)
  }
  await deps.usersService.unarchive(seniorRow.userId, currentUser.id)
  return deps.findOne(teamId, currentUser)
}

/**
 * Returns the archive impact for the team (pair = senior). UI uses for warnings.
 */
export async function getTeamArchiveImpact(
  deps: TeamArchiveDeps,
  teamId: string,
  currentUser: SessionUser,
): Promise<ArchiveImpact> {
  if (currentUser.role !== 'ADMIN') throw new ForbiddenException()
  const team = await deps.db.query.teams.findFirst({
    where: eq(teams.id, teamId),
  })
  if (!team) throw apiError('TEAM_NOT_FOUND', HttpStatus.NOT_FOUND)

  // Drop-archive round 2 (B2): branch by team type. Drop-teams have a
  // different "paired" entity — the drop (not a senior). UI keys on
  // `teamType` to render the right copy + confirm-input.
  if (team.type === 'DROP') {
    // Resolve the drop owner (paired user for the confirmation text).
    const dropRow = await deps.db
      .select({ id: users.id, displayName: users.displayName })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(
        and(eq(teamMembers.teamId, teamId), eq(users.role, 'DROP'), isNull(teamMembers.leftAt)),
      )
      .then((rows) => rows[0])
    // Active senior (informational only — gets detached without archive).
    const seniorRow = await deps.db
      .select({ id: users.id, displayName: users.displayName })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(
        and(eq(teamMembers.teamId, teamId), eq(users.role, 'SENIOR'), isNull(teamMembers.leftAt)),
      )
      .then((rows) => rows[0])
    // Active HR/Accountant count. task-archive-pending-modal (AC9): these
    // are NOT detached by `archiveDropTeam` any more — they keep their
    // membership and keep earning. Kept as "how many are on this team" for
    // the warning copy. Computed cheaply with a single query excluding the
    // drop + senior rows.
    const others = await deps.db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(and(eq(teamMembers.teamId, teamId), isNull(teamMembers.leftAt), eq(users.role, 'HR')))
    const accountants = await deps.db
      .select({ userId: teamMembers.userId })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          isNull(teamMembers.leftAt),
          eq(users.role, 'ACCOUNTANT'),
        ),
      )
    // Drop-projects count + names (AC8).
    const dropProjects = dropRow
      ? await deps.db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(and(eq(projects.dropId, dropRow.id), isNull(projects.archivedAt)))
      : []
    // task-archive-pending-modal (AC2): the drop's own pending
    // transactions — delegate to UsersService so the rule lives in ONE
    // place. Only reachable when the drop resolved (a team with no active
    // drop member has nothing to forward).
    const dropPendingTransactions = dropRow
      ? await deps.usersService
          .getArchiveImpact(dropRow.id, currentUser)
          .then((i) =>
            i.type === 'user' && i.role === 'DROP' ? (i.pendingTransactions ?? []) : [],
          )
      : []
    return {
      type: 'team',
      isPaired: true,
      teamName: team.name,
      // Keep `seniorName` for legacy clients — empty if no senior attached.
      // The new `dropName` field is what the v2 UI keys on.
      seniorName: seniorRow?.displayName ?? '',
      projectsCount: dropProjects.length,
      projectNames: dropProjects.map((p) => p.name),
      membersAffected: others.length + accountants.length,
      teamType: 'DROP',
      dropName: dropRow?.displayName ?? '',
      seniorWillBeDetached: !!seniorRow,
      pendingTransactions: dropPendingTransactions,
    }
  }

  // SENIOR team — legacy path (unchanged 1:1 from round 1).
  const seniorRow = await deps.db
    .select({ id: users.id, displayName: users.displayName })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(
      and(eq(teamMembers.teamId, teamId), eq(users.role, 'SENIOR'), isNull(teamMembers.leftAt)),
    )
    .then((rows) => rows[0])
  if (!seniorRow) {
    return {
      type: 'team',
      isPaired: true,
      teamName: team.name,
      seniorName: '',
      projectsCount: 0,
      membersAffected: 0,
      teamType: 'SENIOR',
    }
  }
  const userImpact = await deps.usersService.getArchiveImpact(seniorRow.id, currentUser)
  const seniorImpact =
    userImpact.type === 'user' && userImpact.role === 'SENIOR' ? userImpact : null
  return {
    type: 'team',
    isPaired: true,
    teamName: team.name,
    seniorName: seniorRow.displayName,
    projectsCount: seniorImpact?.projectsCount ?? 0,
    // task-archive-pending-modal (AC8/AC2): forwarded 1:1 from the senior's
    // own user-impact — archiving the team IS archiving the senior.
    projectNames: seniorImpact?.projectNames ?? [],
    membersAffected: seniorImpact?.hrAccountantsOnTeam ?? 0,
    teamType: 'SENIOR',
    pendingTransactions: seniorImpact?.pendingTransactions ?? [],
  }
}
