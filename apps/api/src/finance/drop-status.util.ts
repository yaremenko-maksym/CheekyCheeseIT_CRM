import type { DropIncomeStatus, DropPaymentStatus } from '@crm/shared'

/**
 * Map a raw DB `transaction_status` to the FE-facing income status. The four
 * states a DROP_INCOME row can carry in its lifecycle are PENDING / VALIDATED
 * / PAID / REJECTED; any other DB status (PENDING_PAYMENT etc. — which belong
 * to PAYOUT rows, never DROP_INCOME rows) is not expected, so we surface it
 * as 'pending' defensively rather than leaking the internal enum. Single
 * source of truth so incomes feed + any future drop income view agree.
 */
export function mapDropIncomeStatus(dbStatus: string): DropIncomeStatus {
  switch (dbStatus) {
    case 'VALIDATED':
      return 'validated'
    case 'PAID':
      return 'paid'
    case 'REJECTED':
      return 'rejected'
    // Stryker disable next-line StringLiteral: equivalent mutant — falls through to `default` which returns the same 'pending'
    case 'PENDING':
    default:
      return 'pending'
  }
}

/**
 * task-drop-sees-own-obligations. Map a DROP_PENDING_PAYOUT / PAYOUT_DROP
 * row's raw DB `transaction_status` to the SAME FE-facing `DropIncomeStatus`
 * enum `mapDropIncomeStatus` uses — the incomes feed shows both income
 * models side by side (discriminated by `model`), so they share one status
 * vocabulary. Only two states are actually reachable on this pair: the row
 * is booked PENDING_PAYMENT and later settled IN PLACE to PAYOUT_DROP/PAID
 * (see `bookCompanyObligations` + `pending-settlement.service.ts`) — there
 * is no accountant-validation step for an obligation row, so 'validated' is
 * never produced here (that state is exclusively a DROP_INCOME lifecycle
 * step). REJECTED is defensive (not currently emitted by either booking
 * path) — kept explicit rather than silently defaulting, same rationale as
 * `mapDropPaymentStatus`'s PENDING_CASH_CONFIRM case below.
 */
export function mapDropObligationStatus(dbStatus: string): DropIncomeStatus {
  switch (dbStatus) {
    case 'PAID':
      return 'paid'
    case 'REJECTED':
      return 'rejected'
    // Stryker disable next-line StringLiteral: a PROVABLY equivalent mutant,
    // not an untested one — this case's body is IDENTICAL to `default`
    // immediately below it (both `return 'pending'`), so no input can ever
    // distinguish "this case label present" from "this case label removed
    // entirely". Kept only as explicit, self-documenting notation of which
    // one DB status this branch means to represent (mirrors the same
    // deliberately-redundant `case 'PENDING_PAYMENT': default:` shape
    // already established in the sibling `mapDropPaymentStatus` below, and
    // the same `case 'PENDING'` default-fallthrough pattern in
    // `mapDropIncomeStatus` above) — removing the label to "simplify" would
    // make a future reader re-derive from scratch which status this
    // fallthrough is meant to cover.
    case 'PENDING_PAYMENT':
    default:
      return 'pending'
  }
}

/**
 * Map a raw DB `transaction_status` to the FE-facing payment status for a
 * drop → company PAYOUT row. The placeholder PAYOUT booked at income
 * validation starts PENDING_PAYMENT (→ pending), flips to PAID on company
 * settlement (→ confirmed); REJECTED (→ failed). Anything else surfaces as
 * 'pending' defensively.
 *
 * PENDING_CASH_CONFIRM is the phase 4-B cash-payment confirmation gate:
 * semantically it is still a "waiting" state (company has not yet settled),
 * so it maps to 'pending'. Declared explicitly — NOT via the silent default —
 * so that if the mapping needs to diverge in phase 4-B it is immediately
 * visible here rather than buried in a catch-all. Fix: MED security finding.
 *
 * Remaining reachable PAYOUT statuses from the DB enum:
 *   PENDING_PAYMENT → pending  (normal pre-settlement state)
 *   PAID            → confirmed
 *   REJECTED        → failed
 *   PENDING_CASH_CONFIRM → pending  (phase 4-B cash gate, explicit)
 * Unreachable on PAYOUT but present in the enum (LOCKED / PENDING /
 * VALIDATED — income/interview lifecycle statuses) fall through to the
 * defensive default.
 */
export function mapDropPaymentStatus(dbStatus: string): DropPaymentStatus {
  switch (dbStatus) {
    case 'PAID':
      return 'confirmed'
    case 'REJECTED':
      return 'failed'
    // Phase 4-B cash-payment confirmation gate — semantically still pending;
    // explicit to prevent silent mis-attribution when phase 4-B ships.
    // Stryker disable next-line StringLiteral,ConditionalExpression: equivalent mutants — this case body is IDENTICAL to `default` (both `return 'pending'`), so removing/emptying the label is unobservable; the explicit label is documentation of the phase 4-B gate (pinned by name in the spec)
    case 'PENDING_CASH_CONFIRM':
      return 'pending'
    // Stryker disable next-line StringLiteral: equivalent mutant — falls through to `default` which returns the same 'pending'
    case 'PENDING_PAYMENT':
    default:
      return 'pending'
  }
}
