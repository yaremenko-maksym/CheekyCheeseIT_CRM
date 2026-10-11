import type { SessionUser } from '@crm/shared'
import type { projectMembers, projects, teamMembers, teams, users } from '../database/schema'

export type TeamWithMembers = typeof teams.$inferSelect & {
  members: Array<typeof teamMembers.$inferSelect & { user: typeof users.$inferSelect | null }>
}

type TeamMemberRow = TeamWithMembers['members'][number]

// A member row whose `user` relation is loaded. The `.filter()` predicates below
// narrow to this type, so downstream code reads `m.user.*` without optional
// chaining or fail-open fallbacks (a dangling relation is excluded up front).
type TeamMemberWithUser = TeamMemberRow & { user: NonNullable<TeamMemberRow['user']> }

export type ProjectWithMembers = typeof projects.$inferSelect & {
  members: Array<typeof projectMembers.$inferSelect & { user: typeof users.$inferSelect | null }>
}

// MED-2 (security-review PR #541 follow-up): `currentUser` is REQUIRED, not
// optional. Both callers (findAll/findOne) already always supply it — an
// optional param here is a fail-open-by-omission footgun: a future caller
// that forgets to pass it would silently fall through the SENIOR/JUNIOR
// `currentUser?.role` checks below to "unmasked" instead of failing `tsc`.
export function mapTeam(
  team: TeamWithMembers,
  allProjects: ProjectWithMembers[],
  currentUser: SessionUser,
) {
  // Drop role - phase 1: early return for drop-teams keeps the legacy
  // senior-team branch (below) byte-for-byte identical.
  if (team.type === 'DROP') {
    return mapDropTeam(team, currentUser)
  }

  // MED-2 (security-review round 2): `leftAt === null` — a rotated-out
  // (detached) senior's team_members row must not be treated as "the
  // team's senior" here. Without this, a stale/duplicate SENIOR row left
  // by a rotation could seed the wrong seniorId, deriving the wrong
  // (or an empty) junior roster for `mapTeam`'s consumers.
  const senior = team.members.find((m) => m.user?.role === 'SENIOR' && m.leftAt === null)

  const juniorMembers: Array<{
    id: string
    userId: string
    displayName: string
    email: string
    avatarUrl: string | null
    avatarDocumentId: string | null
    techStack: string[] | null
    phone: string | null
    telegram: string | null
    role: string
    joinedAt: string | Date
  }> = []

  if (senior) {
    const seniorProjects = allProjects.filter((p) => p.seniorId === senior.userId)
    const seenJuniorIds = new Set<string>()
    for (const project of seniorProjects) {
      for (const pm of project.members) {
        if (pm.leftAt === null && pm.user?.role === 'JUNIOR' && !seenJuniorIds.has(pm.userId)) {
          seenJuniorIds.add(pm.userId)
          juniorMembers.push({
            id: pm.id,
            userId: pm.userId,
            displayName: pm.user.displayName,
            email: pm.user.email,
            avatarUrl: pm.user.avatarUrl ?? null,
            avatarDocumentId: pm.user.avatarDocumentId ?? null,
            techStack: pm.user.techStack ?? null,
            phone: pm.user.phone ?? null,
            telegram: pm.user.telegram ?? null,
            role: 'JUNIOR',
            joinedAt: pm.joinedAt.toISOString(),
          })
        }
      }
    }
  }

  // RBAC: filter junior list based on the viewer's role.
  // JUNIOR viewer: sees only themselves (their own entry), not other JUNIORs.
  // SENIOR viewer: sees NO juniors (junior identity hidden from SENIOR per rule #1).
  let filteredJuniorMembers = juniorMembers
  if (currentUser.role === 'JUNIOR') {
    filteredJuniorMembers = juniorMembers.filter((j) => j.userId === currentUser.id)
  } else if (currentUser.role === 'SENIOR') {
    filteredJuniorMembers = []
  }

  // RBAC A01 (2026-06-10): JUNIOR viewer must NOT see real contacts of SENIOR/DROP members.
  // The legend-subject persona boundary: JUNIOR interacts with the client-facing persona
  // (legend), not the real identity. displayName and avatarUrl are safe — they are the
  // persona display fields (kept by #157 single-directional rule).
  // HR, ACCOUNTANT, and other non-legend-subject roles are NOT masked.
  const isJuniorViewer = currentUser.role === 'JUNIOR'

  return {
    id: team.id,
    name: team.name,
    type: team.type,
    telegram: team.telegram ?? null,
    telegramChannel: team.telegramChannel ?? null,
    notes: team.notes ?? null,
    // task-team-senior-share-override. Surfaced on the wire so the FE can
    // render the override field in the edit dialog + the MyProjectShares
    // source badge. NULL = no team override (resolver falls through).
    seniorSharePercentOverride: team.seniorSharePercentOverride ?? null,
    archivedAt: team.archivedAt ? team.archivedAt.toISOString() : null,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
    members: [
      ...team.members
        // security-review PR #541 round 3: `m.user !== null` added — a
        // dangling/unloaded user relation used to PASS this filter (neither
        // `undefined !== 'ADMIN'` nor `undefined !== 'JUNIOR'` excludes it)
        // and then default to role 'SENIOR' below, the fail-OPEN direction.
        // MEMBER-MASK-5 (senior-junior-member-mask.unit.spec.ts) already
        // pins the opposite, fail-CLOSED convention for mapProject
        // (`m.user?.role ?? 'JUNIOR'`) — a dangling identity is treated as
        // the MOST restricted role, not the least. Excluding it here
        // (same treatment as ADMIN/JUNIOR) brings this branch to the same
        // direction. The predicate is a type guard, so `m.user` is non-null
        // downstream and needs no optional chaining or fallback.
        .filter(
          (m): m is TeamMemberWithUser =>
            m.user !== null &&
            m.user.role !== 'ADMIN' &&
            m.user.role !== 'JUNIOR' &&
            m.leftAt === null,
        )
        .map((m) => {
          const memberIsLegendSubject = m.user.role === 'SENIOR' || m.user.role === 'DROP'
          // Mask real contacts when JUNIOR views a SENIOR or DROP team member.
          const maskContacts = isJuniorViewer && memberIsLegendSubject
          return {
            id: m.id,
            userId: m.userId,
            displayName: m.user.displayName,
            email: maskContacts ? null : m.user.email,
            avatarUrl: m.user.avatarUrl ?? null,
            avatarDocumentId: m.user.avatarDocumentId ?? null,
            techStack: m.user.techStack ?? null,
            phone: maskContacts ? null : (m.user.phone ?? null),
            telegram: maskContacts ? null : (m.user.telegram ?? null),
            role: m.user.role,
            joinedAt: m.joinedAt,
            leftAt: m.leftAt ? m.leftAt.toISOString() : null,
          }
        }),
      ...filteredJuniorMembers,
    ],
  }
}

/**
 * Drop-team variant: returns DROP owner + active SENIOR (if any) + HR(s)
 * + accountant. JUNIORs are NOT computed via project_members (drop-teams
 * don't propagate juniors through the senior — Phase 2 will add the
 * drop-project distribution; for now juniors remain a senior-team
 * concept only).
 */
// MED-2 (security-review PR #541 follow-up): `currentUser` required here
// too — mapTeam (its only caller) now always supplies it; keeping this one
// optional would just move the same footgun one level down.
function mapDropTeam(team: TeamWithMembers, currentUser: SessionUser) {
  // security-review PR #541 round 3: `m.user !== null` added — mirrors the
  // identical fail-open→fail-closed fix in mapTeam's senior-team branch
  // just above (same class of bug: a dangling user relation used to pass
  // this filter and default to role 'DROP' below).
  const activeMembers = team.members.filter(
    (m): m is TeamMemberWithUser =>
      m.leftAt === null && m.user !== null && m.user.role !== 'ADMIN' && m.user.role !== 'JUNIOR',
  )
  // RBAC A01 (2026-06-10): JUNIOR viewer must NOT see real contacts of SENIOR/DROP
  // members — same legend-persona boundary as mapTeam (senior-team branch).
  const isJuniorViewer = currentUser.role === 'JUNIOR'
  return {
    id: team.id,
    name: team.name,
    type: team.type,
    telegram: team.telegram ?? null,
    telegramChannel: team.telegramChannel ?? null,
    notes: team.notes ?? null,
    // task-team-senior-share-override. Drop-team can also carry an
    // override — applies to the drop-projects routed through this team
    // (when the project has no project-level override).
    seniorSharePercentOverride: team.seniorSharePercentOverride ?? null,
    archivedAt: team.archivedAt ? team.archivedAt.toISOString() : null,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
    members: activeMembers.map((m) => {
      const memberIsLegendSubject = m.user.role === 'SENIOR' || m.user.role === 'DROP'
      const maskContacts = isJuniorViewer && memberIsLegendSubject
      return {
        id: m.id,
        userId: m.userId,
        displayName: m.user.displayName,
        email: maskContacts ? null : m.user.email,
        avatarUrl: m.user.avatarUrl ?? null,
        avatarDocumentId: m.user.avatarDocumentId ?? null,
        techStack: m.user.techStack ?? null,
        phone: maskContacts ? null : (m.user.phone ?? null),
        telegram: maskContacts ? null : (m.user.telegram ?? null),
        role: m.user.role,
        joinedAt: m.joinedAt,
        leftAt: m.leftAt ? m.leftAt.toISOString() : null,
      }
    }),
  }
}
