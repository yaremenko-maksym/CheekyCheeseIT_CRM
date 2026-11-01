import { transactionBusinessDay, type TransactionDto } from '@crm/shared'

/** The stored business day (`YYYY-MM-DD`) of a row — the form's initial value. */
export function storedTxDate(tx: Pick<TransactionDto, 'txDate' | 'createdAt'>): string {
  return transactionBusinessDay(tx.txDate, tx.createdAt) ?? ''
}

/**
 * The date part of an admin-edit payload, or `{}` when the day is untouched.
 *
 * The form is pre-filled with the stored day, so resending it would push a
 * legacy row older than the backdating window through the server's date policy
 * on a notes-only edit. Only a day that differs is sent, and only then does the
 * (trimmed, non-empty) reason travel with it.
 */
export function changedTxDatePayload(
  tx: Pick<TransactionDto, 'txDate' | 'createdAt'>,
  txDate: string,
  backdateReason: string,
): { txDate?: string; backdateReason?: string } {
  if (!txDate || txDate === storedTxDate(tx)) return {}
  const reason = backdateReason.trim()
  return reason ? { txDate, backdateReason: reason } : { txDate }
}
