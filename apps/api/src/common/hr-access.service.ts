import { Injectable } from '@nestjs/common'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { DatabaseService } from '../database/database.service'
import { teamMembers } from '../database/schema'

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
      .limit(50)

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
}
