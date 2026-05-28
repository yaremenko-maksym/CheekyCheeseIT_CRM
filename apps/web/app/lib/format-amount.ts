/**
 * formatAmount — single source of truth for currency amount formatting.
 *
 * UT round 1 feedback: notification body used to print raw transaction
 * `amount` like `1500.000000 USDT` (Postgres NUMERIC trailing zeros).
 * This helper normalises to `1 500,00 USDT` using the same Russian locale
 * we already use for dates, with a hard cap of 2 decimals.
 *
 * Accepts either string (DB NUMERIC → ts string) or number. Non-finite
 * inputs fall back to a raw `"${value} ${currency}"` so we still display
 * something meaningful instead of `NaN`.
 *
 * Reused by every consumer that shows an amount: invoice cards / dialog /
 * notifications bell / public verify page.
 */
export function formatAmount(value: string | number, currency: string): string {
  const num = typeof value === 'string' ? parseFloat(value) : value
  if (!Number.isFinite(num)) return `${value} ${currency}`
  return `${num.toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`
}
