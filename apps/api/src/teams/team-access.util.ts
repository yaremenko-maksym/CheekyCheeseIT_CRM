import { ForbiddenException } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import type { ProjectWithMembers, TeamWithMembers } from './team-mapping.util'

// HIGH-1 (security-audit authz-hardening): `team.members` returns EVERY row,
// including soft-deleted ones (`leftAt != null` — set by removeMember).
// Without the `leftAt === null` filter a member removed from the team keeps
// being recognized as an active HR (or, in assertAccess below, as
// any active member) for as long as their JWT is valid (up to 7 days) —
// they retain read/write access, can rename the team, remove other members,
// and reactivate their own row via addMember. The DROP case of
// assertAccess is covered by the same `leftAt === null` membership check; this is
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

  // HIGH-1: `leftAt === null` — a soft-deleted (removed) static membership
  // must not keep granting access. This also covers the DROP role (fail-closed):
  // a DROP is allowed ONLY as a CURRENT member (`leftAt === null`); a foreign or
  // left team falls through to the final ForbiddenException, and a DROP is never
  // JUNIOR so the project derivation below can never grant it access.
  if (team.members.some((m) => m.userId === currentUser.id && m.leftAt === null)) return

  // For JUNIORs: check if they have an active project with this team's senior
  // MED-2 (security-review round 2): `leftAt === null` — same fix as
  // the JUNIOR branch of the team listing; a rotated-out senior's stale row must
  // not seed this lookup (mirror-image bug of the general membership check:
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
