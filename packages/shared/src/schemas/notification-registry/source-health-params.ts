import type { Locale } from '../../i18n'

/**
 * Source-fetch-strategy U5a — message parameters shared by the popup detail and the email, so the
 * two surfaces cannot word the same event differently.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/**
 * A day for people, by the reader's locale (`26 жовтня` / `October 26`), never raw ISO.
 * A bare `YYYY-MM-DD` is already a Kyiv calendar date and is formatted as written; an instant is
 * placed on the Kyiv calendar first (the company's day, as the 09:00 report and the email cap use).
 */
export function formatDay(value: string, locale: Locale): string {
  const dateOnly = DATE_ONLY.test(value)
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    timeZone: dateOnly ? 'UTC' : 'Europe/Kyiv',
  }).format(new Date(dateOnly ? `${value}T00:00:00Z` : value))
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
 * event carried both.
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
