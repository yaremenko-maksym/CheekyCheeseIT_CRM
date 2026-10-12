/**
 * Pending-settlement money transaction body (giant-decomposition L4).
 *
 * `settleObligationInTx` is the IN-TRANSACTION sequence of
 * `PendingSettlementService.settleByCompany`, moved here verbatim:
 *
 *   claim (PENDING→PAID, zero-row abort) → amount-changed re-check →
 *   advisory lock + balance gate (company debit only) → in-place flip
 *   (PENDING_PAYMENT guard + IS NOT DISTINCT FROM accumulator) → closing link.
 *
 * ORDER IS FROZEN: the claim runs FIRST so a losing concurrent caller bails
 * before any money write. The caller opens exactly ONE `db.transaction` and
 * passes its handle here; the lock and the balance read are called with that
 * SAME handle. Pre-transaction reads and post-commit steps (invoice trigger,
 * audit insert, refreshed read) stay in the service.
 */
import { HttpStatus } from '@nestjs/common'
import { and, eq, sql } from 'drizzle-orm'
import type { SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import { pendingObligations, transactions, type Transaction } from '../database/schema'
import type { DrizzleTx } from '../database/types'
import {
  COMPANY_ACCOUNT_FUNDING_SOURCE,
  computeCompanyAccountBalanceFromLedger,
  lockCompanyAccount,
} from './company-account-balance'
import { remainingOwed } from './pending-settlement-arithmetic.util'

type SettleCurrency = 'USDT' | 'USD' | 'EUR' | 'UAH'

export interface SettleObligationPlan {
  /** The pre-transaction obligation snapshot (only the fields the tx body reads). */
  obligation: { id: string; amount: string; sourceTransactionId: string }
  actor: Pick<SessionUser, 'id' | 'impersonatorId'>
  /** Settle proof carried by `funding` (undefined for the legacy no-funding route). */
  funding:
    | {
        receiptDocumentId?: string | null | undefined
        receiptExternalUrl?: string | null | undefined
      }
    | undefined
  isDropObligation: boolean
  debitsCompanyAccount: boolean
  currency: SettleCurrency
  senderId: string | null
  senderLabel: string
  priorSettledAmount: number
  settledAmountThisSettle: number
  sourceSettledAmount: string | null
  sourceSeniorSharePercent: number | null
  sourceDropSharePercent: number | null
  /** DROP-only conversion snapshot (undefined for a SENIOR settle). */
  originalAmount: string | undefined
  originalCurrency: SettleCurrency | undefined
  exchangeRate: string | null | undefined
  txDateToWrite: Date | undefined
}

/** Runs inside the caller's single `db.transaction`; returns the flipped source row. */
export async function settleObligationInTx(
  dbtx: DrizzleTx,
  plan: SettleObligationPlan,
): Promise<Transaction> {
  const {
    obligation,
    actor,
    funding,
    isDropObligation,
    debitsCompanyAccount,
    currency,
    senderId,
    senderLabel,
    priorSettledAmount,
    settledAmountThisSettle,
    sourceSettledAmount,
    sourceSeniorSharePercent,
    sourceDropSharePercent,
    originalAmount,
    originalCurrency,
    exchangeRate,
    txDateToWrite,
  } = plan
  // SECURITY (TOCTOU, MED — PR #262): the PENDING→PAID transition is the
  // money gate and MUST be atomic + idempotent, else two concurrent / repeated
  // settle calls (e.g. a double-clicked ADMIN/ACCOUNTANT button) both pass the
  // out-of-transaction status read above, both insert a SENIOR_INCOME and both
  // debit the company account → DOUBLE payout to the senior. There is no
  // unique/partial-index backstop on pending_obligations (unlike the payout
  // path's uq_payout_requests_txhash_paid), so we serialize at the row level
  // with a CONDITIONAL UPDATE: flip to PAID only WHERE the row is still
  // PENDING, and RETURN the affected rows. The UPDATE takes a row lock and
  // re-evaluates `status='PENDING'` against the committed row, so exactly one
  // caller wins. If zero rows come back the obligation was already settled by a
  // concurrent winner → throw, which rolls back THIS transaction (no
  // SENIOR_INCOME row, no company-account debit). Doing the conditional UPDATE
  // FIRST means the loser bails out before any money write happens.
  const claimed = await dbtx
    .update(pendingObligations)
    .set({
      status: 'PAID',
      updatedAt: new Date(),
    })
    .where(and(eq(pendingObligations.id, obligation.id), eq(pendingObligations.status, 'PENDING')))
    .returning({ id: pendingObligations.id, amount: pendingObligations.amount })
  if (claimed.length === 0) {
    // Idempotent: a concurrent / repeated call already closed this obligation.
    throw apiError('FINANCE_OBLIGATION_ALREADY_CLOSED', HttpStatus.BAD_REQUEST)
  }

  // SECURITY (TOCTOU, task-fix-obligation-amount-divergence follow-up,
  // MED-1). `obligation` above was read BEFORE this transaction opened.
  // Every value derived from `obligation.amount` since then — the DROP
  // currency-conversion block above (paidAmount / originalAmount /
  // exchangeRate, all computed from `parseFloat(obligation.amount)`) and
  // the balance-sufficiency check right below — was, until
  // task-fix-obligation-amount-divergence, provably safe to read stale:
  // `pending_obligations.amount` had NO write path at all once booked.
  // `adminUpdateTransaction` gave it one (keeping it in sync with the
  // source IOU's `transactions.amount`, scoped to `status='PENDING'`).
  // The conditional claim above re-evaluates only `status`, not
  // `amount` — so an edit that commits in the window between the read
  // above and this claim now sails through undetected: the gate would
  // check the OLD sum while the flip below books the NEW one (SENIOR —
  // its `amount` is left untouched by the flip, i.e. whatever is
  // currently committed) or, for DROP, the OPPOSITE: `paidAmount` was
  // already computed from the STALE amount above and gets written
  // verbatim, discarding the edit on a row that is about to become
  // CLOSED — an L4-shaped, unrecoverable divergence (the flip has no
  // percent snapshot to recompute from afterwards).
  //
  // The claim's own `.returning()` is the ONE read in this whole method
  // that observes the row AS COMMITTED at claim time — comparing it
  // against the pre-transaction snapshot turns an otherwise-silent race
  // into an explicit refusal (nothing money-mutating below this point
  // has run yet) rather than a wrong debit either direction.
  const claimedAmount = claimed[0]!.amount
  if (Number(claimedAmount).toFixed(6) !== Number(obligation.amount).toFixed(6)) {
    throw apiError('FINANCE_OBLIGATION_AMOUNT_CHANGED', HttpStatus.BAD_REQUEST)
  }

  // SECURITY (TOCTOU): a company-account DEBIT must serialize against every
  // other company-account debit (salary / expense / other settlements) via
  // the SHARED advisory lock, then re-read the balance and refuse to drive
  // the account negative. Mirrors createSalary / createExpense. Only runs for
  // a COMPANY-funded settlement — an ADMIN_PERSONAL payout never touches the
  // shared account so it needs neither lock nor gate.
  if (debitsCompanyAccount) {
    await lockCompanyAccount(dbtx)
    const balance = await computeCompanyAccountBalanceFromLedger(dbtx)
    // Gate by the CLAIMED amount (read inside the transaction, above),
    // not the pre-transaction `obligation` snapshot — see the TOCTOU
    // note above. The two are asserted equal just above (a race throws
    // before reaching here), so this is a no-op today; keeping the gate
    // keyed on `claimedAmount` rather than `obligation.amount` is what
    // makes that assertion load-bearing rather than decorative — a
    // later change that loosens it still gates correctly on its own.
    //
    // task-cascade-apply (task 3, AC10): what leaves the account is the
    // REMAINDER, so that is what the balance must cover. Gating on the
    // obligation's full figure after a partial payment would refuse a
    // top-up the company can actually afford. Same single description of
    // "still owed" as the pre-transaction computation above.
    //
    // task-drop-topup (task 3b, AC7): ONE description for both branches now
    // — the `isDropObligation ? parseFloat(claimedAmount) : …` ternary is
    // gone. A company-funded drop settle is forced to USDT
    // (`debitsCompanyAccount ⇒ currency = 'USDT'`) and its obligation is
    // USDT too, so no conversion happens and `paidAmount === owedNow`
    // exactly; on a first settle both halves were already
    // `parseFloat(claimedAmount)`. Fewer branches, fewer mutants that no
    // test can tell apart, and "how much is still owed" said once.
    const amount = remainingOwed(claimedAmount, priorSettledAmount)
    if (amount > balance) {
      throw apiError('FINANCE_COMPANY_ACCOUNT_INSUFFICIENT_FUNDS', HttpStatus.BAD_REQUEST)
    }
  }

  // task-settle-in-place (ADR 2026-07-14). The obligation transitions
  // PENDING_PAYMENT → PAID **in place**: instead of inserting a SECOND
  // transaction (the phantom bug — a lingering `*_PENDING_PAYOUT` row plus a
  // separate settle row), we UPDATE the SOURCE IOU row itself. It flips type
  // to its final form and stamps the same funding fields the old "second row"
  // carried, becoming byte-for-byte equivalent to yesterday's settle row —
  // only reusing the IOU's id instead of allocating a new one. Every ledger /
  // drop-aggregate / invoice / C4 consumer keys on that FINAL form
  // (type + status=PAID + funding markers), so none of them change:
  //   - senior IOU → type=SENIOR_INCOME (status=PAID): InvoicesService
  //     .autoCreateForSeniorPayout picks it up (gate `tx.type==='SENIOR_INCOME'`).
  //   - drop IOU → type=PAYOUT_DROP (status=PAID): credits the drop's balance
  //     via computeDropAggregate (receiverId=drop, senderId≠drop so NOT
  //     double-counted as `sent` — C6); no invoice (Q6).
  // The flip runs AFTER the winning conditional claim above, so it executes
  // exactly once. Defense-in-depth: scope the UPDATE to the still-PENDING_PAYMENT
  // source row so a corrupted / already-flipped state can never be re-settled.
  // CR-M-1 (code-review, task 3b) — ONE symbol, two columns.
  //
  // `amount` and `settled_amount` on a drop settle must be the same figure
  // (addendum §1.2 — the invariant ledger term 9 rests on). Writing the
  // expression out twice made that a property of two identical STRINGS,
  // and a rule written down twice is a rule that can be half-edited: the
  // only thing standing between them was a test comparing their compiled
  // form. Referencing one `SQL` object from both keys makes divergence
  // impossible to express rather than merely wrong (backlog 85).
  //
  // Still DB-native, and for the original reason (MED-3, #599): the sum is
  // computed against whatever `settled_amount` the row ACTUALLY holds at
  // write time, so correctness does not depend on "nothing else wrote this
  // row between the read and the UPDATE". `coalesce(..., 0)` makes a
  // first-ever settle read as `0 + delta` — the pre-existing value, byte
  // for byte. Both columns are `numeric(18, 6)`, so one expression cannot
  // round differently into the two of them.
  const accumulatedAmount = sql`coalesce(${transactions.settledAmount}, 0) + ${settledAmountThisSettle}`

  const [paidRow] = await dbtx
    .update(transactions)
    .set({
      type: isDropObligation ? 'PAYOUT_DROP' : 'SENIOR_INCOME',
      status: 'PAID',
      // task-senior-settle-owner: currency follows the funding choice
      // (COMPANY_ACCOUNT → USDT; ADMIN_PERSONAL → chosen; legacy default →
      // obligation currency). The IOU was booked USDT; this may re-stamp it.
      currency,
      // task-drop-payout-currency: the FACT of the drop payout (converted
      // server-side above) plus the OBLIGATION snapshot it settled —
      // stamped on EVERY drop settle, mirroring paySalary's paidSet
      // byte-for-byte. Empty object for a SENIOR settle (`paidAmount` stays
      // `undefined`) — `amount` is left completely untouched, exactly the
      // pre-existing behaviour.
      ...(isDropObligation
        ? {
            // task-drop-topup (task 3b, AC4): literally the same object as
            // `settledAmount` below — see `accumulatedAmount` above for why
            // `amount` accumulates at all and why it must not be a second
            // copy of the expression.
            amount: accumulatedAmount,
            originalAmount,
            originalCurrency,
            exchangeRate,
          }
        : {}),
      // task-drop-payout-currency (owner addendum, 2026-08): the
      // operator-selected date, when one was sent (see the extended
      // comment on `SettleFunding.txDate`). Omitted entirely — not set
      // to `new Date()` — when absent, so the column keeps whatever it
      // already held (the obligation's booking date, which is exactly
      // the client-side DEFAULT the date-picker shows, so a caller that
      // never touches the picker gets the identical recorded value
      // either way).
      ...(txDateToWrite ? { txDate: txDateToWrite } : {}),
      // ADMIN_PERSONAL → the paying partner is the sender; COMPANY_ACCOUNT /
      // legacy → no personal sender, label 'COMPANY' (the IOU's booked label).
      senderId,
      senderLabel,
      // Company-account debit marker — counted by the ledger SSOT (the C7
      // PAYOUT_DROP(COMPANY_ACCOUNT) term for a drop settle, the existing
      // SENIOR_INCOME(COMPANY_ACCOUNT) term for a senior settle). Only set for
      // a company-funded settlement; an ADMIN_PERSONAL payout carries no
      // marker (the shared balance must not move).
      fundingSource: debitsCompanyAccount ? COMPANY_ACCOUNT_FUNDING_SOURCE : null,
      // task-receipts-backend (#10): stamp the settle proof (only the
      // user-facing funding-carrying flow supplies one; legacy → null).
      receiptDocumentId: funding?.receiptDocumentId ?? null,
      receiptExternalUrl: funding?.receiptExternalUrl ?? null,
      // CRITICAL (ADR): a cascade-sourced IOU (applyPayoutPaidCascade) carries
      // `payoutRequestId`. Keeping it on a flipped SENIOR_INCOME would bleed the
      // row into autoCreateForPayout's payoutRequestId aggregation AND the
      // findOne SENIOR_INCOME-by-payoutRequestId enrichment. Yesterday's settle
      // SENIOR_INCOME had payoutRequestId=null; reset preserves byte-identity.
      // Audit link is retained via pending_obligations + notes + projectId.
      payoutRequestId: null,
      // CRITICAL (money, beyond ADR's consumer table): the IOU was booked with
      // `amount` = the ALREADY-NET share (income × share%) AND a non-null
      // seniorSharePercent/dropSharePercent snapshot. But getSeniorBalance /
      // getTotalEarned / getSeniorSummary use seniorSharePercent as a GROSS↔NET
      // discriminator on SENIOR_INCOME: non-null ⇒ treat amount as GROSS and
      // multiply by share% (→ NET × 26% = a ~26× UNDER-count of the senior).
      // Yesterday's settle-INSERTED SENIOR_INCOME left these null, so the amount
      // was used as-is (NET). We MUST null them to stay byte-identical and avoid
      // the double-application. (The drop side is safe today — computeDropAggregate
      // reads PAYOUT_DROP.amount directly — but we null it too for parity, since
      // yesterday's settle PAYOUT_DROP carried no share snapshot either.)
      seniorSharePercent: null,
      seniorSharePercentSource: null,
      dropSharePercent: null,
      dropSharePercentSource: null,
      // task-settled-amount-snapshot (AC5 + AC4, architecture doc §AC3
      // "Где хранится «сколько уже выплачено»"). Snapshot what was JUST
      // nulled two lines up into its OWN column instead of losing it — a
      // later cascade needs the percent that was in effect at THIS
      // settle to recompute a share once the row returns to PENDING.
      // Written fresh on EVERY settle (not accumulated — only the latest
      // percent is meaningful, unlike settledAmount right below it).
      settledSharePercent: isDropObligation ? sourceDropSharePercent : sourceSeniorSharePercent,
      // MONOTONIC accumulator — MED-3 (security-review round 1, PR #599),
      // DB-native increment. The expression itself, and why it is shared
      // with `amount` on the drop branch, is at `accumulatedAmount` above.
      settledAmount: accumulatedAmount,
      settledCurrency: currency,
      notes: isDropObligation
        ? `Закриття зобов’язання дропа (${obligation.id})`
        : `Закриття зобов’язання сеньйора (${obligation.id})`,
      updatedAt: new Date(),
      // Income rows carry validation provenance; a PAYOUT_DROP is a payout,
      // not a validated income, so it leaves these untouched (mirrors the
      // cascade PAYOUT_DROP shape). `createdBy` intentionally stays the
      // booking author — the settler is captured in `validatedBy` (senior) and
      // the notes (per ADR §Consequences: minor audit delta, deliberate).
      //
      // security-review PR #456 round 2 (MED-3): under impersonation this
      // used to record the IMPERSONATED target as the settler, while the
      // audit-log insert 20 lines below (in the same transaction, same
      // action) already correctly attributed the REAL operator via
      // `actor.impersonatorId ?? actor.id` — two provenance columns for one
      // action, disagreeing under the exact condition provenance exists to
      // catch. Same resolution, same field, now homogeneous.
      ...(isDropObligation
        ? {}
        : { validatedBy: actor.impersonatorId ?? actor.id, validatedAt: new Date() }),
    })
    .where(
      and(
        eq(transactions.id, obligation.sourceTransactionId),
        eq(transactions.status, 'PENDING_PAYMENT'),
        // task-cascade-apply (task 3, AC10) — TOCTOU on the ACCUMULATOR.
        //
        // `settledAmountThisSettle` was computed from `settled_amount` as
        // read BEFORE this transaction opened. If another settle of the
        // same row committed in between, that delta is computed against a
        // figure that is no longer true and would over-pay. Re-asserting
        // the value here costs no extra lock: a mismatch simply matches
        // zero rows, and the existing `if (!paidRow) throw` below already
        // turns that into a clean abort of the whole transaction.
        //
        // `IS NOT DISTINCT FROM` rather than `=` because the value is NULL
        // on a first-ever settle, and `NULL = NULL` is NULL, which would
        // match nothing and break every first settle in the system.
        sql`${transactions.settledAmount} IS NOT DISTINCT FROM ${sourceSettledAmount}::numeric`,
      ),
    )
    .returning()
  if (!paidRow) {
    // The claim already won (obligation was PENDING) so the source IOU MUST
    // have been PENDING_PAYMENT. Zero rows here means a corrupted invariant
    // (source flipped / deleted out of band) — abort so we never leave the
    // obligation PAID with no closing row (rolls back the claim too).
    throw apiError('FINANCE_OBLIGATION_CLOSE_SOURCE_NOT_PENDING', HttpStatus.BAD_REQUEST)
  }
  // Point closingTransactionId at the SAME row we just flipped (self-
  // reference). This keeps the C4 discriminator working: the flipped
  // SENIOR_INCOME id ∈ settlementTxIds so it is excluded from totalIncome
  // (its gross was already counted as the ADMIN_INCOME / DROP_INCOME).
  await dbtx
    .update(pendingObligations)
    .set({
      closingTransactionId: obligation.sourceTransactionId,
      updatedAt: new Date(),
    })
    .where(eq(pendingObligations.id, obligation.id))
  return paidRow
}
