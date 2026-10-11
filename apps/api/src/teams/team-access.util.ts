import { ForbiddenException } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import type { ProjectWithMembers, TeamWithMembers } from './team-mapping.util'

// HIGH-1 (security-audit authz-hardening): `team.members` returns EVERY row,
// including soft-deleted ones (`leftAt != null` — set by removeMember).
// Without the `leftAt === null` filter a member removed from the team keeps
// being recognized as an active HR (or, in assertAccess/findAll below, as
// any active member) for as long as their JWT is valid (up to 7 days) —
// they retain read/write access, can rename the team, remove other members,
// and reactivate their own row via addMember. The DROP branch of
// assertAccess already filtered on `leftAt === null` correctly; this is now
// the norm for every membership check in this file.
export function isHrOfTeam(team: TeamWithMembers, userId: string) {
  return team.members.some((m) => m.userId === userId && m.user?.role === 'HR' && m.leftAt === null)
}

export function assertAccess(
  team: TeamWithMembers,
  currentUser: SessionUser,
  allProjects: ProjectWithMembers[],
) {
  if (currentUser.role === 'ADMIN' || currentUser.role === 'ACCOUNTANT') return

  // Drop role - phase 1 (task-drop-1-backend AC2). EXPLICIT, ACTIVE-only
  // branch evaluated BEFORE the generic membership check below: a DROP may
  // access a team ONLY when they are a CURRENT member (`leftAt === null`),
  // matching the findAll DROP filter. A foreign team — or one the drop has
  // left — is unconditionally forbidden; the JUNIOR project-derivation below
  // MUST NOT grant a DROP access. Returning/throwing here keeps the contract
  // unambiguous and future-proof.
  // Stryker disable next-line BlockStatement,ConditionalExpression,StringLiteral: equivalent mutants — with this DROP branch removed, a DROP actor falls to the generic active-membership check below (identical `leftAt === null` predicate) and, being a non-JUNIOR, to the same ForbiddenException; the branch is a deliberate explicit/fail-closed contract with no distinct observable behavior.
  if (currentUser.role === 'DROP') {
    if (team.members.some((m) => m.userId === currentUser.id && m.leftAt === null)) return
    throw new ForbiddenException()
  }

  // HIGH-1: `leftAt === null` — a soft-deleted (removed) static membership
  // must not keep granting access. Mirrors the DROP branch above.
  if (team.members.some((m) => m.userId === currentUser.id && m.leftAt === null)) return

  // For JUNIORs: check if they have an active project with this team's senior
  // MED-2 (security-review round 2): `leftAt === null` — same fix as
  // findAll's JUNIOR branch above; a rotated-out senior's stale row must
  // not seed this lookup (mirror-image bug of the DROP/general branches:
  // it could both wrongly grant access via a departed senior AND wrongly
  // deny access by shadowing the current one).
  if (currentUser.role === 'JUNIOR') {
    const senior = team.members.find((m) => m.user?.role === 'SENIOR' && m.leftAt === null)
    if (senior) {
      const seniorProjects = allProjects.filter((p) => p.seniorId === senior.userId)
      const hasActiveProjectWithSenior = seniorProjects.some((p) =>
        p.members.some((m) => m.userId === currentUser.id && m.leftAt === null),
      )
      if (hasActiveProjectWithSenior) return
    }
  }

  throw new ForbiddenException()
}
