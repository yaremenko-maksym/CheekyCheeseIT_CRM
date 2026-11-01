import type { Locale } from '../../i18n'

/**
 * Source-fetch-strategy U5a — message parameters shared by the popup detail and the email, so the
 * two surfaces cannot word the same event differently.
 */

/**
 * A day for people, by the reader's locale (`26 жовтня` / `October 26`), never raw ISO.
 * Always placed on the Kyiv calendar (the company's day, as the 09:00 report and the email cap use).
 * A bare `YYYY-MM-DD` parses as UTC midnight, which is 02:00 or 03:00 of the SAME date in Kyiv, so
 * one path serves both a date and an instant.
 */
export function formatDay(value: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    timeZone: 'Europe/Kyiv',
  }).format(new Date(value))
}

export interface SourceAlertFacts {
  sourceName: string
  state: string
  failures?: number | null | undefined
  since?: string | null | undefined
}

/**
 * Parameters of the alert sentence. `hasCount` selects the branch (like `hasProject` elsewhere in
 * the registry): the CAPPED sentence names the failure count and the day they began only when the
 * event carried BOTH.
 */
export function sourceAlertParams(d: SourceAlertFacts, locale: Locale) {
  const counted = d.failures != null && d.since != null
  return {
    source: d.sourceName,
    state: d.state,
    hasCount: counted ? 'yes' : 'no',
    failures: d.failures ?? 0,
    since: d.since != null ? formatDay(d.since, locale) : '',
  }
}
