import { ForbiddenException, HttpStatus, Injectable } from '@nestjs/common'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { ApprovalsService } from '../approvals/approvals.service'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import { teamMembers, users } from '../database/schema'
import type { ProjectWithRelations } from './project-map.util'

/** `subjectType` the projects module registers its approvals under. */
export const PROJECT_APPROVAL_SUBJECT_TYPE = 'PROJECT'

/**
 * `subjectType` for a PROJECT-level senior-share-override change — distinct from
 * the draft-confirmation subject above: the same project id can carry a live
 * draft-confirmation proposal AND a live share-change proposal at once
 * (`uq_approvals_live_subject_approver` is keyed on subjectType, subjectId,
 * approverUserId).
 */
export const PROJECT_SENIOR_SHARE_SUBJECT_TYPE = 'PROJECT_SENIOR_SHARE'

/**
 * RBAC read-access guards for projects: draft/rejected visibility (404, not
 * 403), HR cross-team scoping. Extracted verbatim from ProjectsService.
 */
@Injectable()
export class ProjectAccessService {
  constructor(
    private readonly db: DatabaseService,
    private readonly approvals: ApprovalsService,
  ) {}

  /**
   * Enforces HR cross-team scoping on write paths.
   *
   * HR can only manage projects whose senior belongs to one of HR's own teams.
   * ADMIN and ACCOUNTANT are unrestricted (no-op for them).
   * This helper is the single enforcement point for this class of RBAC check
   * (OWASP A01: Broken Access Control — cross-team IDOR).
   *
   * @param seniorId - the `seniorId` column of the target project (may be null for admin-owned)
   * @param user     - the acting user (SessionUser from JWT)
   */
  async assertHrCanManageProject(seniorId: string | null, user: SessionUser): Promise<void> {
    if (user.role !== 'HR') return

    if (!seniorId) {
      throw apiError('PROJECT_NOT_IN_YOUR_TEAMS', HttpStatus.FORBIDDEN)
    }

    const allowedSeniorIds = await this.getHrSeniorIds(user.id)
    if (!allowedSeniorIds.includes(seniorId)) {
      throw apiError('PROJECT_NOT_IN_YOUR_TEAMS', HttpStatus.FORBIDDEN)
    }
  }

  /**
   * Returns senior user IDs that this HR actively belongs to (via team_members).
   * Both the HR membership and the senior membership must have leftAt IS NULL —
   * an HR who has left the team must not retain access to those projects.
   * (dedup: was previously inlined as hrCanAccessProject; leftAt fix per task-junior-ux-3-cleanup defer #1)
   */
  async getHrSeniorIds(hrId: string): Promise<string[]> {
    // Only active HR memberships
    const hrTeams = await this.db.db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, hrId), isNull(teamMembers.leftAt)))
    if (!hrTeams.length) return []
    const teamIds = hrTeams.map((r) => r.teamId)
    // Only active senior memberships in those same teams
    const seniors = await this.db.db
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

  async assertAccess(project: ProjectWithRelations, currentUser: SessionUser) {
    // task-project-draft-status, item 4 ("узкий путь к черновику") + decision
    // Д1: a DRAFT or REJECTED project exists, for access purposes, ONLY for
    // ADMIN and the invited approvers (senior + drop, per the `approvals`
    // rows this.approvals.propose created in the SAME transaction as the
    // insert — see `create()`). Every other role — INCLUDING ACCOUNTANT,
    // whose branch below grants unconditional access to an ACTIVE project —
    // gets 404, not 403: a 403 would let a caller distinguish "not mine" from
    // "doesn't exist" from "not yet confirmed" by probing a known id
    // (existence-oracle, same reasoning `transaction-visibility.util.ts`'s
    // `assertTransactionVisible` documents for the identical choice).
    // MUST run BEFORE the ADMIN/ACCOUNTANT early-return below, since that
    // return is unconditional and would otherwise leak drafts to ACCOUNTANT.
    if (project.status !== 'ACTIVE') {
      if (currentUser.role === 'ADMIN') return
      const invited = await this.approvals.isApprover(
        PROJECT_APPROVAL_SUBJECT_TYPE,
        project.id,
        currentUser.id,
      )
      if (invited) return
      throw apiError('PROJECT_NOT_FOUND', HttpStatus.NOT_FOUND)
    }
    if (currentUser.role === 'ADMIN' || currentUser.role === 'ACCOUNTANT') return
    if (currentUser.role === 'SENIOR' && project.seniorId === currentUser.id) return
    if (currentUser.role === 'HR') {
      const seniorIds = await this.getHrSeniorIds(currentUser.id)
      if (seniorIds.some((sid) => sid === project.seniorId)) return
    }
    if (
      currentUser.role === 'JUNIOR' &&
      project.members.some((m) => m.userId === currentUser.id && m.leftAt === null)
    ) {
      return
    }
    // Drop role - phase 1: DROP can see their own drop-projects.
    if (currentUser.role === 'DROP' && project.dropId === currentUser.id) return
    throw new ForbiddenException()
  }
}
