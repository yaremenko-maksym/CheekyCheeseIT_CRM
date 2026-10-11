/**
 * Pure currency predicates for the senior/drop obligation settle flow.
 *
 * Extracted VERBATIM from `pending-settlement.service.ts` (giant-file
 * decomposition, leaf L1). Behavior-preserving move: the BIZ-03 whitelist and
 * the USD/USDT peg predicate are money-gate decisions and are byte-identical
 * to their previous module-private definitions.
 */
import { HttpStatus } from '@nestjs/common'
import { apiError } from '../common/api-error'
import type { BalanceCurrency } from './balance.service'

/**
 * security-review PR #521 round 3, LOW — mirrors the EXACT peg predicate
 * `convertToBase` (balance.service.ts) short-circuits on internally, so the
 * "nothing to convert, skip the NBU round-trip" fast path below covers a
 * DROP obligation settled USDT→USD (and not just the exact-string-match
 * USDT→USDT case it covered before). Kept local rather than exported from
 * `balance.service.ts` to avoid widening that shared file's surface for a
 * one-line predicate only this call site needs pre-rate-fetch — `
 * convertToBase` itself still applies the identical short-circuit
 * independently if this fast path is ever bypassed, so the two can never
 * disagree about what counts as a no-op pair.
 */
export function isUsdPegPair(a: BalanceCurrency, b: BalanceCurrency): boolean {
  const pegged = (c: BalanceCurrency) => c === 'USD' || c === 'USDT'
  return pegged(a) && pegged(b)
}

/**
 * BIZ-03 (HIGH) — canonical whitelist of currencies a SENIOR IOU may be
 * settled in. Every IOU is booked in USDT (see `bookCompanyObligations` /
 * `createIous` in transactions.service.ts); the downstream balance readers
 * (getSeniorBalance / getTotalEarned / getSummary) convert the RESOLVED
 * currency LABEL via `convertToBase`, which is only value-preserving for
 * USD/USDT (1:1 short-circuit) — UAH/EUR triangulate through NBU rates and
 * would silently UNDER-count the payout by ~40× IF the row's `amount` were
 * merely relabeled rather than actually converted (which is exactly what this
 * function existed to prevent — see the two call sites below).
 *
 * task-drop-payout-currency (2026-08): a DROP settle is EXEMPT from this
 * whitelist (both call sites below skip it when `isDropObligation`). That is
 * safe, not a relaxation of the underlying rule: the exemption only applies
 * together with the amount-conversion block in `settleByCompany`, which
 * writes the row's `amount` as the ACTUAL converted figure (via the same
 * `convertToBase` downstream readers use) rather than a relabeled one — the
 * exact precondition BIZ-03's own root-cause note says would make UAH/EUR
 * safe ("if multi-currency settlement is ever needed the amount must be
 * converted to USDT before recording" — now it is). `computeDropAggregate`
 * (the drop-side balance reader) was ALREADY currency-aware before this task,
 * so once the amount is real, its conversion is correct for any of the four
 * currencies. SENIOR settlements keep the exact pre-existing restriction —
 * this task never touches the salary/senior flow.
 *
 * SINGLE SOURCE OF TRUTH — reused by BOTH the explicit-currency
 * re-validation (an `ADMIN_PERSONAL` caller that still supplies `currency`)
 * AND the defense-in-depth assert on the fully-resolved currency
 * (security-review PR #381, task-remove-settle-currency) below, so the two
 * checks can never drift into two different lists.
 */
export const SETTLE_ALLOWED_CURRENCIES: ReadonlySet<string> = new Set(['USDT', 'USD'])

export function assertSettleCurrencyAllowed(currency: string): void {
  if (!SETTLE_ALLOWED_CURRENCIES.has(currency)) {
    throw apiError('FINANCE_USDT_OBLIGATION_CLOSE_CURRENCY_UNSUPPORTED', HttpStatus.BAD_REQUEST, {
      currency,
    })
  }
}
