import type { TransactionType, TransactionStatus } from '@crm/shared'
import { formatAmount } from '@/lib/format-amount'

export const TYPE_LABELS: Record<TransactionType, string> = {
  ADMIN_INCOME: 'Приход Admin',
  SENIOR_INCOME: 'Приход синьора',
  EXPENSE: 'Расход',
  SALARY: 'Зарплата',
  ADMIN_TRANSFER: 'Перевод',
  PAYOUT: 'Выплата',
  PAYOUT_ADMIN: 'Доля партнёра',
  // Drop role - phase 2. Minimal labels to satisfy the exhaustive Record<>
  // contract. UI polish (icons / placement in lists) lands in the Phase 2
  // frontend task.
  DROP_INCOME: 'Приход дропа',
  PAYOUT_DROP: 'Доля дропа',
}

export const STATUS_LABELS: Record<TransactionStatus, string> = {
  PENDING: 'Ожидает',
  VALIDATED: 'Подтверждено',
  PENDING_PAYMENT: 'Ожидает выплаты',
  REJECTED: 'Отклонено',
  PAID: 'Оплачено',
  LOCKED: 'Заблокировано',
}

export const STATUS_COLORS: Record<TransactionStatus, string> = {
  PENDING: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  // PR #56 final UT (AC2): SENIOR_INCOME flips to VALIDATED on validate (was
  // PENDING_PAYMENT). User asked for a green «Подтверждено» badge so the
  // terminal income status reads as a positive completion, not an in-flight
  // intermediate. PAID remains a brighter emerald.
  VALIDATED: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  PENDING_PAYMENT: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  REJECTED: 'bg-red-500/15 text-red-400 border-red-500/30',
  PAID: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  LOCKED: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
}

export const TYPE_COLORS: Record<TransactionType, string> = {
  ADMIN_INCOME: 'bg-green-500/15 text-green-400 border-green-500/30',
  SENIOR_INCOME: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  EXPENSE: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  SALARY: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  ADMIN_TRANSFER: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
  PAYOUT: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
  PAYOUT_ADMIN: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30',
  // Drop role - phase 2. Distinct tone (teal) so drop rows are visually
  // separable from PAYOUT/PAYOUT_ADMIN in mixed lists. Frontend task will
  // refine if needed.
  DROP_INCOME: 'bg-teal-500/15 text-teal-300 border-teal-500/30',
  PAYOUT_DROP: 'bg-teal-500/20 text-teal-200 border-teal-500/40',
}

export const EXPENSE_CATEGORIES = ['Оплата сервиса', 'Комиссия', 'Прочее']

/**
 * Original-currency amount for detail dialogs («7 777,00 USDT», «5 000,00 EUR»).
 *
 * AC3 (finance money strategy): detail views show the *source* currency +
 * amount so the user sees what was actually entered, while the transaction
 * table shows the USD-converted figure via `fmtUsd`. This delegates to the
 * shared `formatAmount` (lib/format-amount.ts) — the same helper invoices /
 * notifications use — so every "original amount" in the app is formatted
 * identically (ru-RU thin-space thousands, currency suffix). This is what
 * removed the ad-hoc Tugrik «₮» symbol that previously stood in for USDT.
 */
export function fmtAmount(amount: string | number, currency: string) {
  return formatAmount(amount, currency)
}

export type ExchangeRates = { usdUah: string; usdtUah: string; eurUah: string; date: string }

export function toUsd(amount: string | number, currency: string, rates: ExchangeRates): number {
  const n = typeof amount === 'string' ? parseFloat(amount) : amount
  if (currency === 'USD' || currency === 'USDT') return n
  if (currency === 'EUR') return n * (parseFloat(rates.eurUah) / parseFloat(rates.usdUah))
  if (currency === 'UAH') return n / parseFloat(rates.usdUah)
  return n
}

/**
 * USD-converted amount for the transaction table («$7 777,00»). USDT is
 * pegged 1:1 to USD so it passes through. Non-USD currencies convert via the
 * NBU rates; without rates loaded we fall back to the original-currency
 * format so the cell never renders a bare number.
 */
export function fmtUsd(
  amount: string | number,
  currency: string,
  rates: ExchangeRates | undefined,
): string {
  if (!rates) return fmtAmount(amount, currency)
  const usd = toUsd(amount, currency, rates)
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * Human-readable conversion-rate line for detail dialogs, e.g.
 * «1 EUR = 1.0800 USD» or «1 USD = 41.50 UAH». Returns null for USD/USDT
 * (no conversion happens) or when rates haven't loaded yet, so callers can
 * conditionally render the rate row.
 */
export function fmtRate(currency: string, rates: ExchangeRates | undefined): string | null {
  if (!rates) return null
  if (currency === 'EUR') {
    const eurUsd = parseFloat(rates.eurUah) / parseFloat(rates.usdUah)
    return `1 EUR = ${eurUsd.toFixed(4)} USD`
  }
  if (currency === 'UAH') {
    return `1 USD = ${parseFloat(rates.usdUah).toFixed(2)} UAH`
  }
  return null
}

export function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('uk-UA', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  })
}

export function fmtMonth(ym: string | null | undefined): string {
  if (!ym) return '—'
  const [year, month] = ym.split('-').map(Number)
  if (!year || !month) return ym
  return new Date(year, month - 1, 1).toLocaleDateString('ru-RU', {
    month: 'long',
    year: 'numeric',
  })
}
