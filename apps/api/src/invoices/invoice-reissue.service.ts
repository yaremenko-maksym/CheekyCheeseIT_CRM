/**
 * InvoiceReissueService — the void / re-issue family of an invoice after an
 * amount edit (task-invoice-signature-integrity AC2, task-paid-salary-amount-edit).
 * Extracted verbatim from InvoicesService (giant-decomposition L6); behavior, SQL,
 * log messages and the `InvoiceReissueOutcome` verdicts are unchanged.
 * InvoicesService keeps thin delegates, so its public API (and the cross-module
 * surface finance/TransactionsService calls) is preserved. The two `autoCreate*`
 * triggers are late-bound through the facade so spies on them still intercept.
 * Plain class built lazily by the facade (no DI registration), like InvoiceCreationService.
 */
import { Logger } from '@nestjs/common'
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { amountsDiffer } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import {
  invoiceSignatures,
  nonDeletedTransactions,
  transactionAuditLog,
  transactions,
} from '../database/schema'
import type { DocumentsService } from '../documents/documents.service'

/** The invoice-creation triggers a re-issue calls back into (bound by the facade). */
export interface ReissueTriggers {
  autoCreateForSalary: (transactionId: string) => Promise<void>
  autoCreateForSeniorPayout: (transactionId: string) => Promise<void>
}

/**
 * task-paid-salary-amount-edit (SR-M-1) — what happened to a row's invoice
 * after an edit. The two `*_FAILED` values are what the caller journals
 * (`INVOICE_REISSUE_FAILED`) and reports in the response; before, both were
 * only log lines, and the second left a salary without an invoice forever.
 */
export type InvoiceReissueOutcome = 'REISSUED' | 'NOT_NEEDED' | 'VOID_FAILED' | 'REISSUE_FAILED'

/**
 * `loadReissueState`'s two projections, hoisted so each carries its own
 * mutation-gate directive: an inline `next-line` comment inside the call chain
 * was not honoured by Stryker (measured on PR #721), and a block `disable`
 * is refused by the gate.
 */
// Stryker disable next-line ObjectLiteral: a Drizzle query SHAPE — the unit double in `invoice-reissue-outcome.unit.spec.ts` answers with canned rows whatever is selected, so `{}` is unobservable without a live Postgres (mutation-gate-integration-specs.md)
const REISSUE_STATE_COLUMNS = {
  type: nonDeletedTransactions.type,
  status: nonDeletedTransactions.status,
  payoutRequestId: nonDeletedTransactions.payoutRequestId,
  invoiceDocumentId: nonDeletedTransactions.invoiceDocumentId,
  amount: nonDeletedTransactions.amount,
}
// Stryker disable next-line ObjectLiteral: same query SHAPE — only the presence of a row is read, never its columns
const VOIDED_SIGNATURE_COLUMNS = { id: invoiceSignatures.id }
// Stryker disable next-line ObjectLiteral: same query SHAPE — the unit double answers with canned rows whatever is selected
const COUNTERSIGNATURE_AMOUNT_COLUMNS = { amountSnapshot: invoiceSignatures.amountSnapshot }
// Stryker disable next-line ObjectLiteral: same query SHAPE — the unit double answers with canned rows whatever is selected
const ACTIVE_COMPANY_SIGNATURE_COLUMNS = { signedAt: invoiceSignatures.signedAt }
// Stryker disable next-line ObjectLiteral: same query SHAPE — the unit double answers with canned rows whatever is selected
const VOID_FAILURE_COLUMNS = { createdAt: transactionAuditLog.createdAt }

/**
 * What `loadReissueState` reads, and the three questions asked of it.
 * Plain functions rather than methods: they are pure decisions over that shape,
 * and the mutation gate can see every branch of them through the service's own
 * unit double.
 */
export interface ReissueState {
  type: string
  status: string
  payoutRequestId: string | null
  invoiceDocumentId: string | null
  hasVoidedInvoice: boolean
  /** `transactions.amount` as stored right now. */
  amount: string
  /**
   * SR-M-4 — `amount_snapshot` of the ACTIVE COUNTERPARTY signature: the
   * figure `/verify` confirms to anyone scanning the QR. `null` when nobody
   * has countersigned, or when the signature predates the snapshot column.
   */
  signedAmountSnapshot: string | null
  /**
   * SR-M-6 — the SECOND, weaker witness of a failed void, for the window the
   * first one cannot see: an invoice issued but not yet countersigned.
   * `signed_at` of the active COMPANY signature (every issued invoice gets
   * one) and `created_at` of the last `INVOICE_REISSUE_FAILED` line with
   * `stage: VOID`.
   */
  activeCompanySignedAt: Date | null
  lastVoidFailureAt: Date | null
}

/** A PAID salary of its own — not a payout-linked row, not another type. */
function isRepairableSalary(state: ReissueState | null): state is ReissueState {
  return !!state && state.type === 'SALARY' && state.status === 'PAID' && !state.payoutRequestId
}

/** The REISSUE stage: the invoice is gone and nothing replaced it. */
function awaitsReissue(state: ReissueState): boolean {
  return !state.invoiceDocumentId && state.hasVoidedInvoice
}

/**
 * The VOID stage — a document that is still current although the edit was
 * supposed to retire it. TWO witnesses, asked in this order, because neither
 * covers the whole population on its own (SR-M-4 → SR-M-6).
 *
 *  1. THE DISAGREEMENT ITSELF (sufficient, cannot go missing). The active
 *     COUNTERPARTY signature carries `amount_snapshot` — the figure `/verify`
 *     confirms to anyone scanning the QR — and `transactions.amount` carries
 *     the corrected one. They differ if and only if a void failed to retire
 *     that document. Round 2 keyed the whole thing on a journal line instead,
 *     and that line is written best-effort (SR-L-5) by the very path whose
 *     database was already failing: exactly when the void failed hardest, the
 *     marker was absent and a countersigned invoice for the OLD amount stayed
 *     current forever.
 *
 *  2. THE JOURNAL LINE (additional, asked ONLY where witness 1 is silent —
 *     i.e. nothing is countersigned. A countersignature that AGREES settles
 *     the question by itself; see SR-L-7 in the body).
 *     Before the counterparty signs there is no snapshot to disagree with, yet
 *     the stale document is still live — and `signInvoice`'s hash guard
 *     compares it against its own COMPANY signature, matches, and lets the
 *     counterparty sign the OLD figure. So a recorded `stage: VOID` failure
 *     counts too, cut off by age: an active COMPANY signature NEWER than that
 *     failure is a document issued after it, i.e. a repair that already
 *     happened. That cut-off is what keeps the repair idempotent.
 *
 * Why journal-as-second and not «void the document on MANUAL_CHECK»: the
 * message path must not write. Voiding there would retire a live invoice from
 * inside a branch whose only job is to choose a sentence — and on the failure
 * of a failure, at that.
 */
function awaitsVoidRetry(state: ReissueState): boolean {
  if (!state.invoiceDocumentId) return false
  const signed = state.signedAmountSnapshot
  // SR-L-7 — witness 1 is CONCLUSIVE in both directions, so witness 2 is only
  // asked where witness 1 has nothing to say. A countersignature that AGREES
  // with the row means the live document attests the right figure, whatever
  // the journal remembers: A→B with a failed void, then B→A, leaves the old
  // `stage: VOID` line behind while the figures match again. Retrying there
  // would void a correct, countersigned document and send the counterparty a
  // fresh signing request for nothing — safe-direction, one cycle, still
  // destroying a valid signature.
  if (signed !== null) return amountsDiffer(Number(signed), Number(state.amount))
  const failedAt = state.lastVoidFailureAt
  if (failedAt === null) return false
  const signedAt = state.activeCompanySignedAt
  // Comparison through `getTime()`: `null < aDate` is `true` in JS by
  // coercion, so the «no signature» case and the ordering case would
  // otherwise be indistinguishable — to a reader and to the gate alike.
  if (signedAt === null) return true
  return signedAt.getTime() < failedAt.getTime()
}

export class InvoiceReissueService {
  private readonly logger = new Logger(InvoiceReissueService.name)

  constructor(
    private readonly db: DatabaseService,
    private readonly documentsService: DocumentsService,
    private readonly triggers: ReissueTriggers,
  ) {}

  // Void on amount edit (task-invoice-signature-integrity, AC2)
  // ===========================================================================

  /**
   * AC2 (owner decision 2026-08-22). Called by the amount-edit path
   * (task-3, apps/api paid-transaction-edit-cascade) for ANY transaction
   * whose `amount` is about to change (or has just changed) and that
   * currently carries an invoice. The invoice PDF is a legal artifact bound
   * to specific bytes and cannot be "corrected" — this VOIDS it wholesale
   * instead of silently re-rendering:
   *   - soft-deletes the current document (`documentsService.softDeleteInternal`
   *     — same call `signInvoice` already uses for its superseded doc; the
   *     file stays in S3/audit trail, just no longer "the" active document);
   *   - stamps `voidedAt` on every currently-active `invoice_signatures` row
   *     for this transaction — rows are NEVER deleted. "Person X clicked
   *     sign on file with hash H at time T" is a historical fact that stays
   *     true forever and may be needed to investigate a dispute; only the
   *     row's *authority* over "is this transaction currently signed" is
   *     retired (see the schema doc comment on `voidedAt` for the full
   *     reasoning, and the partial unique index that makes this safe to do
   *     repeatedly without colliding with a future re-sign);
   *   - nulls `transactions.invoiceDocumentId`, which is what makes
   *     `autoCreate` / `autoCreateForPayout`'s existing idempotency guard
   *     (`if (tx.invoiceDocumentId) return`) allow a FRESH invoice the next
   *     time this transaction (re-)reaches PAID.
   *
   * Returns `{ hadInvoice, wasSigned }` — `reissueInvoiceIfStillPaid`
   * (AC2-bis, below) uses `hadInvoice` to decide whether an immediate
   * reissue is needed; a caller surfacing this to an admin can use
   * `wasSigned` to warn "this voided a COUNTERPARTY-signed invoice, not
   * just a pending one".
   *
   * security-review round 2 (PR #600, MED-1 + MED-2): the three writes
   * below (document soft-delete, signature void-stamp, FK null-out) now run
   * inside ONE `db.transaction`, opened with a `SELECT … FOR UPDATE` on the
   * transaction row —
   *   - MED-2: a mid-sequence failure used to leave "SIGNED" pointing at a
   *     document that had already been soft-deleted (three unguarded
   *     writes); now it is all-or-nothing;
   *   - MED-1: `signInvoice` takes no lock of its own (the S3 render/upload
   *     it does in between would hold one far too long) — instead it ends
   *     with a repoint conditioned on `invoiceDocumentId` still equalling
   *     the document IT started from. Locking the row HERE for the
   *     duration of the void makes that condition race-free: a concurrent
   *     `signInvoice` either fully commits before this void starts (this
   *     void then immediately re-voids the fresh signature — the same
   *     outcome as any post-sign amount edit, not a new hazard) or blocks
   *     on the lock until this void commits, then finds
   *     `invoiceDocumentId` already nulled and its own conditional repoint
   *     no longer matches — 409 instead of silently repointing onto a
   *     voided document.
   */
  async voidInvoiceForAmountEdit(
    transactionId: string,
    actorId: string,
  ): Promise<{ hadInvoice: boolean; wasSigned: boolean }> {
    return this.db.db.transaction(async (dbtx) => {
      // Must use the select-builder against the raw table (not
      // query.findMany / the nonDeletedTransactions VIEW) — Drizzle's
      // relational API does not expose `.for('update')`, and locking
      // through a view is unnecessary indirection for a single-row lock.
      // Same pattern as transactions.service.ts's payout-batch lock.
      const [tx] = await dbtx
        .select()
        .from(transactions)
        .where(and(eq(transactions.id, transactionId), isNull(transactions.deletedAt)))
        .for('update')
        .limit(1)
      if (!tx || !tx.invoiceDocumentId) return { hadInvoice: false, wasSigned: false }

      const activeSigs = await dbtx
        .select({ signerRole: invoiceSignatures.signerRole })
        .from(invoiceSignatures)
        .where(
          and(
            eq(invoiceSignatures.transactionId, transactionId),
            isNull(invoiceSignatures.voidedAt),
          ),
        )
      const wasSigned = activeSigs.some((s) => s.signerRole === 'COUNTERPARTY')

      await this.documentsService.softDeleteInternal(tx.invoiceDocumentId, actorId, dbtx)
      await dbtx
        .update(invoiceSignatures)
        .set({ voidedAt: new Date() })
        .where(
          and(
            eq(invoiceSignatures.transactionId, transactionId),
            isNull(invoiceSignatures.voidedAt),
          ),
        )
      await dbtx
        .update(transactions)
        .set({ invoiceDocumentId: null, updatedAt: new Date() })
        .where(eq(transactions.id, transactionId))

      this.logger.log(
        `voidInvoiceForAmountEdit: tx=${transactionId} wasSigned=${wasSigned} doc=${tx.invoiceDocumentId}`,
      )
      return { hadInvoice: true, wasSigned }
    })
  }

  /**
   * AC2-bis. Closes the gap `voidInvoiceForAmountEdit` opens on its own:
   * `autoCreate*`'s idempotency guard only fires on the NEXT transition to
   * PAID, but not every invoice-bearing type re-transitions after an
   * amount edit —
   *   - SALARY never does: it is not a cascade derivative of anything
   *     (docs/architecture/2026-08-22-paid-transaction-edit-cascade.md
   *     AC3, "Глубже одного уровня" — the only cascade source is
   *     ADMIN_INCOME). `paySalary` is the sole PAID-transition trigger and
   *     nothing re-runs it just because the amount changed;
   *   - a directly-edited SENIOR_INCOME row that is NOT itself the
   *     cascade-reverted derivative of an ADMIN_INCOME edit behaves the
   *     same way — a leaf edit with no upstream to bounce it through
   *     PENDING again;
   *   - PAYOUT rows are structurally unreachable here: edits are blocked by
   *     both the PAYOUT-family block and the payoutRequestId guard ("гвард
   *     2") in `TransactionsService.adminUpdateTransaction` — nothing to
   *     do, ever.
   *
   * Reading `tx.status` AFTER the caller applies the amount change (and
   * after any cascade-driven status flip has already happened) is what
   * makes this correct for BOTH cases without needing to know which one
   * applies: if the row is STILL PAID, nothing else will ever re-trigger
   * `autoCreate*` for it, so this does so immediately, with the NEW amount.
   * If the row was instead reverted to PENDING/PENDING_PAYMENT as part of
   * a cascade, this is a no-op — the natural re-confirmation flow
   * (`settleByCompany` et al.) reaches PAID again on its own, and the
   * now-null `invoiceDocumentId` lets its EXISTING trigger regenerate.
   *
   * security-review round 2 (PR #600, MED-7): this method is `public` and,
   * unlike every OTHER `autoCreate*` trigger site (all funnelled through
   * `TransactionsService.safeAutoCreateInvoice`'s `try/catch`), called
   * `autoCreateFor*` directly — an S3/PDF failure here would surface as a
   * bare 500 on the amount-edit endpoint, AFTER the new amount was already
   * committed. Swallow-and-log, same as every sibling trigger site. Also
   * guards `payoutRequestId` explicitly: a SENIOR_INCOME/DROP_INCOME row
   * LINKED to a payout must never get a second, per-row invoice stacked on
   * top of the aggregated PAYOUT invoice that already anchors on the
   * PAYOUT row itself (see MED-6's note on why that invariant today rests
   * on `TransactionsService.adminUpdateTransaction`'s guards, not on this
   * method's own structure) — today's only caller never reaches this case
   * per the doc comment above (PAYOUT-family rows are structurally
   * unreachable), but a future direct call on a linked income must not
   * silently create a duplicate.
   */
  async reissueInvoiceIfStillPaid(transactionId: string): Promise<void> {
    const [tx] = await this.db.db
      .select()
      .from(nonDeletedTransactions)
      .where(eq(nonDeletedTransactions.id, transactionId))
      .limit(1)
    if (!tx || tx.status !== 'PAID') return
    if (tx.payoutRequestId) return
    try {
      if (tx.type === 'SALARY') {
        await this.triggers.autoCreateForSalary(tx.id)
      } else if (tx.type === 'SENIOR_INCOME') {
        await this.triggers.autoCreateForSeniorPayout(tx.id)
      }
      // PAYOUT: unreachable — amount edits on PAYOUT-family rows are
      // blocked structurally (see doc comment above). No branch needed;
      // falling through is a defensive no-op, not a silent gap.
    } catch (err) {
      this.logger.warn(
        `reissueInvoiceIfStillPaid: auto-create failed for tx=${tx.id}: ${(err as Error).message}`,
      )
    }
  }

  /**
   * Convenience wrapper — the single call task-3's amount-edit path is
   * expected to make. Kept separate from the two methods above (rather
   * than inlined) so AC4's test can exercise "void only" and "void +
   * reissue" independently.
   */
  async voidAndReissueInvoiceForAmountEdit(
    transactionId: string,
    actorId: string,
  ): Promise<InvoiceReissueOutcome> {
    // task-paid-salary-amount-edit (SR-M-1). The two failure modes used to be
    // log lines only; they are now an OUTCOME the caller journals and reports.
    let hadInvoice: boolean
    try {
      ;({ hadInvoice } = await this.voidInvoiceForAmountEdit(transactionId, actorId))
    } catch (err) {
      this.logger.error(
        `voidAndReissueInvoiceForAmountEdit: void failed for tx=${transactionId}: ${(err as Error).message}`,
      )
      return 'VOID_FAILED'
    }
    // A salary whose invoice was voided by an EARLIER edit whose re-issue then
    // failed has `hadInvoice: false` now — and used to be skipped forever.
    if (!hadInvoice && !(await this.isSalaryAwaitingReissue(transactionId))) return 'NOT_NEEDED'
    return this.reissueAndVerify(transactionId)
  }

  /**
   * task-paid-salary-amount-edit (SR-M-1, «повторное сохранение чинит»). For
   * a save that did NOT change the amount: if this is a PAID salary whose
   * invoice was voided and never replaced, re-issue it now. Nothing else can:
   * `paySalary` never runs on a PAID row again, and there is no «regenerate»
   * endpoint. A salary that never had an invoice (imported history) is left
   * alone on purpose — generating one on a notes edit would send a signing
   * request nobody expected.
   */
  /**
   * COPY-M-6 — may a re-save actually fix this row's invoice? The dialog picks
   * between «save it again» and «needs a manual check» from this, so the text
   * never promises a remedy that will answer `NOT_NEEDED`.
   */
  async canRepairSalaryInvoice(transactionId: string): Promise<boolean> {
    const state = await this.loadReissueState(transactionId)
    if (!isRepairableSalary(state)) return false
    return awaitsVoidRetry(state) || awaitsReissue(state)
  }

  async reissueSalaryInvoiceIfVoided(
    transactionId: string,
    actorId: string,
  ): Promise<InvoiceReissueOutcome> {
    const state = await this.loadReissueState(transactionId)
    if (!isRepairableSalary(state)) return 'NOT_NEEDED'
    // SR-M-3 (security-review round 2) — the VOID stage. A failed void left
    // the OLD, counterparty-signed invoice current: the public QR check keeps
    // confirming the old figure while `transactions.amount` already holds the
    // new one. `awaitsReissue` below could not see that (it needs the document
    // GONE), so the toast's «збережіть ще раз» was advice nobody could follow.
    // Retry the whole thing — void, then re-issue.
    if (awaitsVoidRetry(state)) {
      return this.voidAndReissueInvoiceForAmountEdit(transactionId, actorId)
    }
    if (!awaitsReissue(state)) return 'NOT_NEEDED'
    return this.reissueAndVerify(transactionId)
  }

  /** Re-issue, then read back whether a document actually landed on the row. */
  private async reissueAndVerify(transactionId: string): Promise<InvoiceReissueOutcome> {
    await this.reissueInvoiceIfStillPaid(transactionId)
    const state = await this.loadReissueState(transactionId)
    // Not PAID any more (a cascade reverted it) or linked to a payout: nothing
    // was supposed to be issued here, so there is nothing missing.
    if (!state || state.status !== 'PAID' || state.payoutRequestId) return 'NOT_NEEDED'
    return state.invoiceDocumentId ? 'REISSUED' : 'REISSUE_FAILED'
  }

  /** PAID `SALARY`, no current invoice, but one existed and was voided. */
  private async isSalaryAwaitingReissue(transactionId: string): Promise<boolean> {
    const state = await this.loadReissueState(transactionId)
    return isRepairableSalary(state) && awaitsReissue(state)
  }

  async loadReissueState(transactionId: string): Promise<ReissueState | null> {
    const [tx] = await this.db.db
      .select(REISSUE_STATE_COLUMNS)
      .from(nonDeletedTransactions)
      .where(eq(nonDeletedTransactions.id, transactionId))
      .limit(1)
    if (!tx) return null
    // Every issued invoice carries a COMPANY signature (`autoCreate`), and a
    // void stamps `voided_at` on it — so a voided signature is the durable
    // record that an invoice existed and was taken away.
    const [voided] = await this.db.db
      .select(VOIDED_SIGNATURE_COLUMNS)
      .from(invoiceSignatures)
      .where(
        and(
          eq(invoiceSignatures.transactionId, transactionId),
          isNotNull(invoiceSignatures.voidedAt),
        ),
      )
      .limit(1)
    // SR-M-4 — the figure `/verify` confirms. `amount_snapshot` is written by
    // `signInvoice` at the moment the counterparty clicks, and a void stamps
    // `voided_at` on that row; so an ACTIVE countersignature is, by
    // construction, the one the current document stands on.
    const [countersignature] = await this.db.db
      .select(COUNTERSIGNATURE_AMOUNT_COLUMNS)
      .from(invoiceSignatures)
      .where(
        and(
          eq(invoiceSignatures.transactionId, transactionId),
          eq(invoiceSignatures.signerRole, 'COUNTERPARTY'),
          isNull(invoiceSignatures.voidedAt),
        ),
      )
      .orderBy(desc(invoiceSignatures.signedAt))
      .limit(1)
    // SR-M-6 — witness 2. `autoCreate` gives every issued invoice a COMPANY
    // signature, and a void stamps `voided_at` on it, so an ACTIVE one dates
    // the document that is live right now.
    const [activeCompanySig] = await this.db.db
      .select(ACTIVE_COMPANY_SIGNATURE_COLUMNS)
      .from(invoiceSignatures)
      .where(
        and(
          eq(invoiceSignatures.transactionId, transactionId),
          eq(invoiceSignatures.signerRole, 'COMPANY'),
          isNull(invoiceSignatures.voidedAt),
        ),
      )
      .orderBy(desc(invoiceSignatures.signedAt))
      .limit(1)
    const [lastVoidFailure] = await this.db.db
      .select(VOID_FAILURE_COLUMNS)
      .from(transactionAuditLog)
      .where(
        and(
          eq(transactionAuditLog.targetId, transactionId),
          eq(transactionAuditLog.action, 'INVOICE_REISSUE_FAILED'),
          sql`${transactionAuditLog.metadata} ->> 'stage' = 'VOID'`,
        ),
      )
      .orderBy(desc(transactionAuditLog.createdAt))
      .limit(1)
    return {
      ...tx,
      hasVoidedInvoice: !!voided,
      signedAmountSnapshot: countersignature?.amountSnapshot ?? null,
      activeCompanySignedAt: activeCompanySig?.signedAt ?? null,
      lastVoidFailureAt: lastVoidFailure?.createdAt ?? null,
    }
  }
}
