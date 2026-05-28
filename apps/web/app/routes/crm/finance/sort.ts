/**
 * Pure comparator helpers for transactions table sorting.
 *
 * Extracted into a standalone module so `compareTxByDate` / `compareTxByAmount`
 * can be unit-tested without rendering the page (TanStack Router + Query stack
 * is heavy and irrelevant for sort logic).
 *
 * `compareTxByDate` uses `txDate` as the primary key with a `createdAt`
 * tie-breaker — this is the contract that keeps newly created rows on top of
 * older rows that share the same calendar date (e.g. legacy midnight-UTC
 * `txDate` rows from before backend started storing a full timestamp).
 */
export type TxSortable = {
  txDate: string | null
  createdAt: string
  amount: string
}

export type SortDir = 'asc' | 'desc'

const toTime = (iso: string | null | undefined): number => (iso ? new Date(iso).getTime() : 0)

/**
 * Compare two transactions by date with a `createdAt` tie-breaker.
 *
 * - Primary key: `txDate ?? createdAt`
 * - Tie-breaker: `createdAt`
 *
 * Why a tie-breaker:
 * - Income rows often carry a midnight-UTC `txDate` (the `<input type="date">`
 *   parses to 00:00).
 * - Payout rows carry `txDate = null`, falling back to `createdAt` which
 *   includes the time-of-day.
 * - Without the tie-breaker, a payout created at 07:37 would sort *above*
 *   an income created at 08:17 — confusing because the income is newer.
 * - With the tie-breaker, equal `txDate` values fall through to `createdAt`,
 *   restoring "newest first" semantics for DESC.
 */
export function compareTxByDate(a: TxSortable, b: TxSortable, dir: SortDir): number {
  const mul = dir === 'asc' ? 1 : -1
  const aTime = toTime(a.txDate ?? a.createdAt)
  const bTime = toTime(b.txDate ?? b.createdAt)
  if (aTime !== bTime) return mul * (aTime - bTime)
  return mul * (toTime(a.createdAt) - toTime(b.createdAt))
}

export function compareTxByAmount(a: TxSortable, b: TxSortable, dir: SortDir): number {
  const mul = dir === 'asc' ? 1 : -1
  return mul * (parseFloat(a.amount) - parseFloat(b.amount))
}
