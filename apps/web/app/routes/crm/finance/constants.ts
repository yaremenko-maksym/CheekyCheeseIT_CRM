import type { TransactionType, TransactionStatus } from '@crm/shared'

export const TYPE_LABELS: Record<TransactionType, string> = {
  ADMIN_INCOME: 'Приход Admin',
  SENIOR_INCOME: 'Приход синьора',
  EXPENSE: 'Расход',
  SALARY: 'Зарплата',
  ADMIN_TRANSFER: 'Перевод',
  PAYOUT: 'Выплата',
  PAYOUT_ADMIN: 'Доля партнёра',
}

export const STATUS_LABELS: Record<TransactionStatus, string> = {
  PENDING: 'Ожидает',
  VALIDATED: 'Подтверждено',
  REJECTED: 'Отклонено',
  PAID: 'Оплачено',
  LOCKED: 'Заблокировано',
}

export const STATUS_COLORS: Record<TransactionStatus, string> = {
  PENDING: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  VALIDATED: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
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
}

export const EXPENSE_CATEGORIES = [
  'Оплата сервиса',
  'Комиссия',
  'Прочее',
]

export function fmtAmount(amount: string | number, currency: string) {
  const n = typeof amount === 'string' ? parseFloat(amount) : amount
  const sym = currency === 'USDT' ? '₮' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '₴'
  return `${sym}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export type ExchangeRates = { usdUah: string; usdtUah: string; eurUah: string; date: string }

export function toUsd(amount: string | number, currency: string, rates: ExchangeRates): number {
  const n = typeof amount === 'string' ? parseFloat(amount) : amount
  if (currency === 'USD' || currency === 'USDT') return n
  if (currency === 'EUR') return n * (parseFloat(rates.eurUah) / parseFloat(rates.usdUah))
  if (currency === 'UAH') return n / parseFloat(rates.usdUah)
  return n
}

export function fmtUsd(amount: string | number, currency: string, rates: ExchangeRates | undefined): string {
  if (!rates) return fmtAmount(amount, currency)
  const usd = toUsd(amount, currency, rates)
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

export function fmtMonth(ym: string | null | undefined): string {
  if (!ym) return '—'
  const [year, month] = ym.split('-').map(Number)
  if (!year || !month) return ym
  return new Date(year, month - 1, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })
}
