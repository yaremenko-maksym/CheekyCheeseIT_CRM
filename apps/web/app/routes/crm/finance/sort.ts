/**
 * Pure comparator helpers for transactions table sorting.
 *
 * Extracted into a standalone module so `compareTxByDate` / `compareTxByAmount`
 * can be unit-tested without rendering the page (TanStack Router + Query stack
 * is heavy and irrelevant for sort logic).
 *
 * `compareTxByDate` always uses `createdAt` — the row's actual insertion
 * timestamp — as the sort key. `txDate` is a presentational field (used only
 * in the «Дата» column) and may be midnight-UTC for legacy income rows or
 * `null` for payouts, so it does not give a stable "newest first" order.
 * `createdAt` is monotonic and unique, so no tie-breaker is needed.
 */
export type TxSortable = {
  txDate: string | null
  createdAt: string
  amount: string
}

export type SortDir = 'asc' | 'desc'

const toTime = (iso: string | null | undefined): number => (iso ? new Date(iso).getTime() : 0)

/**
 * Compare two transactions by `createdAt`.
 *
 * Rationale (see task-fix-transactions-sort-by-createdat.md):
 * - Income rows often carry midnight-UTC `txDate` (the `<input type="date">`
 *   parses to 00:00). Payout rows carry `txDate = null`.
 * - Using `txDate` as the primary key mixes those two scales and pushes
 *   newly-created income rows below older payouts on the same calendar day.
 * - `createdAt` is set by the DB on insert, is unique per row, and reflects
 *   the user's intuition of "what got added last shows up on top".
 */
export function compareTxByDate(a: TxSortable, b: TxSortable, dir: SortDir): number {
  const mul = dir === 'asc' ? 1 : -1
  return mul * (toTime(a.createdAt) - toTime(b.createdAt))
}

export function compareTxByAmount(a: TxSortable, b: TxSortable, dir: SortDir): number {
  const mul = dir === 'asc' ? 1 : -1
  return mul * (parseFloat(a.amount) - parseFloat(b.amount))
}
