import { z } from 'zod'

/**
 * Approvals — the foundation for "actions touching an employee's money or
 * responsibility do not take effect until they agree in the CRM"
 * (docs/superpowers/specs/2026-09-01-notifications-and-confirmations-design.md
 * §3/§4.1, task 3 of the "Уведомления и подтверждения" plan).
 *
 * This file is the SHARED registry's contract — it does not know about
 * projects or shares. Those are wired by later tasks (positions 4/5 of the
 * plan); this module only guarantees the mechanics: propose, partial
 * agreement, one rejection voiding the whole proposal, and re-proposal never
 * rewriting history.
 */

// ---------------------------------------------------------------------------
// Subject type — "вид объекта"
// ---------------------------------------------------------------------------

/**
 * What kind of object is being confirmed. Deliberately a free-form string,
 * not a closed Zod enum tied to this file: PROJECT/SHARE-style values are
 * owned and introduced by the modules that call `proposeApproval()` (task
 * boundary — this foundation must not hardcode them). Same reasoning as
 * `consumedTxHashes.purpose` in the DB schema — a shared registry's "kind"
 * column is a caller-owned label, not a closed set this file enumerates.
 */
export const approvalSubjectTypeSchema = z.string().trim().min(1).max(50)
export type ApprovalSubjectType = z.infer<typeof approvalSubjectTypeSchema>

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const approvalStatusSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED'])
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>

/**
 * Aggregate read of "where does this subject's CURRENT (live) generation
 * stand" — derived from the live rows, never stored:
 *   NONE     — nobody has ever proposed anything for this subject
 *   PENDING  — at least one live row still awaits a response (this is also
 *              the state during partial agreement: one row APPROVED, the
 *              other still PENDING — no separate flag needed, §4.1)
 *   APPROVED — every live row is APPROVED
 *   REJECTED — at least one live row is REJECTED (decision #5: one rejection
 *              voids the whole proposal, so this always wins)
 */
export const approvalGroupStatusSchema = z.enum(['NONE', 'PENDING', 'APPROVED', 'REJECTED'])
export type ApprovalGroupStatus = z.infer<typeof approvalGroupStatusSchema>

// ---------------------------------------------------------------------------
// Row DTO
// ---------------------------------------------------------------------------

export const approvalSchema = z.object({
  id: z.string().uuid(),
  subjectType: approvalSubjectTypeSchema,
  subjectId: z.string().uuid(),
  approverUserId: z.string().uuid(),
  status: approvalStatusSchema,
  rejectionReason: z.string().min(1).nullable(),
  decidedAt: z.string().datetime().nullable(),
  proposedByUserId: z.string().uuid(),
  /**
   * Set once this row stops being the live decision point for its subject —
   * either a sibling in the same generation was rejected (decision #5, "отказ
   * одного гасит предложение целиком"), or the subject was re-proposed
   * (§4.1, "повторное предложение не переписывает старые строки"). NULL means
   * this row is still live.
   */
  supersededAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
})
export type Approval = z.infer<typeof approvalSchema>

// ---------------------------------------------------------------------------
// Service inputs
// ---------------------------------------------------------------------------

/**
 * Opens a new proposal: one row per approver. If a live generation already
 * exists for this subject (regardless of its own state), it is superseded
 * first — never rewritten (§4.1).
 */
export const proposeApprovalInputSchema = z
  .object({
    subjectType: approvalSubjectTypeSchema,
    subjectId: z.string().uuid(),
    approverUserIds: z.array(z.string().uuid()).min(1, 'Нужен хотя бы один подтверждающий'),
    proposedByUserId: z.string().uuid(),
  })
  .refine((v) => new Set(v.approverUserIds).size === v.approverUserIds.length, {
    message: 'approverUserIds не должен содержать повторов',
    path: ['approverUserIds'],
  })
export type ProposeApprovalInput = z.infer<typeof proposeApprovalInputSchema>

/** One approver saying yes to their own row. */
export const approveApprovalInputSchema = z.object({
  subjectType: approvalSubjectTypeSchema,
  subjectId: z.string().uuid(),
  approverUserId: z.string().uuid(),
})
export type ApproveApprovalInput = z.infer<typeof approveApprovalInputSchema>

/**
 * One approver saying no. `reason` is required and non-blank — decision "Отказ
 * возможен и требует причины" (§3.3) — an empty rejection is not representable.
 */
export const rejectApprovalInputSchema = z.object({
  subjectType: approvalSubjectTypeSchema,
  subjectId: z.string().uuid(),
  approverUserId: z.string().uuid(),
  reason: z.string().trim().min(1, 'Причина отказа обязательна'),
})
export type RejectApprovalInput = z.infer<typeof rejectApprovalInputSchema>
