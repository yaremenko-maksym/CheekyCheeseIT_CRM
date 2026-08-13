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

/**
 * task-drop-payout-currency (security-review PR #521 round 3, MED-A): the
 * settle-time counterpart of `@crm/shared`'s `transactionAmountError` for a
 * SERVER-COMPUTED payout figure where **zero is a legitimate value**, not
 * garbage.
 *
 * A DROP obligation is booked as `share% × income` with NO zero-filtering
 * (`bookCompanyObligations` in transactions.service.ts) — the share itself
 * is `min(0)`-validated (users.ts / projects.ts allow an explicit 0%
 * override), so a 0%-share drop genuinely owes 0 and its obligation must be
 * closeable like any other. `transactionAmountError` rejects `value <= 0`
 * unconditionally — correct for a CLIENT-TYPED amount, where 0 always means
 * "field left empty", but reusing it verbatim for THIS server-derived figure
 * permanently strands every zero-amount drop obligation in "Ожидает
 * выплаты" (security-review PR #521 round 3, MED-A). This keeps every OTHER
 * guard `transactionAmountError` enforces for a payout figure (finite,
 * ceiling) — it only widens the floor from "> 0" to ">= 0". Not reused for
 * the SENIOR path (unaffected — `paidAmount` there is never computed, the
 * flipped row's `amount` column is left untouched) nor for `paySalary`
 * (a $0 salary payment is not a case that flow needs to support).
 */
export function settledAmountError(value: number, maxAmount: number): string | null {
  if (!Number.isFinite(value)) return 'Сумма выплаты должна быть числом'
  if (value < 0) return 'Сумма выплаты не может быть отрицательной'
  if (value > maxAmount) {
    return `Сумма не может превышать ${maxAmount.toLocaleString('ru-RU')}`
  }
  return null
}
