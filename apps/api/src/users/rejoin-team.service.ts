import { HttpStatus } from '@nestjs/common'
import { and, eq, isNull } from 'drizzle-orm'
import { markSeniorDirty } from '../job-sourcing/dirty-producers'
import { apiError } from '../common/api-error'
import type { DatabaseService } from '../database/database.service'
import { teamMembers, teams, type User } from '../database/schema'
import type { TeamsService } from '../teams/teams.service'
import { assertTeamStaffRoles } from './team-staff.util'

/** Helpers owned by the `UsersService` facade, passed in as bound callbacks. */
export interface RejoinTeamHelpers {
  findById(id: string): Promise<User | undefined>
}

/**
 * `rejoinTeam`, extracted verbatim from `UsersService` (behavior-preserving leaf move). The SENIOR
 * gate, active-team guard, former-member scope check and team/member inserts are unchanged. Writes
 * `teams` / `team_members` only (never `users`).
 */
export class RejoinTeamService {
  constructor(
    private readonly db: DatabaseService,
    private readonly teamsService: TeamsService,
    private readonly helpers: RejoinTeamHelpers,
  ) {}

  /**
   * Rejoin-team primitive for a teamless SENIOR. Either creates a fresh
   * senior-team (`CREATE_NEW`) or attaches to an existing drop-team
   * (`JOIN_DROP_TEAM`). Caller must be the senior themselves (controller
   * enforces that the path is `me`).
   */
  async rejoinTeam(
    seniorId: string,
    data: {
      teamMode: 'CREATE_NEW' | 'JOIN_DROP_TEAM'
      dropTeamId?: string
      hrIds?: string[]
      accountantId?: string | null
    },
  ): Promise<{ teamId: string }> {
    const user = await this.helpers.findById(seniorId)
    if (!user) throw apiError('USER_NOT_FOUND', HttpStatus.NOT_FOUND)
    if (user.role !== 'SENIOR') {
      throw apiError('REJOIN_TEAM_SENIOR_ONLY', HttpStatus.BAD_REQUEST)
    }
    // Caller must currently have NO active team membership.
    const activeMembership = await this.db.db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, seniorId), isNull(teamMembers.leftAt)))
      .then((rows) => rows[0])
    if (activeMembership) {
      throw apiError('ALREADY_HAS_ACTIVE_TEAM', HttpStatus.BAD_REQUEST)
    }

    if (data.teamMode === 'JOIN_DROP_TEAM') {
      if (!data.dropTeamId) {
        throw apiError('DROP_TEAM_ID_REQUIRED', HttpStatus.BAD_REQUEST)
      }
      // LOW (security-review round 3, follow-up to #436): this is a
      // self-service call — the SENIOR is the caller, so there is no
      // HR/ADMIN actor to scope against (unlike createUser's HR check
      // above `isActiveMemberOfTeam`). Without a check here a teamless
      // SENIOR could self-attach to ANY drop-team with a free slot, not
      // just one they used to belong to — see
      // TeamsService.wasFormerMemberOfTeam's docblock for the full
      // rationale and the chain this closes.
      const wasFormerMember = await this.teamsService.wasFormerMemberOfTeam(
        data.dropTeamId,
        seniorId,
      )
      if (!wasFormerMember) {
        throw apiError('REJOIN_TEAM_MUST_BE_FORMER_MEMBER', HttpStatus.FORBIDDEN)
      }
      await this.teamsService.addSeniorToDropTeam(data.dropTeamId, seniorId)
      return { teamId: data.dropTeamId }
    }

    // CREATE_NEW path — mirrors createUser SENIOR branch.
    if (!data.hrIds || data.hrIds.length < 1) {
      throw apiError('HR_REQUIRED_MINIMUM_ONE', HttpStatus.BAD_REQUEST)
    }
    // SR-M-1 follow-up (#999): same role invariant as createUser CREATE_NEW — a teamless SENIOR
    // may only enrol real, non-archived HRs / an ACCOUNTANT. Validated BEFORE any write.
    await assertTeamStaffRoles(this.db.db, [...new Set(data.hrIds)], data.accountantId)
    return this.db.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(teams)
        .values({ name: `Команда ${user.displayName}` })
        .returning()
      const team = inserted[0]
      if (!team) throw new Error('Failed to create senior team')
      const memberIds = [
        seniorId,
        ...data.hrIds!,
        ...(data.accountantId ? [data.accountantId] : []),
      ]
      for (const userId of memberIds) {
        await tx.insert(teamMembers).values({ teamId: team.id, userId })
      }
      await markSeniorDirty(tx, seniorId, 'senior.team')
      return { teamId: team.id }
    })
  }
}
