import { HttpStatus, Injectable } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import { ApprovalsService } from '../approvals/approvals.service'
import { DatabaseService } from '../database/database.service'
import { projects } from '../database/schema'
import type { DrizzleTx } from '../database/types'
import { PROJECT_APPROVAL_SUBJECT_TYPE } from './project-access.service'
import { ProjectReadService } from './project-read.service'

/**
 * DRAFT-project confirmation: the invited approver's approve / reject and the
 * approval-aggregate write-back to `projects.status`. Extracted verbatim from
 * ProjectsService.
 */
@Injectable()
export class ProjectDraftService {
  constructor(
    private readonly db: DatabaseService,
    private readonly approvals: ApprovalsService,
    private readonly read: ProjectReadService,
  ) {}

  /**
   * task-project-draft-status, item 4. The invited approver (senior or drop
   * — see `create()`) confirms. `currentUser.id` is what
   * `ApprovalsService.approveInTx` uses as `approverUserId` — never a
   * client-supplied id, per that service's own security contract (it trusts
   * whatever id it is given; deriving it from the session, not the request
   * body, is THIS caller's responsibility).
   *
   * Atomic with the status flip: `approveInTx` + the aggregate re-read +
   * `projects.status` write are the SAME `db.transaction` — a concurrent
   * second approver's `approveInTx` cannot observe a project whose approvals
   * say APPROVED-so-far but whose `status` still reads DRAFT (or vice versa).
   *
   * security-review round 2 (SR-H-5): refuses outright under impersonation.
   * `currentUser.id` above is exactly what makes this endpoint's ONLY guard
   * (an invited approver's own live `approvals` row — see `approveInTx`)
   * satisfiable by an ADMIN who impersonated that approver: `POST
   * /auth/impersonate` swaps `id`/`role` to the TARGET's, so the "invited
   * caller" check cannot tell the difference. Unlike the other methods in
   * this file (`archive`/`unarchive`/`update`/`addMember`), which read
   * `currentUser.impersonatorId ?? currentUser.id` to ATTRIBUTE the write to
   * the real operator, attribution is not enough here — confirmation IS the
   * consent record this whole task exists to produce (design spec §3: a
   * project's money "не вступают в силу, пока он не согласится в CRM"), and
   * `approvals` has no column for "who actually clicked" to attribute to.
   * Writing "senior APPROVED" when the senior never opened the app is worse
   * than writing nothing — it looks like proof of consent that never
   * happened. So this refuses instead of recording, for both approve and
   * reject (a fabricated rejection reason would be the mirror of the same
   * problem).
   */
  async approveDraft(id: string, currentUser: SessionUser) {
    if (currentUser.impersonatorId) {
      // task-i18n-stage2-task5: envelope code, not this prose — the client
      // re-translates by `code` (`getApiErrorMessage`); see
      // `PROJECT_DECISION_IMPERSONATION` (`packages/shared/src/schemas/api-errors.ts`).
      throw apiError('PROJECT_DECISION_IMPERSONATION', HttpStatus.FORBIDDEN)
    }
    await this.db.db.transaction(async (tx) => {
      await this.approvals.approveInTx(tx, {
        subjectType: PROJECT_APPROVAL_SUBJECT_TYPE,
        subjectId: id,
        approverUserId: currentUser.id,
      })
      await this.applyApprovalAggregate(tx, id)
    })
    return this.read.loadForResponse(id, currentUser)
  }

  /**
   * task-project-draft-status, item 4 + design spec §3 decision 3/5:
   * rejection requires a reason (enforced by `rejectApprovalInputSchema` +
   * the DB CHECK — this service does not re-validate it, the same "the DB is
   * the backstop" contract `ApprovalsService` documents for itself) and voids
   * the WHOLE proposal (decision #5), never just this approver's own row.
   *
   * security-review round 2 (SR-H-5): same impersonation refusal as
   * `approveDraft` above — see that method's comment for the full reasoning.
   */
  async rejectDraft(id: string, reason: string, currentUser: SessionUser) {
    if (currentUser.impersonatorId) {
      // task-i18n-stage2-task5: same code, see approveDraft's comment above.
      throw apiError('PROJECT_DECISION_IMPERSONATION', HttpStatus.FORBIDDEN)
    }
    await this.db.db.transaction(async (tx) => {
      await this.approvals.rejectInTx(tx, {
        subjectType: PROJECT_APPROVAL_SUBJECT_TYPE,
        subjectId: id,
        approverUserId: currentUser.id,
        reason,
      })
      await this.applyApprovalAggregate(tx, id)
    })
    // task-project-status-filter-ui. `reason` is already in scope — pass it
    // straight through instead of re-querying `approvals` for the row this
    // very call just wrote (also keeps this path clear of the new
    // `getRejectionReasons` query entirely, see `loadForResponse`'s doc).
    return this.read.loadForResponse(id, currentUser, new Map([[id, reason]]))
  }

  /**
   * Reads the subject's post-write aggregate (SAME tx as the approve/reject
   * that just ran) and writes it back to `projects.status`:
   *   APPROVED (every invited approver confirmed) → ACTIVE
   *   REJECTED (any one declined)                 → REJECTED
   *   PENDING  (partial agreement)                 → no write; stays DRAFT
   * `NONE` cannot occur here — this only runs right after a row for this
   * subject was just written.
   */
  private async applyApprovalAggregate(tx: DrizzleTx, projectId: string): Promise<void> {
    const aggregate = await this.approvals.getStatusInTx(
      tx,
      PROJECT_APPROVAL_SUBJECT_TYPE,
      projectId,
    )
    if (aggregate === 'APPROVED' || aggregate === 'REJECTED') {
      // ApprovalGroupStatus 'APPROVED' maps to ProjectStatus 'ACTIVE' — the
      // two enums use different vocabulary for the same "everyone confirmed"
      // fact (Approval is subject-agnostic and never says "ACTIVE"; the
      // project's own status column speaks project-lifecycle language).
      const newStatus = aggregate === 'APPROVED' ? ('ACTIVE' as const) : ('REJECTED' as const)
      await tx
        .update(projects)
        .set({ status: newStatus, updatedAt: new Date() })
        .where(eq(projects.id, projectId))
    }
  }
}
