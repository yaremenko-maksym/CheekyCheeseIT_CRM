import type { SessionUser } from '@crm/shared'
import { formatTransactionBusinessDate } from './transaction-date.util'

/**
 * SR-809-L-3 / owner decision D-2 — "ADMIN/ACCOUNTANT may go beyond 31 days
 * only with a mandatory reason written to the audit log".
 *
 * This is the "written to the audit log" half. The create flows do not assemble
 * an audit entry of their own (the lifecycle hook records the creation itself),
 * so an out-of-window backdate gets its OWN row: without it the justification
 * the policy just demanded would be validated and then dropped on the floor,
 * which is worse than not asking for it — the control would look enforced while
 * leaving nothing for an investigator to read.
 *
 * `action` is a plain `text` column on `transaction_audit_log`, so this needs no
 * enum migration.
 */
export const TX_DATE_BACKDATED_ACTION = 'TX_DATE_BACKDATED'

/**
 * The audit row for one out-of-window backdate. Written in the SAME transaction
 * as the row it describes, so the trail cannot commit without the row or the row
 * without its justification.
 *
 * The actor is the IMPERSONATOR when one is present — the same rule the payout
 * audit trail already follows, so "who did this" means the human, not the
 * identity they were acting through.
 */
export function backdateAuditRow(params: {
  targetId: string
  actor: SessionUser
  txDate: Date
  backdateReason: string
}): {
  actorId: string
  targetId: string
  action: string
  metadata: Record<string, string>
} {
  return {
    actorId: params.actor.impersonatorId ?? params.actor.id,
    targetId: params.targetId,
    action: TX_DATE_BACKDATED_ACTION,
    metadata: {
      txDate: formatTransactionBusinessDate(params.txDate),
      backdateReason: params.backdateReason,
    },
  }
}
