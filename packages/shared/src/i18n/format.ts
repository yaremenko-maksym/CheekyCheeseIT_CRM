import type { Locale } from './locales'

const INTL_TAG: Record<Locale, string> = { uk: 'uk-UA', en: 'en-GB' }

/**
 * task-i18n-stage3a (Task 1) — added two styles alongside the pre-existing
 * 'short'/'long':
 *  - 'month': `EarningsSparkline.tsx`'s hand-rolled Russian `MONTH_ABBR`
 *    array (a `YYYY-MM` key → one of 12 literal RU strings) needed a
 *    locale-aware SHORT month name with NO day/year.
 *  - 'monthYear': `EarningsStatsBlock.tsx`'s hand-rolled Russian
 *    `RU_MONTHS`/`ruMonthYear` needed a locale-aware FULL month name + year
 *    with NO day — a monthly aggregate label ("Травень 2026"), not a
 *    specific date; 'long' would misleadingly imply day-level precision.
 * Neither pre-existing style fits either need. Additive only: existing
 * callers that omit `style` or pass 'long' see byte-identical behavior.
 */
export function formatDate(
  value: Date | string,
  locale: Locale,
  style: 'short' | 'long' | 'month' | 'monthYear' = 'short',
): string {
  // `new Date(x)` accepts a `Date` exactly as well as a date string — a
  // Date passed through its own constructor keeps the same instant
  // (verified: `new Date(d).getTime() === d.getTime()` for every `d`) — so
  // there is no separate "already a Date" branch to write; a ternary here
  // would only ever be a no-op copy-constructor call on one side.
  const d = new Date(value)
  const STYLE_OPTS: Record<'short' | 'long' | 'month' | 'monthYear', Intl.DateTimeFormatOptions> = {
    short: { timeZone: 'UTC' },
    long: { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' },
    month: { month: 'short', timeZone: 'UTC' },
    monthYear: { month: 'long', year: 'numeric', timeZone: 'UTC' },
  }
  return new Intl.DateTimeFormat(INTL_TAG[locale], STYLE_OPTS[style]).format(d)
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
 * largest whole unit that fits (year > month > day > hour > minute); a
 * value under a minute falls through to the `second` return after the loop
 * (`diffSeconds` is already the rounded seconds value, `Math.round(x / 1)`
 * would be a no-op), matching `numeric: 'auto'`'s "now" wording for the
 * abs===0 case.
 *
 * CI-2/CR-H-2 (fix-round 2, @crm/shared mutation gate): an earlier version
 * kept `['second', 1]` as a 6th `units` entry and used
 * `if (abs >= secondsPerUnit || unit === 'second')` to force a match on the
 * last iteration regardless of `abs`. That disjunct produced FOUR distinct
 * mutants sharing one line/mutator pair (whole-condition-true,
 * whole-condition-false, left-operand-false, right-operand-false) — only
 * the last of those four is equivalent, but Stryker's `// Stryker disable
 * next-line <mutator>` suppresses every mutant of that mutator ON THAT LINE,
 * not one specific AST node, so silencing the equivalent one would have
 * ALSO silenced the other three, which are real bugs (verified against the
 * raw JSON report, not assumed). Dropping the `second` entry and the
 * disjunct removes the equivalent-mutant trap by construction instead of
 * suppressing around it — the fallthrough `second` handling now lives on
 * its own line, reachable exactly when `abs < 60`, nothing to suppress.
 */
export function formatRelativeTime(value: Date | string, locale: Locale): string {
  // `new Date(x)` accepts a `Date` exactly as well as a date string (same
  // no-op-copy-constructor reasoning as `formatDate`'s own `d` above) — no
  // separate "already a Date" ternary to write.
  const d = new Date(value)
  const diffSeconds = Math.round((d.getTime() - Date.now()) / 1000)
  const rtf = new Intl.RelativeTimeFormat(INTL_TAG[locale], { numeric: 'auto' })
  const abs = Math.abs(diffSeconds)
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ]
  for (const [unit, secondsPerUnit] of units) {
    if (abs >= secondsPerUnit) {
      return rtf.format(Math.round(diffSeconds / secondsPerUnit), unit)
    }
  }
  return rtf.format(diffSeconds, 'second')
}
