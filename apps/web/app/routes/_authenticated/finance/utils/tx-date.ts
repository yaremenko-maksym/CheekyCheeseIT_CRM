import { formatDate, type Locale } from '@crm/shared'

/**
 * Display date of a transaction row: the business date when there is one,
 * otherwise the creation instant.
 *
 * The two branches are different KINDS of value and need different formats:
 *  - `txDate` is a DATE-ONLY business field stored at UTC-midnight, so it is
 *    rendered with `shortYYUtc` (the same calendar day in any browser zone).
 *  - `createdAt` is a real INSTANT; `shortYYUtc` would show it a day early
 *    21:00-24:00 UTC, so it is rendered with the instant format `shortYY`.
 */
export function formatTxOrCreated(
  txDate: string | Date | null | undefined,
  createdAt: string | Date,
  locale: Locale,
): string {
  return txDate
    ? formatDate(txDate, locale, 'shortYYUtc')
    : formatDate(createdAt, locale, 'shortYY')
}

/**
 * The calendar day (`YYYY-MM-DD`) that `formatTxOrCreated` displays for the
 * same arguments: one definition of "which day", so a bound or a hint derived
 * from a row can never name a different day than the row's own date cell.
 *
 *  - `txDate` set: the UTC day of the date-only value.
 *  - `txDate` NULL (legacy rows): the day of the `createdAt` INSTANT in the
 *    browser's own zone, exactly as `formatTxOrCreated` renders it. Reading
 *    the UTC day here instead disagreed with the displayed day by one west of
 *    UTC (and 21:00-24:00 UTC in Kyiv) - backlog 338, QA-LOW-1.
 */
export function txDisplayDay(
  txDate: string | Date | null | undefined,
  createdAt: string | Date,
): string {
  if (txDate) return new Date(txDate).toISOString().slice(0, 10)
  const at = new Date(createdAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}
