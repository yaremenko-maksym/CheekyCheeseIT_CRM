/**
 * InvoiceVerifyService — public (unauthenticated) invoice verification and the
 * PAYOUT aggregate-amount resolver. Extracted verbatim from InvoicesService
 * (giant-decomposition L4); behavior, log messages and the verify response shape
 * are unchanged. InvoicesService keeps `verifyInvoice` and the private
 * `resolvePayoutAggregateAmount` as thin delegates, so its public API and the
 * single implementation behind the InvoiceCreationService callback are preserved.
 */
import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { InvoiceStatus, InvoiceVerifyResponse } from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import { nonDeletedTransactions, type Transaction } from '../database/schema'
import { fetchVisibleTransactionOrThrow } from '../finance/transaction-visibility.util'
import { toPublicVerifySignatures } from './invoice-dto.util'
import { InvoiceQueryService } from './invoice-query.service'

@Injectable()
export class InvoiceVerifyService {
  private readonly logger = new Logger(InvoiceVerifyService.name)

  constructor(
    private readonly db: DatabaseService,
    private readonly queryService: InvoiceQueryService,
  ) {}

  async verifyInvoice(transactionId: string): Promise<InvoiceVerifyResponse> {
    // security-review PR #456 round 2: fetch + visibility guard fused (see
    // getInvoice's comment). This is a PUBLIC, unauthenticated endpoint (the
    // PDF's QR code) — `currentUser: null` is always treated as
    // non-privileged, so a deleted transaction's invoice is never publicly
    // verifiable even though it was already gated on SIGNED status below.
    let tx: Transaction
    try {
      tx = await fetchVisibleTransactionOrThrow(this.db.db, transactionId, null)
    } catch {
      throw apiError('INVOICE_NOT_FOUND', HttpStatus.NOT_FOUND)
    }
    // task-aggregate-invoice-per-payout: PAYOUT rows are valid invoice anchors.
    if (tx.type !== 'SENIOR_INCOME' && tx.type !== 'SALARY' && tx.type !== 'PAYOUT') {
      throw apiError('INVOICE_NOT_FOUND', HttpStatus.NOT_FOUND)
    }
    if (!tx.invoiceDocumentId) {
      throw apiError('INVOICE_NOT_GENERATED_YET', HttpStatus.NOT_FOUND)
    }

    const sigs = await this.queryService.getSignaturesWithSignerNames(tx.id)

    // SEC-11: gate on SIGNED status — an invoice is publicly verifiable only
    // once the counterparty has signed. Returning data for PENDING invoices
    // would expose amount and counterparty name via transactionId enumeration
    // before the employee has consented to the payment record.
    const counterpartySig = sigs.find((s) => s.signerRole === 'COUNTERPARTY')
    if (!counterpartySig) {
      throw apiError('INVOICE_NOT_FOUND', HttpStatus.NOT_FOUND)
    }

    // AC3: source amount/currency from what the counterparty ACTUALLY
    // signed (frozen at sign time in `signInvoice`), never the live
    // `transactions` row — a later amount edit (or any write that bypasses
    // the AC2 void path) must not surface as "confirmed" here.
    //
    // When there IS a snapshot (the overwhelming common case post-MED-3),
    // it is authoritative, full stop. When there is NOT, the two remaining
    // row types get DIFFERENT honest treatment — security-review round 4
    // (PR #600, HIGH-3) is exactly the finding that treating them the same
    // was wrong:
    //   - non-PAYOUT (SALARY/SENIOR_INCOME): the migration's backfill
    //     covers every row that existed when it shipped, and MED-3 makes a
    //     NULL snapshot structurally impossible for anything signed after
    //     — reaching here means either the backfill has not run yet on
    //     this DB or a write bypassed `signInvoice` entirely. Live
    //     `tx.amount` is the fallback for this case. It is safe for the rows
    //     the backfill covers because BIZ-18 blocked ALL PAID-amount edits
    //     while they were signed. That is NO LONGER TRUE going forward
    //     (task-paid-salary-amount-edit, SR-M-1): a PAID SALARY's amount is
    //     editable now. What keeps this branch honest for such a row is not
    //     an edit ban but the edit path itself — it voids the old invoice
    //     (signatures `voided_at`, document soft-deleted) and re-issues, and
    //     every signature from then on goes through `signInvoice`, which
    //     writes the snapshot above. A failed void is journalled
    //     (`INVOICE_REISSUE_FAILED`), not silent.
    //   - PAYOUT: the migration's backfill deliberately EXCLUDES these
    //     rows (round 3, HIGH-2) because `tx.amount` there is the USDT
    //     payable, structurally a DIFFERENT number/currency from what was
    //     actually signed (the aggregated linked-income sum, BIZ-05). Round
    //     3 argued the live-`tx.amount` fallback was still SAFE for them —
    //     that argument was FALSE (round 4, HIGH-3): proven by this file's
    //     own integration spec, where a PAYOUT invoice signed
    //     `1000.000000 USD` had this fallback answer `740.000000 USDT`.
    //     Instead of the live column, recompute through
    //     `resolvePayoutAggregateAmount` — the SAME helper `signInvoice`
    //     uses to WRITE the snapshot, so read and write never describe the
    //     rule differently again.
    //
    // security-review round 5 (PR #600, HIGH-4): round 4 additionally
    // refused to answer whenever the linked incomes spanned more than one
    // currency — that refusal landed on a COUNTERPARTY holding a validly
    // signed act, who is entitled to see the confirmed amount, not a 409.
    // Mixed currency is a supported configuration (see
    // `resolvePayoutAggregateAmount`'s doc comment), so the helper no
    // longer refuses for that reason — it counts the blind sum and flags
    // `mixedCurrency` instead. The refusal below now fires ONLY when there
    // is genuinely no aggregate to compute at all (no linked incomes / no
    // payoutRequestId) — a DIFFERENT, still-legitimate case: there is no
    // number of any kind to show, not merely a currency-quality concern.
    let verifiedAmount: string
    let verifiedCurrency: Transaction['currency']
    // `mixedCurrency` is raised to the caller ONLY on the legacy-recompute
    // branch below — the common snapshot branch does not persist this flag
    // per-signature (no schema change this round). security-review round 6
    // (MED-G): the default used to be `false`, which asserted "confirmed
    // not mixed" for the COMMON snapshot-present branch even though that
    // branch never inspects the linked incomes at all — an affirmative lie
    // about exactly the case the flag exists to report (proven by this
    // file's own HIGH-4 test, a signed 1000 USD + 500 EUR batch reading
    // back `false`). `null` is the honest default: "not determined on this
    // response's path" — only the legacy-recompute branch below, which
    // actually calls `resolvePayoutAggregateAmount`, may overwrite it with
    // a real `true`/`false`.
    let mixedCurrency: boolean | null = null
    // `!= null` (loose) — deliberately catches BOTH `null` (the real,
    // nullable-column value from Postgres) and `undefined` (what a mocked
    // unit-test fixture yields when it omits the field entirely), matching
    // the `??` fallback semantics the pre-round-4 single-expression version
    // of this branch relied on. A strict `!== null` here would silently
    // treat "field omitted" as "has a snapshot" in the mocked unit spec.
    if (counterpartySig.amountSnapshot != null) {
      verifiedAmount = counterpartySig.amountSnapshot
      verifiedCurrency = (counterpartySig.currencySnapshot ??
        tx.currency) as Transaction['currency']
    } else if (tx.type === 'PAYOUT') {
      const resolved = await this.resolvePayoutAggregateAmount(tx.payoutRequestId)
      if (!resolved) {
        // Genuinely nothing to confirm — no linked incomes / no
        // payoutRequestId (see resolvePayoutAggregateAmount's own doc
        // comment). Mixed currency no longer reaches this branch (round 5
        // — it now always resolves, counted and flagged); reaching HERE
        // means there is no aggregate AT ALL, not a currency-quality
        // concern, so an honest refusal is still the only truthful answer.
        this.logger.error(
          `verifyInvoice: tx=${tx.id} type=PAYOUT COUNTERPARTY signature ${counterpartySig.id} has NULL amount_snapshot and the linked-income aggregate could not be resolved — refusing to confirm an amount`,
        )
        throw apiError('INVOICE_AMOUNT_VERIFICATION_FAILED', HttpStatus.CONFLICT)
      }
      // MED-D (round 4): this branch is now the ONLY standing source of
      // this warning — a legacy PAYOUT row signed before this migration
      // shipped. Every other case either has a snapshot or, post-backfill,
      // should not exist — logged at `warn`, not `error`, because this is
      // the EXPECTED path for those rows, not an anomaly. `mixedCurrency`
      // appended (round 5) so the residual currency-drift risk documented
      // on `resolvePayoutAggregateAmount` stays visible in the record for
      // this specific legacy row, not just the helper's own log line.
      this.logger.warn(
        `verifyInvoice: tx=${tx.id} type=PAYOUT COUNTERPARTY signature ${counterpartySig.id} has NULL amount_snapshot — recomputed from linked incomes (legacy row signed before this migration), mixedCurrency=${resolved.mixedCurrency}`,
      )
      verifiedAmount = resolved.amount
      verifiedCurrency = resolved.currency
      mixedCurrency = resolved.mixedCurrency
    } else {
      // MED-D (round 4): non-PAYOUT branch, logged separately from PAYOUT
      // above (previously one shared message covered both, discussed in
      // the MED-D finding as noise once the PAYOUT case became the only
      // standing source of it).
      this.logger.warn(
        `verifyInvoice: tx=${tx.id} type=${tx.type} COUNTERPARTY signature ${counterpartySig.id} has NULL amount_snapshot — falling back to live tx.amount`,
      )
      verifiedAmount = tx.amount
      verifiedCurrency = tx.currency
    }

    return {
      transactionId: tx.id,
      status: 'SIGNED' as InvoiceStatus,
      amount: verifiedAmount,
      currency: verifiedCurrency,
      mixedCurrency,
      // Public InvoiceType enum is SENIOR_INCOME | SALARY — PAYOUT maps to
      // SENIOR_INCOME for the verify response.
      type: (tx.type === 'PAYOUT' ? 'SENIOR_INCOME' : tx.type) as 'SENIOR_INCOME' | 'SALARY',
      // Public fields only (SEC-05 COMPANY name masking) — see toPublicVerifySignatures.
      signatures: toPublicVerifySignatures(sigs),
    }
  }

  /**
   * Resolve the amount/currency a PAYOUT-anchored invoice was (or would be)
   * signed with — the aggregate over the linked SENIOR_INCOME/DROP_INCOME
   * rows sharing `payoutRequestId`, assembled the exact same way as the PDF
   * this service actually prints. Single source of truth for ALL THREE
   * places that need this number — `autoCreateForPayout` (initial
   * COMPANY-only PDF), `signInvoice` (writes `amountSnapshot`/
   * `currencySnapshot` from this), and `verifyInvoice` (recomputes from
   * this when a legacy row has no snapshot) — same "all stay pinned to
   * identical numbers" discipline as `roundShareAmount`
   * (`transactions.service.ts`, `bookCompanyObligations`).
   *
   * security-review round 4 (PR #600, HIGH-3): before this helper existed,
   * `signInvoice` and `verifyInvoice`'s fallback each re-derived this
   * number independently — the fallback used `tx.amount` (the USDT
   * payable, BIZ-05), a structurally different number/currency from the
   * aggregate `signInvoice` actually signs. Two descriptions of one rule
   * had drifted apart; this made it one — but round 4 ALSO made this
   * helper refuse (return `null`) whenever the linked incomes spanned more
   * than one currency.
   *
   * security-review round 5 (PR #600, HIGH-4): that refusal never actually
   * reached the caller. `signInvoice`'s `?? tx.amount` fallback (removed
   * this round — see its own call site) silently swallowed the `null` and
   * wrote a DIFFERENT number into `amountSnapshot` than the one the PDF
   * actually printed — the exact defect this file exists to prevent, moved
   * from a read-time bug (HIGH-3) to a write-time one. Mixed-currency
   * batches are also an intentionally SUPPORTED configuration
   * (`transactions.service.ts` — the mixed-currency PAYOUT guard was
   * deliberately removed as a bug fix, not tightened), not an edge case —
   * so refusing was the wrong lever twice over. This helper now COUNTS
   * (the blind sum of `parseFloat` amounts across every linked row
   * regardless of currency — exactly what was printed before round 4,
   * now with a deterministic `ORDER BY` instead of an unspecified one) and
   * flags the result via `mixedCurrency` instead of refusing. The
   * invariant this file protects is "paper == snapshot == QR", not "the
   * printed sum is currency-correct" — the latter is a real defect in the
   * printed DOCUMENT (summing currencies without conversion), but what
   * gets printed is a product/legal decision, not this helper's call (see
   * the task doc's "чего НЕ делать" section, backlog item 83).
   *
   * Returns `null` ONLY when there is genuinely no number to compute — the
   * caller MUST treat that as "amount cannot be confirmed", never silently
   * substitute a different source (that substitution is exactly what
   * caused HIGH-3/HIGH-4):
   *   - `payoutRequestId` is NULL — structurally shouldn't happen for a
   *     PAYOUT row that reached `signInvoice`/`verifyInvoice`, defensive
   *     only;
   *   - zero linked incomes — "should never happen in production" per the
   *     BIZ-05 comment this mirrors (`autoCreateForPayout` already refuses
   *     to auto-create in this case, so a signed PAYOUT row reaching this
   *     state at all would mean the linked incomes were removed AFTER
   *     signing).
   *
   * Residual risk (round 5, named rather than silenced): a LEGACY PAYOUT
   * row signed before the amountSnapshot mechanism shipped has no snapshot
   * at all — `verifyInvoice`'s legacy branch recomputes through this
   * helper live, using TODAY'S deterministic `ORDER BY createdAt ASC`. The
   * ORIGINAL (pre-round-4) inline computation did NOT order its rows, so
   * for a legacy mixed-currency batch the currency label returned here
   * (first row by `createdAt`) may not be the one actually printed on the
   * document the counterparty is holding. There is no snapshot to recover
   * the true original from — this cannot be fixed without data that no
   * longer exists, only disclosed.
   */
  async resolvePayoutAggregateAmount(payoutRequestId: string | null): Promise<{
    amount: string
    currency: Transaction['currency']
    mixedCurrency: boolean
  } | null> {
    if (!payoutRequestId) return null
    // Deterministic ordering (round 4, HIGH-3 remediation): the previous
    // inline version of this query had no ORDER BY, so "the first row's
    // currency" was whichever order Postgres happened to return — an
    // unordered SELECT backing a legal-document amount is worth pinning
    // down explicitly rather than leaving to chance (see the residual-risk
    // note in the doc comment above for the one case this cannot retroactively fix).
    const linkedIncomes = await this.db.db
      .select()
      .from(nonDeletedTransactions)
      .where(
        and(
          eq(nonDeletedTransactions.payoutRequestId, payoutRequestId),
          // A raw Drizzle predicate object handed to `.where(...)` — this
          // file's own mocked harness (invoices.service.spec.ts) is a
          // "semantic-only stub" per its top-of-file rationale comment:
          // `.where(_p) => chain` discards its argument entirely and
          // resolves rows purely from a control hint
          // (`ctrl.linkedPayoutRequestId`), never from the actual predicate
          // value, so no unit test built on that harness can distinguish
          // this array changing — the SAME class of gap the `signedFlag`
          // raw-SQL suppression a few hundred lines up already documents.
          // Covered for real by invoice-signature-integrity.integration
          // .spec.ts's HIGH-2/AC2-bis tests, which construct actual
          // SENIOR_INCOME/DROP_INCOME rows against real Postgres and would
          // fail to find them (wrongly refusing, or wrongly aggregating) if
          // this array were narrowed.
          // Stryker disable next-line StringLiteral,ArrayDeclaration: see comment above — a raw Drizzle predicate this mocked-harness stub structurally cannot see; covered against real Postgres by invoice-signature-integrity.integration.spec.ts's HIGH-2/AC2-bis tests instead.
          inArray(nonDeletedTransactions.type, ['SENIOR_INCOME', 'DROP_INCOME']),
        ),
      )
      .orderBy(asc(nonDeletedTransactions.createdAt))
    if (linkedIncomes.length === 0) return null
    const currencies = new Set(linkedIncomes.map((row) => row.currency))
    const mixedCurrency = currencies.size > 1
    if (mixedCurrency) {
      // security-review round 5 (PR #600, HIGH-4): no longer refuses — see
      // the doc comment above. Logged explicitly and separately from every
      // other warning this helper/its callers emit, so the drift stays
      // visible in the record instead of vanishing into a generic message.
      this.logger.warn(
        `resolvePayoutAggregateAmount: payoutRequestId=${payoutRequestId} has linked incomes in more than one currency (${[...currencies].sort().join(', ')}) — printing the blind sum across currencies (mixed-currency batches are a supported configuration, see transactions.service.ts); mixedCurrency=true`,
      )
    }
    // parseFloat aggregation is display-only (PDF label / verify response)
    // — not used for money movement. Mirrors autoCreateForPayout's approach
    // exactly. Floating-point drift is bounded to sub-cent amounts (≤ 6
    // decimal places) and has no financial side-effect.
    //
    // `.toFixed(6)`, not `.toString()` (round 4 fix): every OTHER amount
    // this service deals with is a `numeric(18,6)` column value round-
    // tripped through Postgres, which always formats to exactly 6 decimal
    // places on read (e.g. `tx.amount`, a written `amountSnapshot`). This
    // helper's result reaches `verifyInvoice`'s response directly, with NO
    // such round-trip to normalize it — a bare `.toString()` on a whole
    // number would return `'1000'`, not `'1000.000000'`, silently breaking
    // format parity with every other amount this same endpoint can return.
    const amount = linkedIncomes.reduce((sum, row) => sum + parseFloat(row.amount), 0).toFixed(6)
    return { amount, currency: linkedIncomes[0]!.currency, mixedCurrency }
  }
}
