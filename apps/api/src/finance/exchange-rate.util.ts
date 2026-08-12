/**
 * task-salary-pay-amount — bounds of `transactions.exchange_rate`
 * (`numeric(18,8)`): 10 integer digits and 8 fractional ones.
 *
 * security-review PR #485 (related to MED-1). The rate is DERIVED
 * (`paid / original`), so an extreme pair of amounts can produce a value the
 * column cannot hold:
 *   - at or above 1e10 Postgres raises a raw «numeric field overflow» — which
 *     failed CLOSED (the pay transaction rolled back, the row stayed PENDING)
 *     but told the user nothing;
 *   - below 1e-8 there is no error at all, which is worse: the value is
 *     silently stored as `0.00000000`, so the row claims a rate of ZERO when
 *     the real one was merely tiny.
 * Neither is written. Callers store NULL instead — see the reasoning at the
 * call sites (`TransactionsService.paySalary`,
 * `PendingSettlementService.settleByCompany`) for why a derived field's
 * width must not veto a payment whose amounts are both storable.
 *
 * task-drop-payout-currency: extracted out of `transactions.service.ts` so
 * `pending-settlement.service.ts` (settling a DROP obligation in any of the
 * four currencies) can apply the EXACT same storability rule instead of
 * growing a second copy — see the schema.ts column comment on
 * `transactions.exchangeRate` for the invariant this protects.
 */
export const EXCHANGE_RATE_MAX_EXCLUSIVE = 1e10
export const EXCHANGE_RATE_MIN = 1e-8

export function isStorableExchangeRate(rate: number): boolean {
  return Number.isFinite(rate) && rate >= EXCHANGE_RATE_MIN && rate < EXCHANGE_RATE_MAX_EXCLUSIVE
}
