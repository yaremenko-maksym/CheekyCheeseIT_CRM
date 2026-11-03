/**
 * Half of §7.4 with the queries, ONE for the whole module — backlog 208.
 *
 * Previously this code lived inside `NotificationsService` as private
 * `resolveSubjectStates`/`loadSubjectStates`, and only the popup saw it
 * (`listForUser`). The cron (`NotificationEmailCronService`) did not check
 * staleness of an email at all: an offer was withdrawn a second before the tick, and the email
 * "requiring action" still went out (A1 assumption on #673, removed
 * here).
 *
 * Extracted into a separate service rather than copied a second time, by the direct
 * requirement of the task: "by the same resolver as the popup", not "by the same
 * query, rewritten afresh". Two places reading the same state differently
 * diverge silently — and that is exactly how the A1 assumption arose:
 * the cron simply had no version of its own check, and no one
 * noticed, because there was nowhere to notice it.
 *
 * `resolveMany` — what the popup uses (one batch of notifications of one
 * recipient; the order of answers matches the order of rows). `resolveOne` —
 * what the cron uses (one email row at the moment of sending): the same
 * query with a batch of length one, not a separate implementation.
 *
 * The decision is taken by the PURE half — `computeSubjectState` in
 * `notification-subject-resolver.ts`. Here there are only queries: `resolveMany` /
 * `resolveOne` are not tested directly by the mutation gate (integration
 * specs are not seen by the gate — `.claude/rules/common/mutation-gate-integration-specs.md`),
 * so the queries are checked by a unit test with a compiled `where`
 * (`notification-subject-state.service.spec.ts`, the device from
 * `notifications.service.spec.ts`, SR-L-8), and the decisions are already under mutation
 * in `notification-subject-resolver.spec.ts`.
 */
import { Injectable } from '@nestjs/common'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { NotificationSubjectType } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import {
  approvals,
  employeeContracts,
  nonDeletedTransactions,
  projects,
  teams,
  users,
} from '../database/schema'
import {
  approvalIdsToCheck,
  classifyApprovalRow,
  computeSubjectState,
  groupSubjectIds,
  type SubjectRef,
  type SubjectResolution,
  type SubjectState,
} from './notification-subject-resolver'

@Injectable()
export class NotificationSubjectStateService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * The state of each row from `refs`, IN ROW ORDER — not by a map keyed by
   * identifier (see the doc comment at the former location of this code in
   * `NotificationsService`: a map would require a fallback value for the case
   * "no state", which never occurs).
   *
   * `userId` — the recipient of ALL `refs` rows (SR-L-8, defense in depth):
   * the query on `approvals` binds the row found to HIM via
   * `approverUserId`, rather than relying on the caller's discipline. A row of
   * someone else's approver is read AS MISSING. For the popup this is one
   * person for the whole batch (`listForUser` has already collected it by them); for the cron —
   * the recipient of THIS email, a batch of length one.
   */
  async resolveMany(userId: string, refs: SubjectRef[]): Promise<SubjectResolution[]> {
    const statesByType = new Map<NotificationSubjectType, Map<string, SubjectState>>()
    for (const [subjectType, ids] of groupSubjectIds(refs)) {
      statesByType.set(subjectType, await this.loadSubjectStates(subjectType, ids))
    }

    const liveApprovalIds = new Set<string>()
    const decidedApprovalIds = new Set<string>()
    const approvalIds = approvalIdsToCheck(refs)
    if (approvalIds.length > 0) {
      const live = await this.db.db
        .select({ id: approvals.id, status: approvals.status })
        .from(approvals)
        .where(
          and(
            isNull(approvals.supersededAt),
            inArray(approvals.id, approvalIds),
            eq(approvals.approverUserId, userId),
          ),
        )
      for (const row of live) {
        const classification = classifyApprovalRow(row.status)
        if (classification === 'live') liveApprovalIds.add(row.id)
        else if (classification === 'decided') decidedApprovalIds.add(row.id)
        // 'superseded' (CANCELLED, defensively) falls into no set —
        // see the doc comment of `classifyApprovalRow`.
      }
    }

    return refs.map((ref) =>
      computeSubjectState(ref, statesByType, liveApprovalIds, decidedApprovalIds),
    )
  }

  /**
   * One row — the cron needs a decision about ONE email at the moment of sending, not
   * about a batch. The same arity on input and output as `resolveMany`: a batch
   * of length one gives exactly one answer, so `[0]` here is not defensive code —
   * `refs.map(...)` in `resolveMany` cannot return an array of a different length.
   */
  async resolveOne(userId: string, ref: SubjectRef): Promise<SubjectResolution> {
    const [state] = await this.resolveMany(userId, [ref])
    return state as SubjectResolution
  }

  /**
   * The state of each requested object. Absence from the map means "the object
   * no longer exists". One and the same way of checking the archive for PROJECT/TEAM/USER
   * (three copies of one condition diverge silently; a shared mechanism does not);
   * TRANSACTION and EMPLOYEE_CONTRACT (DOCUMENT_SIGN_REQUIRED) are built differently —
   * see the branches below.
   */
  private async loadSubjectStates(
    subjectType: NotificationSubjectType,
    ids: string[],
  ): Promise<Map<string, SubjectState>> {
    const byArchivedAt = (rows: { id: string; archivedAt: Date | null }[]) =>
      new Map<string, SubjectState>(
        rows.map((r) => [r.id, r.archivedAt === null ? 'active' : 'archived']),
      )
    switch (subjectType) {
      case 'PROJECT': {
        const found = await this.db.db
          .select({ id: projects.id, archivedAt: projects.archivedAt })
          .from(projects)
          .where(inArray(projects.id, ids))
        return byArchivedAt(found)
      }
      case 'TEAM': {
        const found = await this.db.db
          .select({ id: teams.id, archivedAt: teams.archivedAt })
          .from(teams)
          .where(inArray(teams.id, ids))
        return byArchivedAt(found)
      }
      case 'USER': {
        const found = await this.db.db
          .select({ id: users.id, archivedAt: users.archivedAt })
          .from(users)
          .where(inArray(users.id, ids))
        return byArchivedAt(found)
      }
      case 'TRANSACTION': {
        // The transaction has no archive — it has soft deletion, and that is already cut off
        // by the `non_deleted_transactions` view itself.
        const found = await this.db.db
          .select({ id: nonDeletedTransactions.id })
          .from(nonDeletedTransactions)
          .where(inArray(nonDeletedTransactions.id, ids))
        return new Map<string, SubjectState>(found.map((r) => [r.id, 'active']))
      }
      case 'EMPLOYEE_CONTRACT': {
        // `DOCUMENT_SIGN_REQUIRED` is the only type with this kind of object, and
        // "the object exists" for IT means not "the row is not deleted"
        // (contracts are not deleted — `EmployeeContractsService` only changes
        // `status`), but "the contract is still awaiting signature". Without this condition
        // the "Sign contract" button and email would remain active even after
        // the employee had already signed it.
        const found = await this.db.db
          .select({ id: employeeContracts.id })
          .from(employeeContracts)
          .where(
            and(inArray(employeeContracts.id, ids), eq(employeeContracts.status, 'READY_TO_SIGN')),
          )
        return new Map<string, SubjectState>(found.map((r) => [r.id, 'active']))
      }
      default: {
        // SR-M-1 (PR #678, round 2): the same idiom as `classifyApprovalRow` /
        // `computeSubjectState` in `notification-subject-resolver.ts` —
        // a sixth `NotificationSubjectType` breaks compilation here, rather than
        // silently falling into `missing` (for an action-required email this now means
        // `SKIPPED/STALE`, not "the popup showed a degraded card").
        const exhaustive: never = subjectType
        throw new Error(`loadSubjectStates: unknown subject kind ${String(exhaustive)}`)
      }
    }
  }
}
