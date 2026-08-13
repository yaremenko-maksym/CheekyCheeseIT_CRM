/**
 * Decimal-safe share-of-income rounding — SINGLE SOURCE OF TRUTH.
 *
 * task-admin-income-unified. The API books a senior/drop obligation with
 * `roundShareAmount` (`bookCompanyObligations` / `computeDropDistribution` in
 * `apps/api/src/finance/transactions.service.ts`) the moment a USDT-project
 * income is created. The web client now has to PREDICT that exact amount
 * BEFORE submit, so the pre-submit banner in `CreateTransactionDialog` can
 * tell the caller "Дропу X будет начислено N USDT" without lying. A second,
 * independently-written rounding formula in `apps/web` — even one that is
 * numerically identical today — would drift the next time either side is
 * touched, and the banner would promise a number the server does not create.
 * This module lives in `@crm/shared` so both sides call the SAME function.
 */

/**
 * Scaled-integer constant used throughout money aggregations to avoid JS
 * float accumulation errors (same scale as the write-path in confirmPayout /
 * payPayoutRequest: 1e6, round to int).
 */
export const MONEY_SCALE = 1_000_000

/**
 * Decimal-safe `income × percent / 100` at the numeric(18,6) precision the
 * amount column persists. Scale to integer minor units, round once, divide
 * back and fix to 6 decimals — avoids IEEE-754 drift so two shares of the
 * same income reconcile against the gross.
 */
export function roundShareAmount(income: number, percent: number): number {
  const incomeMinor = Math.round(income * MONEY_SCALE)
  const shareMinor = Math.round((incomeMinor * percent) / 100)
  return Number((shareMinor / MONEY_SCALE).toFixed(6))
}
