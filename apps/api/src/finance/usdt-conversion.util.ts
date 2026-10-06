import { HttpStatus } from '@nestjs/common'

import type { CurrencyEnum } from '@crm/shared'
import { apiError } from '../common/api-error'

/**
 * Phase 8 v2 — convert a scaled-integer (minor units, ×1e6) amount in a source
 * currency into USDT minor units, using NBU UAH cross-rates.
 *
 * USDT is pegged 1:1 to USD (NbuCurrencyService returns usdtUah === usdUah),
 * so:
 *   - USDT / USD → identity (1 USD == 1 USDT).
 *   - EUR  → USDT: amount * (eurUah / usdUah)  (EUR→UAH→USD≡USDT).
 *   - UAH  → USDT: amount / usdUah.
 *
 * Integer-domain arithmetic on the scaled minor units (no float accumulation):
 * we multiply by the rate ratio with a single Math.round, mirroring the
 * decimal-safe aggregation used elsewhere in createPayoutRequest.
 *
 * `rates` is fetched ONCE per payout (today's NBU snapshot) and passed in so
 * the conversion is deterministic across the whole batch.
 */
export function convertToUsdtMinor(
  amountMinor: number,
  // code-review LOW: strict currency union (canonical `CurrencyEnum` from
  // @crm/shared = 'USDT' | 'USD' | 'EUR' | 'UAH') instead of bare `string`,
  // so the switch is exhaustive at compile time and an unsupported currency
  // is a type error at the call site, not a runtime surprise. The default
  // branch is kept as a defensive runtime backstop for data that bypasses the
  // Zod boundary (e.g. a legacy DB row outside the enum).
  currency: CurrencyEnum,
  rates: { usdUah: number; eurUah: number },
): number {
  switch (currency) {
    case 'USDT':
    case 'USD':
      return amountMinor
    case 'EUR':
      return Math.round((amountMinor * rates.eurUah) / rates.usdUah)
    case 'UAH':
      return Math.round(amountMinor / rates.usdUah)
    default:
      throw apiError('FINANCE_USDT_CONVERSION_CURRENCY_UNSUPPORTED', HttpStatus.BAD_REQUEST, {
        currency: String(currency),
      })
  }
}
