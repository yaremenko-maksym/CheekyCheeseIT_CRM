/**
 * Resolve an operator-selected calendar date to transactions.tx_date while
 * preserving the repository's established UTC-date encoding.
 *
 * Date-only inputs are represented by UTC midnight. For the current UTC day we
 * retain the real instant so same-day rows keep their natural ordering. This
 * is the pre-existing behavior; centralising it prevents transaction writers
 * from drifting while strict parsing prevents invalid dates from becoming
 * "now" silently. Legacy midnight rows are intentionally not rewritten; the
 * frontend sort already falls back to createdAt when business dates tie.
 */
export function parseTransactionBusinessDate(rawTxDate: string): Date {
  const parsed = new Date(`${rawTxDate}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || formatTransactionBusinessDate(parsed) !== rawTxDate) {
    throw new RangeError(`Invalid transaction business date: ${rawTxDate}`)
  }

  return parsed
}

/**
 * Stable business-day key for transaction timestamps.
 *
 * Transaction date-only values are encoded in UTC throughout the repository,
 * so comparisons must use the same UTC calendar components instead of local
 * timezone formatting.
 */
export function formatTransactionBusinessDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function resolveTransactionDate(
  rawTxDate: string | null | undefined,
  now: Date = new Date(),
): Date {
  if (!rawTxDate) return now

  const parsed = parseTransactionBusinessDate(rawTxDate)

  return rawTxDate === formatTransactionBusinessDate(now) ? now : parsed
}
