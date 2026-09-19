import type { Locale } from './locales'

const INTL_TAG: Record<Locale, string> = { uk: 'uk-UA', en: 'en-GB' }

export function formatDate(
  value: Date | string,
  locale: Locale,
  style: 'short' | 'long' = 'short',
): string {
  const d = typeof value === 'string' ? new Date(value) : value
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
  const n = typeof amount === 'string' ? Number(amount) : amount
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
