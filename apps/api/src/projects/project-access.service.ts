import { ForbiddenException, HttpStatus, Injectable } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { ApprovalsService } from '../approvals/approvals.service'
import { apiError } from '../common/api-error'
import { getHrScope, hrScopeCoversProject, type HrScope } from '../common/hr-access.service'
import { DatabaseService } from '../database/database.service'
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
   * HR can only manage projects whose senior or drop belongs to one of HR's own teams.
   * ADMIN are unrestricted (no-op for them).
   * This helper is the single enforcement point for this class of RBAC check
   * (OWASP A01: Broken Access Control — cross-team IDOR).
   *
   * @param project - the target project's `seniorId` and `dropId` (either may be null)
   * @param user     - the acting user (SessionUser from JWT)
   */
  async assertHrCanManageProject(
    project: { seniorId: string | null; dropId: string | null },
    user: SessionUser,
  ): Promise<void> {
    if (user.role !== 'HR') return
    if (!(await this.hrCoversProject(user.id, project))) {
      throw apiError('PROJECT_NOT_IN_YOUR_TEAMS', HttpStatus.FORBIDDEN)
    }
  }

  /** The HR project scope (see `hrScopeCoversProject`). */
  async hrCoversProject(
    hrId: string,
    project: { seniorId: string | null; dropId: string | null },
  ): Promise<boolean> {
    return hrScopeCoversProject(await this.getHrScope(hrId), project)
  }

  /** SENIOR and DROP user IDs that are active members of the HR's active teams. */
  getHrScope(hrId: string): Promise<HrScope> {
    return getHrScope(this.db, hrId)
  }

  async assertAccess(project: ProjectWithRelations, currentUser: SessionUser) {
    // task-project-draft-status, item 4 ("узкий путь к черновику") + decision
    // Д1: a DRAFT or REJECTED project exists, for access purposes, ONLY for
    // ADMIN and the invited approvers (senior + drop, per the `approvals`
    // rows this.approvals.propose created in the SAME transaction as the
    // insert — see `create()`). Every other role
    // gets 404, not 403: a 403 would let a caller distinguish "not mine" from
    // "doesn't exist" from "not yet confirmed" by probing a known id
    // (existence-oracle, same reasoning `transaction-visibility.util.ts`'s
    // `assertTransactionVisible` documents for the identical choice).
    // MUST run BEFORE the ADMIN early-return below, since that
    // return is unconditional.
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
    if (currentUser.role === 'ADMIN') return
    if (currentUser.role === 'SENIOR' && project.seniorId === currentUser.id) return
    if (currentUser.role === 'HR' && (await this.hrCoversProject(currentUser.id, project))) return
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
