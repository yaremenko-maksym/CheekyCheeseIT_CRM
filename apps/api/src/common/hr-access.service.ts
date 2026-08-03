import { Injectable } from '@nestjs/common'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Role } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { teamMembers, users } from '../database/schema'

/**
 * Single source of truth for "does this HR share an active team with a user?".
 *
 * Consolidates the previously duplicated private copies that lived in:
 *   - legends.service.ts   (private hrCanAccess)
 *   - projects.service.ts  (private hrCanAccessProject → getHrSeniorIds boolean path)
 *
 * Relationship-based access: an HR can act on resources tied to a user (a senior,
 * typically) only while BOTH of them are active members (leftAt IS NULL) of at
 * least one common team. An HR who has left the team loses access; a user who
 * left the team is no longer reachable by that HR.
 *
 * Provided by a @Global() CommonModule so legends / projects / credentials all
 * inject the same instance without cross-module import cycles.
 */
@Injectable()
export class HrAccessService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Returns true if `hrId` and `userId` are both active members of at least one
   * common team. Both memberships must have leftAt IS NULL.
   *
   * Note: this is intentionally role-agnostic on the target. Callers that need
   * the target to be a SENIOR specifically already know that from context
   * (e.g. project.seniorId). Keeping it relationship-only matches the legend
   * semantics exactly and avoids a redundant join.
   */
  async hrSharesActiveTeamWith(hrId: string, userId: string): Promise<boolean> {
    const hrTeams = await this.db.db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, hrId), isNull(teamMembers.leftAt)))
      // BIZ-21: raised from 50 → 200 to avoid silent truncation for HR with
      // many teams (50 was an arbitrary cap that could exclude valid teams at
      // the tail, making assertHrCanManageProject return false-negative 403s).
      .limit(200)

    if (hrTeams.length === 0) return false

    const teamIds = hrTeams.map((t) => t.teamId)

    const shared = await this.db.db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(
        and(
          eq(teamMembers.userId, userId),
          inArray(teamMembers.teamId, teamIds),
          isNull(teamMembers.leftAt),
        ),
      )
      .limit(1)

    return shared.length > 0
  }

  /**
   * Returns every OTHER user (id + role) that is an active (leftAt IS NULL)
   * member of at least one team `actorId` is also an active member of.
   * Role-agnostic on BOTH sides — a SENIOR calling this gets their own team
   * peers, not just the HR case `hrSharesActiveTeamWith` was originally
   * written for. `actorId` itself is never included.
   *
   * task-file-storage-hardening (security-review round 1, LOW-1 + HIGH-1):
   * bulk/list-returning sibling of `hrSharesActiveTeamWith` (which only
   * answers a per-target boolean) — added so callers that need the FULL set
   * (e.g. building a SQL `inArray` visibility clause) share this single
   * query instead of re-implementing the same `team_members` self-join a
   * third/fourth time. Does NOT cover JUNIOR targets: a JUNIOR is never a
   * `team_members` row by system design (`UsersService.createUser` inserts
   * a JUNIOR into `project_members` only; `TeamsService.addMember` rejects
   * a JUNIOR who has an active project) — callers that need JUNIOR coverage
   * must additionally resolve it via the project graph (see
   * `DocumentsService.getTeammateIds` / `UsersAccessService.isHrInTargetTeam`'s
   * JUNIOR branch for the established pattern).
   */
  async getActiveTeamPeers(actorId: string): Promise<{ userId: string; role: Role }[]> {
    const myTeams = await this.db.db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, actorId), isNull(teamMembers.leftAt)))
    if (myTeams.length === 0) return []
    const teamIds = myTeams.map((t) => t.teamId)

    const peers = await this.db.db
      .select({ userId: teamMembers.userId, role: users.role })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(and(inArray(teamMembers.teamId, teamIds), isNull(teamMembers.leftAt)))

    // De-dupe (a peer can share multiple teams with the actor).
    const seen = new Map<string, { userId: string; role: Role }>()
    for (const p of peers) {
      if (p.userId === actorId) continue
      seen.set(p.userId, { userId: p.userId, role: p.role as Role })
    }
    return [...seen.values()]
  }
}
