/**
 * Read-scope helpers for DocumentsService (L5 leaf extraction, behavior-preserving MOVE).
 * Free functions over explicit (db, hrAccess) arguments — no DI edge. Bodies are
 * verbatim from DocumentsService; they encode owner RBAC decisions (2026-08-01/08-03).
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { DatabaseService } from '../database/database.service'
import { projectMembers, teamMembers, users, visibleProjects } from '../database/schema'
import type { HrAccessService } from '../common/hr-access.service'

// Mirrors ProjectsService.getHrSeniorIds — leftAt semantics MUST stay in
// sync: an HR who left the team retains no access (HC-6 pins the predicate).
export async function getHrSeniorIds(db: DatabaseService, hrId: string): Promise<string[]> {
  const hrTeams = await db.db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, hrId), isNull(teamMembers.leftAt)))
  if (!hrTeams.length) return []
  const teamIds = hrTeams.map((r) => r.teamId)
  const seniors = await db.db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(
      and(
        inArray(teamMembers.teamId, teamIds),
        eq(users.role, 'SENIOR'),
        isNull(teamMembers.leftAt),
      ),
    )
  return seniors.map((r) => r.userId)
}

/**
 * task-file-storage-hardening §1 (owner decision 2026-08-01): "sузить
 * доступ к резюме/сканам до команды" for SENIOR and HR.
 *
 * HIGH-1 fix (security-review round 1): the FIRST version of this method
 * scoped to `team_members` alone, which silently excludes EVERY JUNIOR —
 * a JUNIOR is never a `team_members` row by system design
 * (`UsersService.createUser` inserts a JUNIOR into `project_members`
 * only; `TeamsService.addMember` explicitly REJECTS adding a JUNIOR who
 * has an active project, see teams.service.ts). Live data at review time:
 * 0 active JUNIOR `team_members` rows company-wide. The old code's actual
 * effect was "SENIOR/HR can no longer see ANY junior's resume/scan",
 * which is the opposite of the intended narrowing.
 *
 * Correct membership model — union of two relationships, mirroring
 * `UsersAccessService.isHrInTargetTeam`'s JUNIOR branch /
 * `isSeniorViewingOwnProjectMember` (the established pattern for
 * "does this SENIOR/HR reach this JUNIOR" elsewhere in the codebase):
 *   1. Active team overlap (any role on the target side) — delegated to
 *      `HrAccessService.getActiveTeamPeers` (LOW-1: was a third private
 *      copy of the same `team_members` self-join `getHrSeniorIds` above
 *      already implements; now shares one canonical query).
 *   2. JUNIORs reachable transitively: the SENIOR(s) found in step 1 (or
 *      the actor itself, if the actor IS the SENIOR) → those SENIORs'
 *      projects → active (`leftAt IS NULL`) `project_members` rows on
 *      those projects.
 * PLUS `actorId` itself always — "собственные документы у всех остаются
 * доступны всегда" must hold even with zero active team membership.
 *
 * ACCOUNTANT is NOT routed through this helper at all — they keep
 * unconditional SCAN access (owner decision 2026-08-03, security-review
 * round 2 — see the SCAN branch of `buildVisibilityClause` for the full
 * rationale). Routing them through this predicate would not even be a
 * narrowing in practice: ACCOUNTANT IS added to every team at creation
 * time, so it would resolve to "the whole company" anyway — the round-1
 * attempt at scoping ACCOUNTANT used a DIFFERENT mechanism (a
 * transaction-existence check, since reverted) precisely because this
 * team/project predicate can't meaningfully restrict a role that's a
 * member of literally every team.
 */
export async function getTeammateIds(
  db: DatabaseService,
  hrAccess: HrAccessService,
  actorId: string,
  actorRole: 'SENIOR' | 'HR',
): Promise<string[]> {
  const scopedIds = new Set<string>([actorId])

  const peers = await hrAccess.getActiveTeamPeers(actorId)
  for (const p of peers) scopedIds.add(p.userId)

  // Resolve the SENIOR(s) whose project rosters extend this actor's
  // reach: the actor itself if they ARE a SENIOR, else any SENIOR found
  // among their active team peers (the HR case).
  const seniorIds =
    actorRole === 'SENIOR'
      ? [actorId]
      : peers.filter((p) => p.role === 'SENIOR').map((p) => p.userId)

  if (seniorIds.length > 0) {
    // MED (security-review round 2): exclude ARCHIVED projects explicitly
    // — do not rely solely on `project_members.leftAt` as the archival
    // signal. `ProjectsService.archive()` DOES set `leftAt` for active
    // JUNIORs at archive time, but `unarchive()` deliberately does NOT
    // restore it ("project_members.leftAt intentionally NOT restored" —
    // see its own comment), so a re-activated project can drift out of
    // sync with its members' `leftAt`. Filtering on `projects.archivedAt`
    // directly matches the stricter precedent already established by
    // `UsersAccessService.isJuniorUnderLegendSubject` (the other
    // established project-lookup for the SAME kind of relationship).
    // task-project-draft-status: sourced from `visibleProjects` — a DRAFT
    // or REJECTED project's senior must not extend document visibility to
    // "teammates" any more than an archived one does.
    const seniorProjects = await db.db
      .select({ id: visibleProjects.id })
      .from(visibleProjects)
      .where(inArray(visibleProjects.seniorId, seniorIds))
    if (seniorProjects.length > 0) {
      const projectIds = seniorProjects.map((p) => p.id)
      const juniors = await db.db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(and(inArray(projectMembers.projectId, projectIds), isNull(projectMembers.leftAt)))
      for (const j of juniors) scopedIds.add(j.userId)
    }
  }

  return [...scopedIds]
}
