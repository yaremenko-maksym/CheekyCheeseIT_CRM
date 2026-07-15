/**
 * task-receipts-frontend — single shared RBAC+status gate for the
 * attach/replace-receipt UI (row icon, detail button, and the Sheet itself).
 *
 * Kept in one file and imported everywhere the affordance can appear so the
 * three surfaces never drift apart (a classic bug shape: "visible in the row
 * but not in details" or vice versa). This is a UI-level gate only — the
 * backend (`PATCH /transactions/:id/receipt`) re-implements the SAME rule
 * server-side (defense-in-depth); the frontend is never the source of
 * authorization.
 *
 * Rules (pm-brief §6 / task-receipts-frontend RBAC table):
 *   - ADMIN / ACCOUNTANT — may attach/replace on ANY transaction, any status.
 *   - The author (`tx.createdBy === currentUserId`) — may attach when there is
 *     no receipt yet (any status), and may replace while status !== 'PAID'.
 *     Once PAID, only ADMIN/ACCOUNTANT may replace an author's receipt.
 *   - Everyone else — no attach/replace.
 */
import type { TransactionDto } from '@crm/shared'

export function canAttachReceipt(
  tx: Pick<TransactionDto, 'createdBy' | 'receiptDocumentId' | 'receiptExternalUrl' | 'status'>,
  currentUserId: string | null | undefined,
  role: string,
): boolean {
  const isPrivileged = role === 'ADMIN' || role === 'ACCOUNTANT'
  const hasReceipt = !!(tx.receiptDocumentId || tx.receiptExternalUrl)
  const isAuthor = !!currentUserId && tx.createdBy === currentUserId
  return isPrivileged || (isAuthor && (!hasReceipt || tx.status !== 'PAID'))
}
