import type { SessionUser } from '@crm/shared'
import type { Transaction } from '../database/schema'
import { isInternalCompanySide } from './finance-predicates.util'

export type TxWithRelations = Transaction & {
  // task-counterparty-role-masking: `role` is joined so mapTx can tell whether
  // a party is an ADMIN partner (Максим/Константин) and mask their identity for
  // non-privileged viewers. Nullable to stay resilient if a legacy row points
  // at a since-deleted user (the relation resolves to null).
  sender: { displayName: string; role: string } | null
  receiver: { displayName: string; role: string } | null
  project: { name: string } | null
  payoutRequest?: {
    seniorId: string
    incomeAmount: string
    payableAmount: string
    seniorSharePercent: number | null
    seniorSharePercentSource?: 'PROJECT' | 'TEAM' | 'USER_DEFAULT' | null
  } | null
}

/**
 * RBAC view-masking mapper: shapes a transaction row into the DTO for a given
 * viewer. Pure (no instance state); the masking decisions below are the core
 * identity-redaction surface of the finance module.
 */
export function mapTx(tx: TxWithRelations, viewer: SessionUser) {
  // Only ADMIN/ACCOUNTANT may see the real identity of an internal company
  // party. All other roles get the brand + null id (RBAC, not CSS-hiding).
  const privileged = viewer.role === 'ADMIN' || viewer.role === 'ACCOUNTANT'

  const senderMasked =
    !privileged &&
    isInternalCompanySide(tx.senderId, tx.senderLabel, tx.sender?.role, tx.fundingSource)
  const receiverMasked =
    !privileged &&
    isInternalCompanySide(tx.receiverId, tx.receiverLabel, tx.receiver?.role, tx.fundingSource)

  return {
    id: tx.id,
    type: tx.type,
    status: tx.status,
    amount: tx.amount,
    currency: tx.currency,
    // task-salary-pay-amount — the OBLIGATION this row settled, kept
    // alongside the FACT of the payment above (`amount`/`currency`).
    // Deliberately NOT masked: these are the same amount that `amount`
    // already exposes to this viewer, merely in its pre-payment
    // denomination — masking one without the other would only make the two
    // numbers contradict each other. Counterparty masking (who paid whom)
    // is unaffected. NULL on every row not paid through this flow.
    originalAmount: tx.originalAmount,
    originalCurrency: tx.originalCurrency,
    exchangeRate: tx.exchangeRate,
    // task-cascade-preview-ui (task 5) — the settle accumulator (task 1, PR
    // #599) reaches the operator, unmasked.
    //
    // SR-M-2 (security-review): the reason is NOT «same rule as the triplet
    // above». That analogy broke inside task 5 itself — the triplet is gated
    // behind `privileged` in the detail dialog while this figure is shown to
    // everyone — so leaning on it would read as permission to whoever adds
    // the next money field.
    //
    // The reason that holds is checkable: THE VIEWER IS A PARTY TO THIS ROW.
    // Every non-privileged path scopes rows on senderId/receiverId before
    // `mapTx` runs (findAll's role filters, findOne's visibility assertions,
    // findPayoutRequest's creditor filter), so this says how much of the
    // viewer's OWN money has left the account. It carries no counterparty
    // identity, and masking it while `amount` stays visible would only set
    // the two figures against each other on one screen. The premise is pinned
    // negatively by SE-6/SE-7 in
    // `transaction-settled-exposure.unit.spec.ts`, so widening a caller goes
    // red instead of silently carrying the accumulator along.
    settledAmount: tx.settledAmount,
    settledCurrency: tx.settledCurrency,
    senderId: senderMasked ? null : tx.senderId,
    senderLabel: senderMasked ? 'CheekyCheeseIT' : tx.senderLabel,
    senderName: senderMasked ? null : (tx.sender?.displayName ?? null),
    receiverId: receiverMasked ? null : tx.receiverId,
    receiverLabel: receiverMasked ? 'CheekyCheeseIT' : tx.receiverLabel,
    receiverName: receiverMasked ? null : (tx.receiver?.displayName ?? null),
    projectId: tx.projectId,
    projectName: tx.project?.name ?? null,
    payoutRequestId: tx.payoutRequestId,
    // security-review PR #443 (MED-1, round 4): expose the SAME origin
    // marker settleByCompany's HIGH-1/MED-B guard authoritatively reads
    // (pending-settlement.service.ts), so the settle dialog can mirror the
    // server's actual decision instead of re-deriving a weaker,
    // FK-dependent approximation from payoutRequestId.
    dropCascadeOrigin: tx.dropCascadeOrigin,
    payoutRequest: tx.payoutRequest ?? null,
    seniorSharePercent: tx.seniorSharePercent,
    // task-team-senior-share-override. Snapshot source of the % above.
    // Legacy rows (created before column existed) return null and the UI
    // hides the source badge.
    seniorSharePercentSource: ((
      tx as Transaction & {
        seniorSharePercentSource?: string | null
      }
    ).seniorSharePercentSource ?? null) as 'PROJECT' | 'TEAM' | 'USER_DEFAULT' | null,
    receiptDocumentId: tx.receiptDocumentId,
    receiptExternalUrl: tx.receiptExternalUrl,
    txHash: tx.txHash,
    // task-onchain-payment-integrity. On-chain SENDER of the transfer behind
    // this row (payout settlement / company deposit) — recorded for audit,
    // never a gate. ADMIN/ACCOUNTANT only: it is investigation data, and the
    // same masking rationale as the counterparty/validatedBy fields applies
    // (a raw wallet address of another party must not leak to SENIOR/DROP).
    txFromAddress: privileged
      ? ((tx as Transaction & { txFromAddress?: string | null }).txFromAddress ?? null)
      : null,
    // RBAC identity-masking (follow-up to createdBy masking, security review
    // PR #385; same class as counterparty masking, PR #384). `validatedBy` is
    // the audit UUID of the validator — validation is ADMIN/ACCOUNTANT-only
    // (`PATCH /transactions/:id/validate` is @Roles('ADMIN','ACCOUNTANT')), so
    // a non-privileged viewer is NEVER the validator and the raw admin UUID
    // would otherwise leak on their own VALIDATED rows (e.g. a SENIOR seeing
    // which admin approved their SENIOR_INCOME). Disclose the real id ONLY to
    // ADMIN/ACCOUNTANT; for every other viewer strip it. Mirrors the
    // `createdBy` self-preserve form below for consistency (the
    // `=== viewer.id` branch never fires for validatedBy in practice — kept so
    // the two audit fields stay structurally identical and no future
    // self-validation path can silently leak).
    validatedBy: privileged || tx.validatedBy === viewer.id ? tx.validatedBy : null,
    validatedAt: tx.validatedAt ? tx.validatedAt.toISOString() : null,
    rejectionReason: tx.rejectionReason,
    notes: tx.notes,
    salaryMonth: tx.salaryMonth,
    txDate: tx.txDate ? tx.txDate.toISOString() : null,
    // Drop role - phase 2. Optional explicit recipient — populated on
    // PAYOUT_DROP today; null on every legacy row. Exposing on the DTO so
    // the frontend list/detail views can distinguish drop payouts cleanly.
    recipientId: (tx as Transaction & { recipientId?: string | null }).recipientId ?? null,
    // RBAC identity-masking (follow-up to counterparty masking, security
    // review PR #384). `createdBy` is the audit UUID of the registrar — an
    // ADMIN/ACCOUNTANT on virtually every row, or the SENIOR/DROP themselves
    // on self-declared income (createSeniorIncome / createDropIncome stamp
    // createdBy = receiverId = self). Disclose the real id ONLY to
    // ADMIN/ACCOUNTANT; for every other viewer strip it so a
    // SENIOR/JUNIOR/DROP/HR can never harvest which admin booked a payout.
    //
    // Exception — the viewer's OWN id is preserved: it leaks nothing (they
    // already know it) and it keeps the frontend author gate working
    // (`canAttachReceipt` treats `createdBy === currentUserId` as the author,
    // who may attach/replace a receipt on their own self-declared income).
    // A blank null here would silently remove that affordance for SENIOR/DROP.
    createdBy: privileged || tx.createdBy === viewer.id ? tx.createdBy : null,
    createdAt: tx.createdAt.toISOString(),
    updatedAt: tx.updatedAt.toISOString(),
    // task-soft-delete-and-money-audit. No masking needed here: mapTx only
    // ever receives a deleted row for a privileged (ADMIN/ACCOUNTANT)
    // viewer — findAll's default query excludes deleted rows for everyone,
    // findOne's assertVisibleDespiteDeletion 404s a non-privileged caller
    // BEFORE mapTx is ever reached.
    deletedAt: tx.deletedAt ? tx.deletedAt.toISOString() : null,
    deletedBy: tx.deletedBy ?? null,
    deletionReason: tx.deletionReason ?? null,
  }
}
