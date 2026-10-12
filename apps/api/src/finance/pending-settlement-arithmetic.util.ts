/**
 * Pure money arithmetic and resolution for `PendingSettlementService.settleByCompany`
 * (giant-file decomposition, leaf L2).
 *
 * Extracted VERBATIM from the service: same formulas, same rounding, same
 * thresholds, same error codes/params, same branch order. Every function here
 * reads only its arguments (no `this.db`, no service method, no NBU call) — the
 * NBU `getRates()` round-trip, the payer lookup, the logging and the single
 * `db.transaction` all stay in the service, which calls these in the original
 * order. The comments are the audit trail for PR #443 / #521 / #599 and moved
 * together with the code they justify.
 */
import { HttpStatus } from '@nestjs/common'
import { MAX_TRANSACTION_AMOUNT } from '@crm/shared'
import { apiError } from '../common/api-error'
import { convertToBase, type BalanceCurrency } from './balance.service'
import {
  isStorableExchangeRate,
  settledAmountError,
  throwSettledAmountError,
} from './exchange-rate.util'
import type { ExchangeRateResult } from './nbu-currency.service'
import { assertSettleCurrencyAllowed } from './settle-currency.util'

// task-cascade-apply (task 3, AC10 / addendum §1.11) — how much of this
// obligation is STILL owed.
//
// Before task 3 a row could settle at most once, so "owed" and "the
// obligation's amount" were the same number. A cascade revert reopens the
// obligation carrying the NEW FULL share while part of it has already been
// paid, and paying the full figure again would drive the accumulator to
// roughly twice the row's `amount` — breaking the invariant ledger term 9
// rests on (addendum §1.2) and paying the senior twice.
//
// ONE description, two call sites (the pre-transaction computation just
// below and the money gate inside the transaction, which keys off the
// CLAIMED amount for its own TOCTOU reasons).
export function remainingOwed(obligationAmount: string, priorSettledAmount: number): number {
  return Number((parseFloat(obligationAmount) - priorSettledAmount).toFixed(6))
}

/**
 * Funding choice -> does this settlement debit the shared company account.
 * Also enforces the cascade-origin guard (HIGH-1 / MED-B, PR #443).
 */
export function resolveCompanyDebit(args: {
  debtorType: string
  funding: { fundingSource: 'COMPANY_ACCOUNT' | 'ADMIN_PERSONAL' } | undefined
  isDropObligation: boolean
  sourceDropCascadeOrigin: boolean | null
}): { useCompanyAccount: boolean; debitsCompanyAccount: boolean } {
  const { funding, isDropObligation, sourceDropCascadeOrigin } = args
  // task-senior-settle-owner: the senior IOU is now paid via the SAME funding
  // selection as a SALARY — the ADMIN/ACCOUNTANT picks AT PAY TIME whether the
  // money leaves the shared company account (COMPANY_ACCOUNT) or an admin
  // partner's personal account (ADMIN_PERSONAL). Mirrors paySalary exactly.
  //
  // Default (no funding arg → legacy obligation-id `settle-company` route and
  // pre-existing callers): COMPANY_ACCOUNT for a COMPANY debt, or "no company
  // marker" for a legacy DROP debt (the money came from the drop, not the
  // company). This preserves the previous behaviour byte-for-byte.
  const isCompanyDebt = args.debtorType === 'COMPANY'
  // Resolve the funding choice → sender + currency + the SENIOR_INCOME marker.
  // A legacy DROP debt is never company-funded regardless of the passed source.
  const useCompanyAccount = funding ? funding.fundingSource === 'COMPANY_ACCOUNT' : isCompanyDebt
  // Does this settlement debit the shared company account (advisory lock + gate
  // + COMPANY_ACCOUNT marker)? Only when funded by the company AND it is a
  // COMPANY debt (legacy DROP debts never touch the company balance).
  const debitsCompanyAccount = useCompanyAccount && isCompanyDebt

  // SECURITY (HIGH-1, security-review PR #443): a cascade-originated drop
  // obligation (applyPayoutPaidCascade → bookCompanyObligations, `drop`
  // param) must NEVER settle from COMPANY_ACCOUNT — in BOTH branches that
  // can drive `debitsCompanyAccount` true (an explicit
  // funding.fundingSource='COMPANY_ACCOUNT', AND the legacy no-funding
  // default, which resolves useCompanyAccount=isCompanyDebt=true for any
  // COMPANY debt). The drop's slice paid by the cascade NEVER touched the
  // company pool — the PAYOUT row backing this payout_request only credited
  // `payable = income*(1-dropShare%)` (the company never receives the
  // drop's own cut; the drop keeps it before the on-chain transfer).
  // Debiting the company account here would subtract money the company
  // never held, silently understating the balance by exactly the drop's
  // share on every such settle (and, over time, falsely tripping the
  // "insufficient funds" gate below for otherwise-legitimate payouts).
  // The admin-declared USDT path (declareUsdtProjectIncome) is NOT
  // affected by this guard — `dropCascadeOrigin=false` there is a
  // cascade-vs-declaration discriminator, not a "money is in the pool"
  // guarantee (declareUsdtProjectIncome can also route to a SPECIFIC
  // admin's personal wallet, toCompanyPool=false — see the column comment
  // in schema.ts, corrected round 5). Which pot actually pays a
  // `false`-marked obligation is decided by the ADMIN/ACCOUNTANT's
  // funding-source choice below, same as it already is for the analogous
  // senior obligation — unchanged by this PR.
  //
  // SECURITY (MED-B, security-review PR #443 round 2, fail-safe hardening):
  // the discriminator is `dropCascadeOrigin` — a POSITIVE marker stamped
  // ONCE at INSERT time (see bookCompanyObligations, transactions.service.ts,
  // and the column comment in schema.ts) — NOT `payoutRequestId IS NOT
  // NULL`. That FK is `ON DELETE SET NULL`: a future cleanup of an
  // unrelated `payout_requests` row would silently null it, and a
  // condition keyed on it would fail OPEN (a cascade-originated row would
  // become indistinguishable from an admin-declared one and wrongly allow
  // a COMPANY_ACCOUNT settle). `dropCascadeOrigin` is never derived from
  // `payoutRequestId` after the fact, so it survives that entirely.
  // Backfilled historical rows (task-drop-share-pending-parity) get the
  // SAME marker stamped by the backfill script, for the identical reason.
  //
  // `!== false` (not a truthy check) — security-review PR #443 round 3,
  // LOW: the column is nullable with NO default (see schema.ts), so `null`
  // means "nobody ever stamped an origin for this row" (a future insert
  // path that forgets to set it, or any pre-marker-column legacy row this
  // backfill never touched). Treating that as BLOCK — same as an explicit
  // `true` — means an unknown origin fails SAFE; only an EXPLICIT `false`
  // (admin-declared path) is treated as "known safe to debit the company
  // account".
  if (isDropObligation && sourceDropCascadeOrigin !== false && debitsCompanyAccount) {
    throw apiError('FINANCE_DROP_SHARE_NOT_VIA_COMPANY_ACCOUNT', HttpStatus.BAD_REQUEST)
  }
  return { useCompanyAccount, debitsCompanyAccount }
}

type SettleCurrency = 'USDT' | 'USD' | 'EUR' | 'UAH'

/**
 * Resolve the currency label the settlement is recorded in (BIZ-03 explicit
 * re-validation included). Runs AFTER the payer lookup in the service, exactly
 * where the inline block used to sit.
 */
export function resolveSettleCurrency(args: {
  obligationCurrency: SettleCurrency
  funding:
    | {
        fundingSource: 'COMPANY_ACCOUNT' | 'ADMIN_PERSONAL'
        currency?: 'USDT' | 'USD' | 'EUR' | 'UAH' | undefined
      }
    | undefined
  isDropObligation: boolean
  debitsCompanyAccount: boolean
}): SettleCurrency {
  const { funding, isDropObligation, debitsCompanyAccount } = args
  // task-remove-settle-currency: default is the OBLIGATION's own currency
  // (always USDT for a senior/drop IOU — see transactions.service.ts
  // createIous). The settle dialog no longer sends a currency at all; this
  // is the value that ends up on the flipped row for both funding sources
  // unless a caller explicitly overrides it below (defensive/legacy path).
  let currency = args.obligationCurrency
  if (funding && funding.fundingSource === 'ADMIN_PERSONAL') {
    // BIZ-03 (HIGH), kept as a safety net for a SENIOR settlement
    // (task-remove-settle-currency): a senior settle dialog never sends a
    // currency, so `funding.currency` is normally undefined here and
    // `currency` stays `obligation.currency` (USDT) from the declaration
    // above. IF a caller still supplies one explicitly (legacy/defensive),
    // re-validate it — the SENIOR_INCOME row carries the chosen currency,
    // and downstream (getSeniorBalance / getTotalEarned / summary) converts
    // it via convertToBase using the currency LABEL. That reader trusts the
    // row's `amount` to already BE in that currency — true for USD/USDT
    // (1:1) but, for a SENIOR settle, this branch has never actually
    // converted the figure (a pure relabel), so UAH/EUR would silently
    // misrepresent the payout.
    //
    // task-drop-payout-currency: a DROP settle is exempt — see the
    // extended comment on `assertSettleCurrencyAllowed` above. Its `amount`
    // IS converted below (the amount-conversion block), which is exactly
    // what removes the risk this guard exists to catch.
    if (funding.currency !== undefined) {
      // mutation-gate: provably equivalent to removing this line — `currency`
      // is assigned `funding.currency` UNCHANGED on the very next line and
      // nothing between here and the defense-in-depth re-assert below
      // (`if (!isDropObligation) assertSettleCurrencyAllowed(currency)`)
      // can alter it, so that second check throws on the IDENTICAL value
      // whenever this one would have. No test can observe this line firing
      // vs not: the outcome (throw or not) is decided by the unconditional
      // re-assert either way. Real defense-in-depth (a second, independent
      // gate is worth keeping for a future refactor that inserts logic
      // between the two), not dead code — see the SECURITY comment there.
      // Stryker disable next-line ConditionalExpression: backstopped by the unconditional re-assert 20 lines below on the same final `currency` value
      if (!isDropObligation) assertSettleCurrencyAllowed(funding.currency)
      currency = funding.currency
    }
  } else if (debitsCompanyAccount) {
    // COMPANY_ACCOUNT: USDT-only account (the schema refine + this force keep
    // the currency label consistent with the ledger).
    currency = 'USDT'
  }
  return currency
}

/** Drop-payout currency invariants (MED-1 PR #521, top-up mismatch task 3b AC8). */
export function assertDropCurrencyInvariants(
  obligationCurrency: BalanceCurrency,
  targetCurrency: BalanceCurrency,
  priorSettledAmount: number,
): void {
  // SECURITY (MED-1, security-review PR #521 round 1): every write path
  // that books a DROP obligation (`bookCompanyObligations` in
  // transactions.service.ts) hardcodes USDT — normal data can never
  // reach here with a different currency. But the BIZ-03 whitelist
  // exemption a few lines up is justified SPECIFICALLY by "the amount is
  // genuinely converted, not relabeled" (see the extended comment on
  // `assertSettleCurrencyAllowed`), and that justification is silent
  // exactly when NO conversion happens (`targetCurrency ===
  // obligationCurrency` below) — a corrupted/legacy obligation whose
  // `currency` is not USDT would then take a copy of `amount` verbatim
  // under a wrong label, the exact "clean rename" BIZ-03 exists to
  // prevent. Assert the invariant explicitly rather than trust it
  // silently — a SENIOR settle already gets the equivalent protection
  // from `assertSettleCurrencyAllowed`, which still runs for it.
  if (obligationCurrency !== 'USDT') {
    throw apiError('FINANCE_DROP_OBLIGATION_CORRUPTED_CURRENCY', HttpStatus.BAD_REQUEST)
  }

  // task-drop-topup (task 3b, AC8 / addendum 3b, 1.3 + 2.6) — the ONE
  // premise the triplet's arithmetic rests on, asserted where the triplet
  // is stamped.
  //
  // `exchange_rate` below is written as `cumulativePaid / obligationAmount`
  // — the ratio of EVERY payment on this row to the obligation. That is a
  // truthful "effective applied rate" only while all those payments were
  // made in one currency; mix two and the column records an AVERAGE that
  // no single transfer was ever made at, and nothing downstream would ever
  // notice (nothing computes money from the triplet — that is a decision,
  // recorded in addendum 3b, Ответ 0, not an accident).
  //
  // Why this is NOT a duplicate of the five refusals that already make the
  // mixed case unreachable — `obligationCurrency !== 'USDT'` just above,
  // `OBLIGATION_CURRENCY_MISMATCH` and `NON_USDT_CURRENCY` in the cascade,
  // `sourceSettledCurrency !== currency` further down, and BIZ-03's
  // whitelist: every one of them defends a DIFFERENT statement (the
  // obligation's own currency, the unit of the accumulator, the unit of
  // the figure written into `pending_obligations`). Not one of them is
  // phrased about the rate. Delete any of them and this one starts
  // refusing loudly on live data instead of writing an average — which is
  // the whole point of expressing a dependency as a check at the point of
  // reliance (addendum §3.1).
  //
  // Scoped to `priorSettledAmount > 0` deliberately: on a FIRST settle
  // there is no earlier rate to average with, and paying a drop obligation
  // out in another currency is an existing, working feature
  // (task-drop-payout-currency).
  if (priorSettledAmount > 0 && targetCurrency !== obligationCurrency) {
    throw apiError('FINANCE_SETTLEMENT_CURRENCY_MISMATCH_MANUAL_ONLY', HttpStatus.BAD_REQUEST, {
      obligationCurrency,
    })
  }
}

/**
 * NBU-priced conversion of the still-owed figure into the payout currency.
 * `rates` is the ALREADY-FETCHED NBU result; this function never calls NBU.
 */
export function convertDropPayoutAmount(
  owedNow: number,
  obligationCurrency: BalanceCurrency,
  targetCurrency: BalanceCurrency,
  rates: ExchangeRateResult,
): number {
  // SECURITY (MED-2, security-review PR #521 round 1) — refined by the
  // owner addendum (round 3): `getRates()` NEVER throws — on an NBU
  // gap it falls back to either (a) a real, dated rate from the
  // nearest prior business day (`rates.rateDate` set — a holiday with
  // no same-day publication, the SAME mechanism the round-2 reviewer
  // verified already covers ordinary weekends without ever needing
  // this fallback at all) or (b) a genuinely unknown cached/hardcoded
  // value (`rates.rateDate` undefined — the live feed AND the
  // requested-day-adjacent data are both unavailable). Only (b) is a
  // reason to refuse: a historical date's rate, once actually
  // obtained from a real NBU publication, is exact and final — it is
  // not "stale" in the sense this gate exists to catch, and refusing
  // it would make a past date permanently unsettleable whenever it
  // happens to land on a bank holiday.
  //
  // CORRECTED (task-finance-fix-wave1, D-3): this comment used to claim
  // that every OTHER `getRates` consumer only feeds a stale rate into a
  // DISPLAY value that self-corrects on the next read, and that this
  // settle path was the first to bake one into a permanent figure. That
  // was FALSE, and the false claim cost real time — an audit read it as
  // evidence that no other path needed the gate, and only a second look
  // found the counter-example: `createPayoutRequest`
  // (transactions.service.ts) converts EUR/UAH incomes to USDT and writes
  // the result into `payout_requests.incomeAmount/payableAmount` by an
  // irreversible INSERT, and `payPayoutRequest` then requires the on-chain
  // transfer to match `payableAmount` EXACTLY. It has the same gate now.
  // The honest statement is narrower: the rate-consuming paths that write
  // a PERMANENT amount are this one and `createPayoutRequest`, and both
  // refuse case (b); the remaining consumers (balances, summary cards)
  // are display-only. Before adding a consumer, check which group it is
  // in — do not assume this comment still enumerates them all.
  //
  // Refuse case (b) rather than silently commit a possibly
  // wrong amount to money that cannot be un-paid. The ADMIN/ACCOUNTANT
  // can retry once NBU recovers, or settle in the obligation's own
  // currency (USDT) right now, which never needs a rate at all.
  if (rates.stale && rates.rateDate === undefined) {
    throw apiError('FINANCE_NBU_RATE_UNAVAILABLE', HttpStatus.BAD_REQUEST)
  }
  const rawPaidAmount = convertToBase(owedNow, obligationCurrency, targetCurrency, rates)
  // LOW (security-review PR #521 round 1): round to the money
  // precision actually payable — `AmountCurrencyInput` DISPLAYS
  // `.toFixed(2)`, but the raw division can carry many more decimals
  // (e.g. 41512.345679 UAH), a "fact of payment" nobody could
  // actually transfer. Round BEFORE recording so the written amount
  // matches the displayed one exactly (AC3) and stays a real payable
  // figure, not just an average close enough for a 2-decimal test.
  return Math.round(rawPaidAmount * 100) / 100
}

/**
 * Validate the server-computed payout figure and derive the stamped
 * `exchange_rate` (string with 8dp, or null when not representable).
 */
export function finalizeDropPayout(args: {
  obligationAmount: number
  owedNow: number
  paidAmount: number
  priorSettledAmount: number
}): string | null {
  const { obligationAmount, owedNow, paidAmount, priorSettledAmount } = args
  // LOW (security-review PR #521 round 1) / MED-A (round 3): the
  // server-computed figure is exempt from Zod's boundary validation
  // (there is no client `amount` field to validate) but can still
  // exceed the project's own ceiling once multiplied by a currency rate
  // — e.g. a near-MAX_TRANSACTION_AMOUNT USDT obligation × ~41 for UAH.
  // Re-apply the SAME finiteness/ceiling rule every client-supplied
  // amount already goes through (also closes the `Number.isFinite` gap:
  // a NaN/Infinity paid amount must never reach `numeric` — Postgres
  // accepts the literal string `'NaN'`).
  //
  // `settledAmountError`, NOT `@crm/shared`'s `transactionAmountError`:
  // a DROP obligation can be legitimately booked at exactly 0 (a 0%
  // share override — see the extended comment on `settledAmountError`
  // in exchange-rate.util.ts), and `transactionAmountError` rejects
  // `value <= 0` unconditionally. Reusing it here (round 1's original
  // fix) permanently stranded every zero-amount drop obligation in
  // "Ожидает выплаты" — negative/NaN/Infinity/over-ceiling still
  // rejected, only the floor moved from "> 0" to ">= 0".
  const paidAmountError = settledAmountError(paidAmount, MAX_TRANSACTION_AMOUNT)
  if (paidAmountError) throwSettledAmountError(paidAmountError)

  // LOW (security-review PR #521 round 3): the 2dp rounding above can
  // legitimately round a genuinely NON-zero obligation down to exactly
  // 0.00 in the target currency ("dust" — a fractional obligation
  // converted through a rate/currency pair that collapses it below a
  // hundredth of the target unit). `settledAmountError`'s own floor
  // (`>= 0`, MED-A) cannot tell that apart from a REAL 0%-share
  // obligation (`obligationAmount === 0`), where zero IS correct and
  // must be allowed through. Distinguish them explicitly: dust is
  // refused — a "0.00" record would misrepresent a debt that
  // demonstrably still exists — while a genuine zero-obligation settle
  // proceeds untouched.
  // task-drop-topup (task 3b, AC6): compared against `owedNow`, not the
  // obligation's full figure. `owedNow === 0` is a LEGAL idempotent close
  // — "exactly as much has been paid as the obligation is worth" — and it
  // is reachable by editing an income up and then back down (the cascade
  // floors both copies at the accumulator, so the next settle finds nothing
  // left to pay). Refusing it here would recreate the dead end AC15 exists
  // to prevent: a reopened obligation with nothing that can close it.
  if (paidAmount === 0 && owedNow > 0) {
    throw apiError('FINANCE_ROUNDED_PAYOUT_AMOUNT_ZERO', HttpStatus.BAD_REQUEST)
  }

  // task-drop-topup (task 3b, AC5 / addendum 3b, 1.4 + 2.3): the numerator
  // is EVERYTHING paid on this row, not just this payment.
  //
  // The triplet describes the row's CLOSED FORM, not one transfer:
  // `original_amount` is the obligation as it finally stood, `amount` is
  // the sum of the payments that closed it, and `exchange_rate` is their
  // ratio — which keeps `amount = original_amount × exchange_rate` true on
  // a row closed twice. Using this payment alone would record 30/130 for a
  // USDT→USDT top-up that converted nothing (Л2 of the addendum).
  //
  // On a first settle `priorSettledAmount` is 0, so this IS `paidAmount`
  // and the formula is the pre-existing one, unchanged.
  //
  // Rounded to the same 6 places as every other money figure here, for the
  // same reason `remainingOwed` is: a raw float sum carries a tail
  // (100.1 + 30.2 = 130.30000000000001) that would surface in the rate.
  const cumulativePaid = Number((priorSettledAmount + paidAmount).toFixed(6))
  // Effective applied rate = everything paid / the obligation (units of the
  // paid currency per 1 unit of the obligation) — same NULL-on-
  // unrepresentable fallback as paySalary. Stamped on EVERY drop settle
  // (not only when the currency changed), so a reader never has to guess
  // whether a NULL original_amount means "unchanged" or "settled before
  // this flow existed" (the latter — see the schema.ts column comment).
  //
  // `obligationAmount > 0` reads as a real branch (MED-A, round 3: a
  // 0%-share drop obligation legitimately has `obligationAmount === 0`,
  // for which the ratio is 0/0 — deliberately left NULL rather than
  // computed, same as any other unrepresentable ratio) — but is PROVABLY
  // unobservable by any test.
  //
  // REWRITTEN by task 3b, because the previous justification stopped being
  // true: it argued that `settledAmountError` above validates `paidAmount`,
  // "which IS `obligationAmount` on the same-currency path", and after AC3
  // `paidAmount` is derived from `owedNow` instead. The conclusion survives
  // with one more link in the chain: `owedNow = obligationAmount −
  // priorSettledAmount`, and a subtraction propagates NaN, ±Infinity and
  // negativity rather than absorbing them (`priorSettledAmount` is itself
  // finite and ≥ 0, or `owedNow` is NaN and refused). So a
  // negative/NaN/Infinite `obligationAmount` still reaches
  // `settledAmountError` through `paidAmount` — on the peg path as
  // `owedNow` itself, on the NBU path as `owedNow × <a positive finite
  // rate>` — and is still rejected before this line. `obligationAmount` is
  // therefore still either exactly 0 or a finite positive number here.
  // Note that `obligationAmount === 0` also forces `priorSettledAmount ===
  // 0` (any positive accumulator would make `owedNow` negative and be
  // refused above), so `cumulativePaid` is 0 there too and the ratio is
  // still exactly 0/0.
  //
  // Force ANY of this condition's operators to always-true (`true`, `||`,
  // `>=`) and the ONLY behaviour change is that the `obligationAmount ===
  // 0` case computes `0 / 0 = NaN` instead of skipping straight to `null` —
  // but `isStorableExchangeRate` immediately below rejects NaN via its own
  // `Number.isFinite` check, producing the IDENTICAL `exchangeRate = null`.
  // No test can observe the difference through this function's output.
  const rawExchangeRate =
    // Stryker disable next-line ConditionalExpression,LogicalOperator,EqualityOperator: see the comment above — every mutant here (force true/false, && → ||, > → >=) is downstream-caught by isStorableExchangeRate's own Number.isFinite(NaN)===false check, producing the identical exchangeRate=null either way
    Number.isFinite(obligationAmount) && obligationAmount > 0
      ? cumulativePaid / obligationAmount
      : null
  const exchangeRate =
    // Stryker disable next-line ConditionalExpression: `!== null` is a TS narrowing guard for `.toFixed` below; at runtime it is ALSO behaviorally redundant — isStorableExchangeRate(null) already returns false via its own Number.isFinite(null) check, so removing this guard cannot change the outcome
    rawExchangeRate !== null && isStorableExchangeRate(rawExchangeRate)
      ? rawExchangeRate.toFixed(8)
      : null
  return exchangeRate
}

// task-cascade-apply (task 3, AC14 / addendum §1.13, security-review
// SR-H-2). Same shape as the currency guard directly above, same argument,
// for the other column the accumulator has no snapshot of.
//
// INVARIANT: every settle of one row comes from the SAME PAYER, and the
// pair `(funding_source, sender_id)` is the record of who that was.
//
// `funding_source` answers "which pot". Ledger terms 7, 8 and 9 all key on
// that LIVE column, so a second settle from a different pot does not
// "split" the row between two terms — it drops it out of BOTH. Concretely:
// a company-funded settle of 260, a cascade revert (term 9 holds the 260),
// then a top-up from an admin's personal account ⇒ `funding_source` becomes
// null and the status is no longer PENDING_PAYMENT, so 260 USDT that really
// left the company account vanish from the ledger. The whole scenario is in
// USDT, so the currency guard above stays silent.
//
// `sender_id` answers "which PERSON", and it is not a refinement of the
// first question but a second one the first cannot reach (SR-M-5, owner's
// decision, security-review round 3). Inside `ADMIN_PERSONAL` every admin
// shares one pot value (NULL), so the pot comparison waves a different
// partner straight through — and the flip then OVERWRITES `sender_id`
// while `adminBalances.sent` sums the row's whole `amount` under whoever
// holds it. Admin A pays 260, the cascade reopens the row, admin B tops it
// up, and the entire figure lands on B: A looks like they never paid. Two
// partners on 50/50 shares, and nothing anywhere says so out loud.
//
// For a company-funded settle both sides are `(COMPANY_ACCOUNT, null)`, so
// widening the comparison changes nothing there — it only starts
// distinguishing `(null, A)` from `(null, B)`.
//
// Holders of the invariant: the flip writes both columns, the cascade
// revert preserves both (AC6), and this refusal stops the pair becoming
// multi-valued.
//
// Unconditional — NOT restricted to the senior branch. A drop top-up is
// refused elsewhere today (AC10), but this guard must not depend on that
// staying true when task 3b lands.
//
// The escape hatch, if mixing is ever actually wanted, is a snapshot
// column per axis — and the two axes cost DIFFERENT things, which the
// previous version of this comment got wrong by re-using round 2's
// wording for both (SPEC-M-1, review round 4):
//
//   - `funding_source`: a `settled_funding_source` snapshot would force
//     terms 7 and 8 to read it instead of the live column, and this task
//     commits to leaving them untouched (addendum §1.10). That is the
//     expensive one.
//   - `sender_id`: NO ledger term reads it. Verified, not assumed —
//     `grep -n 'senderId\|sender_id' company-account-balance.ts` returns a
//     single hit, and it is a comment. The cost sits somewhere else
//     entirely: the `adminBalances` array built in
//     `TransactionsService.getSummary()` (transactions.service.ts)
//     attributes a row's whole `amount` to whoever holds `sender_id`, so
//     splitting one row between two payers needs a per-settle record
//     there, not a column here.
//
//     NOT `balance.service.ts` — round 4's version of this comment said
//     so and was wrong twice over. That file holds `getAdminBalance`, a
//     different and narrower metric whose own docstring states it "does
//     NOT replicate `getSummary`'s full HOLDING model". Sending the next
//     reader there sends them to code that does not do this.
//
// Saying "terms 7 and 8" for the second axis pointed the next reader at
// code that has nothing to do with it.
export function isFundingSourceMismatch(args: {
  priorSettledAmount: number
  settleFundingSource: string | null
  sourceFundingSource: string | null
  senderId: string | null
  sourceSenderId: string | null
}): boolean {
  return (
    args.priorSettledAmount > 0 &&
    (args.settleFundingSource !== args.sourceFundingSource || args.senderId !== args.sourceSenderId)
  )
}
