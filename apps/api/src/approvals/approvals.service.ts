import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { and, asc, eq, isNull, ne } from 'drizzle-orm'
import type {
  Approval,
  ApproveApprovalInput,
  ApprovalGroupStatus,
  ProposeApprovalInput,
  RejectApprovalInput,
} from '@crm/shared'
import {
  approvalSchema,
  approveApprovalInputSchema,
  proposeApprovalInputSchema,
  rejectApprovalInputSchema,
} from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import { approvals } from '../database/schema'
import type { DrizzleTx } from '../database/types'

type ApprovalRow = typeof approvals.$inferSelect

/**
 * Foundation for "actions touching an employee's money or responsibility do
 * not take effect until they agree in the CRM" — task 3 of
 * docs/superpowers/specs/2026-09-01-notifications-and-confirmations-design.md.
 *
 * Deliberately subject-agnostic: this service knows nothing about projects or
 * shares (positions 4/5 of that plan wire those in, calling this service —
 * they do not belong here). It also has no RBAC of its own — "who is allowed
 * to propose / respond for a given subject" is a decision each subject's own
 * module makes before calling in; this service trusts the ids it is given
 * (in particular, a caller MUST derive `approverUserId` for approve()/reject()
 * from the authenticated session, never from client-supplied input, or an
 * approver could answer on someone else's behalf).
 *
 * The one shape — "one proposal = one row per approver" — is what makes the
 * owner's three requirements fall out for free instead of needing separate
 * machinery each (see the schema.ts header comment above the `approvals`
 * table for the full reasoning):
 *   - partial agreement:      read the live rows, some APPROVED, some PENDING
 *   - one rejection voids all: reject() supersedes every other live sibling
 *   - re-propose keeps history: propose() supersedes, never rewrites
 */
@Injectable()
export class ApprovalsService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Opens a new proposal for a subject: one PENDING row per approver.
   *
   * Any still-live rows from a previous generation (whatever their status)
   * are superseded first, in the SAME transaction, before the new rows are
   * inserted — a subject never has two live generations at once, and the old
   * generation's rows are never rewritten, only extinguished.
   */
  async propose(rawInput: ProposeApprovalInput): Promise<Approval[]> {
    const input = proposeApprovalInputSchema.parse(rawInput)
    const now = new Date()

    return this.db.db.transaction(async (tx) => {
      await this.supersedeLiveRows(tx, input.subjectType, input.subjectId, now)

      const rows = await tx
        .insert(approvals)
        .values(
          input.approverUserIds.map((approverUserId) => ({
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            approverUserId,
            proposedByUserId: input.proposedByUserId,
            status: 'PENDING' as const,
            createdAt: now,
          })),
        )
        .returning()

      return rows.map(toApproval)
    })
  }

  /**
   * The named approver agrees. Only their own row transitions — a sibling
   * still PENDING is untouched (this is what makes partial agreement visible
   * with no extra field: query the live rows and see one APPROVED, one not).
   */
  async approve(rawInput: ApproveApprovalInput): Promise<Approval> {
    const input = approveApprovalInputSchema.parse(rawInput)
    const now = new Date()

    return this.db.db.transaction(async (tx) => {
      const row = await this.loadLiveRowForUpdate(tx, input)
      this.assertRespondable(row)

      const [updated] = await tx
        .update(approvals)
        .set({ status: 'APPROVED', decidedAt: now })
        .where(eq(approvals.id, row.id))
        .returning()
      if (!updated) throw new Error('Failed to record approval')

      return toApproval(updated)
    })
  }

  /**
   * The named approver refuses, with a mandatory reason (enforced by the Zod
   * DTO AND the DB check constraint — this is a shared registry other
   * modules reach directly, so the DB is the backstop, not just this path).
   *
   * Decision #5, "отказ одного гасит предложение целиком": every other still
   * live row for the same subject — PENDING or already APPROVED — is
   * superseded in the SAME transaction. The rejected row itself is left
   * alone (supersededAt stays NULL): it IS the terminal state of this
   * generation, which is why `getStatus()` reads "any live REJECTED row" as
   * the whole subject being rejected regardless of what else was approved
   * before this call.
   */
  async reject(rawInput: RejectApprovalInput): Promise<Approval> {
    const input = rejectApprovalInputSchema.parse(rawInput)
    const now = new Date()

    return this.db.db.transaction(async (tx) => {
      const row = await this.loadLiveRowForUpdate(tx, input)
      this.assertRespondable(row)

      const [updated] = await tx
        .update(approvals)
        .set({ status: 'REJECTED', rejectionReason: input.reason, decidedAt: now })
        .where(eq(approvals.id, row.id))
        .returning()
      if (!updated) throw new Error('Failed to record rejection')

      await tx
        .update(approvals)
        .set({ supersededAt: now })
        .where(
          and(
            eq(approvals.subjectType, input.subjectType),
            eq(approvals.subjectId, input.subjectId),
            isNull(approvals.supersededAt),
            ne(approvals.id, updated.id),
          ),
        )

      return toApproval(updated)
    })
  }

  /**
   * The current generation's rows for a subject — a quenched (superseded)
   * row never appears here, whatever its `status` says (§4.1: "погашенная
   * строка не участвует в подсчёте"). Ordered by proposal order.
   */
  async listLive(subjectType: string, subjectId: string): Promise<Approval[]> {
    const rows = await this.db.db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.subjectType, subjectType),
          eq(approvals.subjectId, subjectId),
          isNull(approvals.supersededAt),
        ),
      )
      .orderBy(asc(approvals.createdAt))
    return rows.map(toApproval)
  }

  /**
   * Aggregate read of the subject's current generation. See
   * `ApprovalGroupStatus` (packages/shared/src/schemas/approvals.ts) for the
   * four values and what each means.
   */
  async getStatus(subjectType: string, subjectId: string): Promise<ApprovalGroupStatus> {
    const live = await this.listLive(subjectType, subjectId)
    if (live.length === 0) return 'NONE'
    if (live.some((row) => row.status === 'REJECTED')) return 'REJECTED'
    if (live.every((row) => row.status === 'APPROVED')) return 'APPROVED'
    return 'PENDING'
  }

  /**
   * Everything currently awaiting a response from one approver, across every
   * subject — the query behind "Экран «что от меня ждут»" (position 7 of the
   * plan; not built here).
   */
  async listPendingForApprover(approverUserId: string): Promise<Approval[]> {
    const rows = await this.db.db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.approverUserId, approverUserId),
          eq(approvals.status, 'PENDING'),
          isNull(approvals.supersededAt),
        ),
      )
      .orderBy(asc(approvals.createdAt))
    return rows.map(toApproval)
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async supersedeLiveRows(
    tx: DrizzleTx,
    subjectType: string,
    subjectId: string,
    at: Date,
  ): Promise<void> {
    await tx
      .update(approvals)
      .set({ supersededAt: at })
      .where(
        and(
          eq(approvals.subjectType, subjectType),
          eq(approvals.subjectId, subjectId),
          isNull(approvals.supersededAt),
        ),
      )
  }

  /**
   * Locks (`FOR UPDATE`) and returns the live row for one (subject, approver)
   * pair, so two concurrent approve()/reject() calls on the same row
   * serialise instead of racing. Null if there is no live row — either
   * nobody ever proposed for this (subjectType, subjectId, approverUserId)
   * triple, or it was already superseded (a sibling's rejection, or a
   * re-proposal).
   */
  private async loadLiveRowForUpdate(
    tx: DrizzleTx,
    params: { subjectType: string; subjectId: string; approverUserId: string },
  ): Promise<ApprovalRow | null> {
    const rows = await tx
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.subjectType, params.subjectType),
          eq(approvals.subjectId, params.subjectId),
          eq(approvals.approverUserId, params.approverUserId),
          isNull(approvals.supersededAt),
        ),
      )
      .for('update')
      .limit(1)
    return rows[0] ?? null
  }

  /** Throws the two ways a response can legitimately fail to apply. */
  private assertRespondable(row: ApprovalRow | null): asserts row is ApprovalRow {
    if (!row) throw new NotFoundException('Согласование не найдено или уже погашено')
    if (row.status !== 'PENDING') throw new ConflictException('Согласование уже получило ответ')
  }
}

function toApproval(row: ApprovalRow): Approval {
  return approvalSchema.parse({
    id: row.id,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    approverUserId: row.approverUserId,
    status: row.status,
    rejectionReason: row.rejectionReason,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    proposedByUserId: row.proposedByUserId,
    supersededAt: row.supersededAt ? row.supersededAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  })
}
