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

/**
 * Variant of `formatAmount` that prepends a `$` and uses the en-US locale
 * grouping (1,000.00). Output shape: `$3,500.00 USDT`.
 *
 * Introduced for Phase 4-B round 2 — the FinanceTab «Приходы, ожидающие
 * оплаты компании» list and the pending-cash card on /crm/finance both
 * surface drop incomes in this shape. We keep the original `formatAmount`
 * (ru-RU locale) untouched so existing invoice / notification surfaces
 * don't change. Non-finite inputs fall back to a raw `"${value} ${currency}"`
 * for parity with `formatAmount`.
 */
export function formatAmountUsd(value: string | number, currency: string): string {
  const num = typeof value === 'string' ? parseFloat(value) : value
  if (!Number.isFinite(num)) return `${value} ${currency}`
  return `$${num.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`
}
