import type { PendingObligationStatus } from '../finance'
import type { CurrencyEnum } from '../payment-requisites'

// ---------------------------------------------------------------------------
// Snapshot — the resolver's input contract.
//
// Plain TS types, not Zod: this shape never crosses an external boundary by
// itself (it is assembled server-side by `loadCascadeSnapshot` and consumed
// server-side by `resolveEditCascade`), the same convention
// `PendingSettlementService.resolveSource`'s return type already uses for an
// internal read-shape in `apps/api`. Zod schemas below start where the
// output actually crosses the wire (the `GET /edit-preview` response).
// ---------------------------------------------------------------------------

export interface CascadeSourceSnapshot {
  id: string
  /** `transactions.type` — e.g. 'ADMIN_INCOME'. */
  type: string
  /** `transactions.status` at read time. */
  status: string
  amount: number
  currency: CurrencyEnum
  /** Guard 2 (`transactions.service.ts:2947-2949`) — never edited, only read. */
  payoutRequestId: string | null
  /** ISO timestamp — one of the ingredients of `computeCascadeVersion`. */
  updatedAt: string
  /**
   * MED-1 (security-review round 1): does the row BEING EDITED already carry
   * a COUNTERPARTY-signed invoice (`invoice_signatures`)? A cascade source is
   * not always an `ADMIN_INCOME` — after guard 3 is lifted (task 3), any
   * `PAID` row is editable, including a `SALARY` payment that already has its
   * own signed invoice. AC5 §6 of the ADR: silence here is the worst option.
   */
  hasSignedInvoice: boolean
  /**
   * `transactions.original_amount` on the SOURCE row itself — non-null means
   * this row is a fact-of-payment record (`paySalary` / a currency-converted
   * settle), not our own estimate (C2 of the ADR). AC5 §5: editing `amount`
   * here would desync `exchangeRate = amount / originalAmount` without
   * anyone noticing.
   */
  originalAmount: number | null
  /**
   * task-paid-salary-amount-edit — the other two thirds of the payment-fact
   * triplet on the SOURCE row. A paid `SALARY` stays editable (owner decision
   * 2026-09-25): the obligation follows the corrected `amount` at THIS rate,
   * which never moves, so the snapshot has to carry it. `null` rate = none
   * was recorded (owner decision: edit without recomputing, said out loud).
   */
  originalCurrency: CurrencyEnum | null
  exchangeRate: string | null
  /**
   * `transactions.settled_amount` on the SOURCE row ITSELF (task 3, AC13 /
   * addendum §1.12, security-review SR-H-1).
   *
   * A settled derivative is editable too — `settleByCompany`'s flip clears
   * `payoutRequestId` (so guard 2 lets it through) and leaves `originalAmount`
   * NULL on the senior branch (so the C2 guard lets it through), while ledger
   * term 7 debits the company account BY that row's `amount`. Editing it down
   * raises the balance by the difference, and the AC6 reconciliation cannot
   * see it: that walks `plan.derivatives`, and here the edited row IS the
   * source. Non-null means "this row's amount is pinned to what was actually
   * paid" — a second carrier the edit does not move.
   */
  settledAmount: number | null
  /**
   * Does a `pending_obligations` row exist with
   * `source_transaction_id = <this row> AND status = 'PAID'`? (task 3, AC13.)
   *
   * The pre-#599 form of `settledAmount` above: rows closed before the
   * accumulator column existed carry no `settled_amount`, but they still close
   * an obligation and still stand in a ledger term. Keying on
   * `source_transaction_id` is correct precisely because a settle flips the
   * row IN PLACE — after the flip `source_transaction_id`,
   * `closing_transaction_id` and the row's own id are the same value.
   */
  hasClosedObligation: boolean
}

export interface CascadeObligationSnapshot {
  id: string
  status: PendingObligationStatus
  /** `pending_obligations.amount` — the obligation's own figure. */
  amount: number
  /**
   * `pending_obligations.currency` — the unit `amount` above is denominated
   * in. task-cascade-apply (backlog 95, addendum §3.5): `bookCompanyObligations`
   * stamps `'USDT'` as a LITERAL, and the only thing that kept that literal
   * in step with the source income's currency was BIZ-18 — the very guard
   * task 3 lifts. So the value is now READ rather than assumed (the first of
   * the two legal moves in addendum §3.1), and the mismatch is said out loud
   * (`OBLIGATION_CURRENCY_MISMATCH` below) rather than silently written
   * through — the cascade WRITES a share of the source amount into this
   * column, so its unit has to be checked, not presumed.
   */
  currency: CurrencyEnum
  updatedAt: string
}

export interface CascadeDerivativeSnapshot {
  id: string
  /** e.g. 'SENIOR_PENDING_PAYOUT' / 'DROP_PENDING_PAYOUT' (still open) or 'SENIOR_INCOME' / 'PAYOUT_DROP' (flipped by settle). */
  type: string
  /**
   * UX-1 (design fidelity, HIGH, reopened) — `transactions.receiver.displayName`
   * of THIS derivative row, read from the database like every other field here.
   *
   * It is carried rather than derived because it cannot be derived. The client
   * previously inferred the receiver from the SOURCE row, on the premise
   * "source receiver == derivative receiver". That premise holds for
   * `SENIOR_INCOME` (a senior declaring their own income) and FAILS for
   * `ADMIN_INCOME` — the main path of this feature, where the source receiver
   * is always the admin. The panel then printed the ADMIN's name against the
   * SENIOR's share: not a missing name, a WRONG one, on the screen where an
   * operator decides whose money moves. Static review could not catch it
   * (the type universe genuinely is closed); a live run against real rows did.
   *
   * `null` when the row has no receiver or the join finds no user — the panel
   * falls back to a family label rather than inventing an identity.
   */
  receiverName: string | null
  status: string
  /** `transactions.amount` on the derivative row AS STORED TODAY. */
  amount: number
  currency: CurrencyEnum
  updatedAt: string
  /**
   * The share-percent snapshot the resolver is ALLOWED to recompute from —
   * `seniorSharePercent`/`dropSharePercent` while the row is still
   * `PENDING_PAYMENT`, or `null` once `settleByCompany` has nulled them on
   * the flip (see `settledSharePercent` below for where that value moves
   * to). Never the LIVE resolver (`resolveSeniorShare`/`resolveDropShare`) —
   * AC5 §4 forbids that unconditionally.
   */
  sharePercent: number | null
  /**
   * `transactions.settled_amount` — the monotonic "already paid" accumulator
   * written by `settleByCompany` (task 1, PR #599). `null` on a row that has
   * never gone through a settle.
   */
  settledAmount: number | null
  /** `transactions.settled_currency` — the currency `settledAmount` is denominated in. `null` alongside `settledAmount`. */
  settledCurrency: CurrencyEnum | null
  /** `transactions.settled_share_percent` — the percent snapshot taken the moment settle nulled `sharePercent` above. */
  settledSharePercent: number | null
  /**
   * `transactions.funding_source` — `'COMPANY_ACCOUNT'` once
   * `settleByCompany` has paid this row out of the shared USDT account,
   * `null` for an unsettled IOU or an `ADMIN_PERSONAL` settle.
   *
   * task-cascade-apply (task 3, AC6 / addendum §1.2): the RESOLVER does not
   * read it — reverting a row is not a currency or share question. The APPLY
   * step does, and it is the deciding field for the one refusal that stands
   * between a wrong ledger and the money gates: only a COMPANY_ACCOUNT row
   * participates in ledger terms 7/8/9, so only for such a row does the
   * `amount == settled_amount` invariant have to hold before the revert can
   * hand the right debit back. It lives on the SNAPSHOT rather than being
   * re-read separately because `loadCascadeSnapshot` is deliberately the ONE
   * read shape both entry points use (ADR AC4) — a second query for one
   * column would fork that shape.
   */
  fundingSource: string | null
  /**
   * `transactions.original_amount` / `original_currency` / `exchange_rate` —
   * the PAYMENT-FACT TRIPLET, stamped by `settleByCompany` on every DROP
   * settle (a SENIOR settle never writes it).
   *
   * task-drop-topup (task 3b, addendum 1.4/1.5): the RESOLVER does not read
   * these — reverting a row is not a currency question, and no branch of
   * `resolveDerivative` changes because of them. The APPLY step does, for two
   * reasons that both come down to `amount` being rewritten by a revert:
   *
   *  1. the triplet's truth is stated RELATIVE to `amount` (`amount =
   *     original_amount × exchange_rate`), so a revert has to null it — the
   *     row would otherwise sit in `PENDING_PAYMENT` still asserting it was
   *     paid, for exactly as long as the owner is deciding how much to top up;
   *  2. what is nulled has to be RETRACTABLE, so the values go into
   *     `CASCADE_REOPEN.metadata.before` — which means `applyEditCascade` has
   *     to be holding them.
   *
   * On the snapshot rather than re-read: `loadCascadeSnapshot` is deliberately
   * the ONE read shape both entry points use (ADR AC4), and it already selects
   * the whole row — a second query for these columns would fork that shape for
   * nothing. Same argument as `fundingSource` above.
   */
  originalAmount: number | null
  originalCurrency: CurrencyEnum | null
  exchangeRate: string | null
  /**
   * `transactions.receipt_document_id` / `receipt_external_url` — the proof of
   * the payment being retracted.
   *
   * task-drop-topup (task 3b, "Семья однозначных колонок"): a revert does NOT
   * clear these (a receipt is a self-standing record — it was and stays true),
   * but the NEXT settle overwrites them with its own proof, because the row
   * has one pair of receipt columns and the closure now has two payments.
   * Journalling them at the moment of the revert is what keeps the first
   * payment's proof from disappearing silently. Read by the APPLY step only,
   * never by the resolver.
   */
  receiptDocumentId: string | null
  receiptExternalUrl: string | null
  /**
   * `transactions.tx_date` as an ISO string — the day the payment being
   * retracted was recorded as of (`SettleFunding.txDate`), or `null` when the
   * settle never supplied one.
   *
   * SR-M-1 (security-review, task 3b): same family as the receipt links above,
   * and journalled for the same reason. The revert does NOT clear it — a date
   * is a self-standing record of when money moved — but the NEXT settle
   * OVERWRITES it, because the row has one date column and the closure now has
   * two payments. Without this on the snapshot, the day of the first payment
   * would be gone the moment the remainder is topped up.
   */
  txDate: string | null
  /** Does this row's invoice already carry a `COUNTERPARTY` signature? (`invoice_signatures`, `signer_role='COUNTERPARTY'`.) */
  hasSignedInvoice: boolean
  /** The `pending_obligations` row this derivative booked, if any (always present for a real L1/L2 derivative — nullable defensively). */
  obligation: CascadeObligationSnapshot | null
}

export interface CascadeSnapshot {
  source: CascadeSourceSnapshot
  derivatives: CascadeDerivativeSnapshot[]
}

/** What the ADMIN is proposing to change the source row's `amount` to. */
export interface CascadeEditPatch {
  amount: number
}

export type SalaryPaymentFactEdit =
  | { kind: 'RECOMPUTED'; newOriginalAmount: number }
  | { kind: 'RATE_NOT_RECORDED' }
  | { kind: 'UNREPRESENTABLE' }
