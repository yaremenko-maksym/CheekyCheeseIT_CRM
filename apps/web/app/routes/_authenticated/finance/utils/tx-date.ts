import { formatDate, transactionBusinessDay, type Locale } from '@crm/shared'

/**
 * Display date of a transaction row: its BUSINESS DAY (`transactionBusinessDay`
 * in `@crm/shared`) — the `txDate` day, or the KYIV day of `createdAt` for a
 * legacy NULL-`txDate` row.
 *
 * Backlog 338 (QA-LOW-1): this is the same day the server floors a later
 * payment on and the pickers offer as their minimum, so the cell, the hint and
 * the bound agree in every browser zone. It used to render `createdAt` in the
 * browser's own zone, which disagreed with the floor by a day in Los Angeles,
 * and in Kyiv between 21:00 and 24:00 UTC.
 *
 * An unparseable value renders `—` instead of throwing a `RangeError`.
 */
export function formatTxOrCreated(
  txDate: string | Date | null | undefined,
  createdAt: string | Date,
  locale: Locale,
): string {
  const day = transactionBusinessDay(txDate, createdAt)
  return day ? formatDate(`${day}T00:00:00.000Z`, locale, 'shortYYUtc') : '—'
}
