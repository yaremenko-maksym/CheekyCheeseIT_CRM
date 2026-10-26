import { z } from 'zod'
import type { PaymentMethod, UserProfileDto } from '@crm/shared'
import { seniorTechStackSchema, updateProfileSchema } from '@crm/shared'
import { translateZodMessage } from '@/lib/axios-utils'
import type { Currency } from '@/components/ui/amount-currency-input'
import { api } from '@/lib/axios'
import type { Role } from '../constants'

/**
 * Inline SENIOR technology floor — the shared `seniorTechStackSchema`, so the
 * form and the API count technologies the same way. `undefined` = valid.
 * `original` is the stored user on edit: like the API (A1), a SENIOR whose stack
 * and role are unchanged is not checked, so a legacy SENIOR below the floor can
 * still save unrelated edits.
 */
export function seniorTechStackError(
  role: string,
  stack: readonly string[],
  original?: { role: string; techStack: readonly string[] | null | undefined },
): string | undefined {
  if (role !== 'SENIOR') return undefined
  const before = original?.techStack ?? []
  const unchanged = stack.length === before.length && stack.every((tech, i) => tech === before[i])
  if (original?.role === 'SENIOR' && unchanged) return undefined
  const r = seniorTechStackSchema.safeParse([...stack])
  // Stryker disable next-line OptionalChaining: a failed safeParse always carries an issue; `?` only satisfies noUncheckedIndexedAccess
  return r.success ? undefined : translateZodMessage(r.error.issues[0]?.message)
}

export const telegramFieldSchema = updateProfileSchema.shape.telegram.unwrap().unwrap()
export const phoneFieldSchema = z.string().max(30)

// USDT/Bank requisite validators — mirror the shared schema patterns so the
// inline field errors match what the backend would return.
export const usdtWalletPattern = /^0x[a-fA-F0-9]{40}$/
export const ibanPattern = /^UA\d{27}$/
export const rnokppPattern = /^\d{10}$/

/**
 * Default payment method per role. SENIOR / ADMIN are USDT-only (enforced both
 * frontend & backend). Other roles default to BANK_UAH_FOP since most internal
 * payouts (HR, JUNIOR, ACCOUNTANT) go through ФОП in UAH.
 */
export function defaultPaymentMethod(role: Role): PaymentMethod {
  return role === 'SENIOR' || role === 'ADMIN' ? 'USDT_ERC20' : 'BANK_UAH_FOP'
}

export async function fetchUsersForDialog(): Promise<UserProfileDto[]> {
  const res = await api.get<UserProfileDto[]>('/users')
  return res.data
}

export type ExchangeRates = { usdUah: string; usdtUah: string; eurUah: string; date: string }

/**
 * Convert an amount in the picked currency to USD. Mirrors the conversion
 * used by `AmountCurrencyInput` so the value we persist matches what the
 * admin saw in the "≈ USD" badge.
 */
export function toUsd(amount: number, currency: Currency, rates: ExchangeRates): number {
  // Stryker disable next-line ConditionalExpression,LogicalOperator,StringLiteral: equivalent mutants — USD/USDT passthrough returns `amount`, identical to the final fallthrough `return amount`, so breaking this guard is unobservable
  if (currency === 'USD' || currency === 'USDT') return amount
  if (currency === 'EUR') return amount * (parseFloat(rates.eurUah) / parseFloat(rates.usdUah))
  if (currency === 'UAH') return amount / parseFloat(rates.usdUah)
  return amount
}
