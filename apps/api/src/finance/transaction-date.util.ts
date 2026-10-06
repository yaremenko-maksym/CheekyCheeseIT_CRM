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
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== rawTxDate) {
    throw new RangeError(`Invalid transaction business date: ${rawTxDate}`)
  }

  return parsed
}

export function resolveTransactionDate(
  rawTxDate: string | null | undefined,
  now: Date = new Date(),
): Date {
  if (!rawTxDate) return now

  const parsed = parseTransactionBusinessDate(rawTxDate)

  return rawTxDate === now.toISOString().slice(0, 10) ? now : parsed
}
