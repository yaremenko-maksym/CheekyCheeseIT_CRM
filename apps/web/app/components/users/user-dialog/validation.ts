import { z } from 'zod'
import type { PaymentMethod, UserProfileDto } from '@crm/shared'
import { updateProfileSchema } from '@crm/shared'
import type { Currency } from '@/components/ui/amount-currency-input'
import { api } from '@/lib/axios'
import type { Role } from '../constants'

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
  if (currency === 'USD' || currency === 'USDT') return amount
  if (currency === 'EUR') return amount * (parseFloat(rates.eurUah) / parseFloat(rates.usdUah))
  if (currency === 'UAH') return amount / parseFloat(rates.usdUah)
  return amount
}
