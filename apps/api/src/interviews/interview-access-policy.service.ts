import { ForbiddenException, HttpStatus, Injectable } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { and, eq, isNull } from 'drizzle-orm'

import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import { teamMembers, type Interview } from '../database/schema'

@Injectable()
export class InterviewAccessPolicyService {
  constructor(private readonly db: DatabaseService) {}

  async assertSeniorHasActiveTeam(seniorId: string): Promise<void> {
    const row = await this.db.db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, seniorId), isNull(teamMembers.leftAt)))
      .limit(1)
      .then((rows) => rows[0])

    if (!row) {
      throw apiError('INTERVIEW_NO_ACTIVE_TEAM', HttpStatus.FORBIDDEN)
    }
  }

  async getAccessibleSeniorIds(currentUser: SessionUser): Promise<Set<string>> {
    const hrTeamMemberships = await this.db.db.query.teamMembers.findMany({
      where: and(eq(teamMembers.userId, currentUser.id), isNull(teamMembers.leftAt)),
      with: { team: { with: { members: { with: { user: true } } } } },
    })

    const accessibleSeniorIds = new Set<string>()
    for (const membership of hrTeamMemberships) {
      for (const member of membership.team.members) {
        if (member.user?.role === 'SENIOR' && member.leftAt === null) {
          accessibleSeniorIds.add(member.userId)
        }
      }
    }
    return accessibleSeniorIds
  }

  async assertUpdateAccess(
    interview: Pick<Interview, 'seniorId'>,
    currentUser: SessionUser,
  ): Promise<void> {
    if (currentUser.role === 'ADMIN') return

    if (currentUser.role === 'SENIOR') {
      if (interview.seniorId !== currentUser.id) throw new ForbiddenException()
      await this.assertSeniorHasActiveTeam(currentUser.id)
      return
    }

    if (currentUser.role === 'HR') {
      const accessibleSeniorIds = await this.getAccessibleSeniorIds(currentUser)
      if (!accessibleSeniorIds.has(interview.seniorId)) throw new ForbiddenException()
      return
    }

    throw new ForbiddenException()
  }
}
