import type { Locale } from './locales'

const INTL_TAG: Record<Locale, string> = { uk: 'uk-UA', en: 'en-GB' }

export function formatDate(
  value: Date | string,
  locale: Locale,
  // Stryker disable next-line StringLiteral: the default is only ever compared against 'long' below, so any non-'long' default value is behaviorally identical for every caller that omits `style` — provably equivalent, not a coverage gap.
  style: 'short' | 'long' = 'short',
): string {
  // `new Date(x)` accepts a `Date` exactly as well as a date string — a
  // Date passed through its own constructor keeps the same instant
  // (verified: `new Date(d).getTime() === d.getTime()` for every `d`) — so
  // there is no separate "already a Date" branch to write; a ternary here
  // would only ever be a no-op copy-constructor call on one side.
  const d = new Date(value)
  const opts: Intl.DateTimeFormatOptions =
    style === 'long'
      ? { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }
      : { timeZone: 'UTC' }
  return new Intl.DateTimeFormat(INTL_TAG[locale], opts).format(d)
}

export function formatNumber(n: number, locale: Locale): string {
  return new Intl.NumberFormat(INTL_TAG[locale]).format(n)
}

/** Money is always `<amount> <CODE>` — USDT has no Intl currency, so the code is appended uniformly. */
export function formatMoney(
  amount: number | string,
  currency: 'USDT' | 'USD' | 'EUR' | 'UAH',
  locale: Locale,
): string {
  // `Number(x)` is a no-op for an already-`number` `x` (`Number(5) === 5`),
  // so there is no separate "already a number" branch to write either —
  // same reasoning as `formatDate` above.
  const n = Number(amount)
  const body = new Intl.NumberFormat(INTL_TAG[locale], {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
  return `${body} ${currency}`
}

export function compareNames(locale: Locale): (a: string, b: string) => number {
  const collator = new Intl.Collator(INTL_TAG[locale], { sensitivity: 'base' })
  return (a, b) => collator.compare(a, b)
}

/**
 * task-i18n-stage3a (Task 1), Step 3 — replaces `date-fns`'s
 * `formatDistanceToNow` + `date-fns/locale/ru` (notifications-bell.tsx):
 * `Intl.RelativeTimeFormat` covers the same "X minutes ago" need with the
 * locale determined by the caller, no extra bundle weight. Picks the
 * largest whole unit that fits (year > month > day > hour > minute >
 * second) — a value under a second falls through to `second` regardless
 * (the loop's own `unit === 'second'` guard), matching `numeric: 'auto'`'s
 * "now" wording for that case.
 */
export function formatRelativeTime(value: Date | string, locale: Locale): string {
  const d = typeof value === 'string' ? new Date(value) : value
  const diffSeconds = Math.round((d.getTime() - Date.now()) / 1000)
  const rtf = new Intl.RelativeTimeFormat(INTL_TAG[locale], { numeric: 'auto' })
  const abs = Math.abs(diffSeconds)
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ]
  for (const [unit, secondsPerUnit] of units) {
    if (abs >= secondsPerUnit || unit === 'second') {
      return rtf.format(Math.round(diffSeconds / secondsPerUnit), unit)
    }
  }
  return rtf.format(0, 'second')
}
