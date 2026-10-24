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
