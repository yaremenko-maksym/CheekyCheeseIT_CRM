import { HttpStatus } from '@nestjs/common'
import {
  kyivDayOf,
  kyivMonthOf,
  MAX_TRANSACTION_BUSINESS_YEAR,
  MIN_TRANSACTION_BUSINESS_YEAR,
} from '@crm/shared'
import { apiError } from '../common/api-error'

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
    // SR-809-L-2: a bare `RangeError` leaves Nest with nothing to map and
    // surfaces as a 500. A malformed date is the caller's mistake, so it is a
    // 400 with a translatable code like every other finance rejection. The Zod
    // boundary normally rejects first; this is the defense-in-depth copy for a
    // caller that reached the service without it.
    throw apiError('FINANCE_TX_DATE_INVALID', HttpStatus.BAD_REQUEST)
  }

  // SR-809-L-2: the same sane year window the shared Zod schema applies. Year 0
  // parses in JS but has no `timestamptz` representation in Postgres, so without
  // this the insert failed in the driver and the operator saw a 500.
  const year = parsed.getUTCFullYear()
  if (year < MIN_TRANSACTION_BUSINESS_YEAR || year > MAX_TRANSACTION_BUSINESS_YEAR) {
    throw apiError('FINANCE_TX_DATE_INVALID', HttpStatus.BAD_REQUEST)
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

/**
 * The business month (`YYYY-MM`) a transaction belongs to.
 *
 * A `txDate` is a date-only business value encoded at UTC midnight (see above),
 * so its own UTC month IS the business month. The `createdAt` fallback is a real
 * instant, so it is bucketed by the KYIV month: between 00:00 and 02:00/03:00
 * Kyiv on the 1st its UTC month is still the previous one.
 */
export function transactionBusinessMonth(tx: { txDate: Date | null; createdAt: Date }): string {
  return tx.txDate ? tx.txDate.toISOString().slice(0, 7) : kyivMonthOf(tx.createdAt)
}

/**
 * An omitted date means "today" on the KYIV business-day clock, the same clock
 * the web defaults and the policy window use. Resolving it as a bare `now` would
 * give a UTC date one day behind the business day for the 2-3 hours after Kyiv
 * midnight, mis-filing the row (and, on the Kyiv 1st, its month).
 */
export function resolveTransactionDate(
  rawTxDate: string | null | undefined,
  now: Date = new Date(),
): Date {
  const businessDay = rawTxDate || kyivDayOf(now)

  const parsed = parseTransactionBusinessDate(businessDay)

  return businessDay === formatTransactionBusinessDate(now) ? now : parsed
}
