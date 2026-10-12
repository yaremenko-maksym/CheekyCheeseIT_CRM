/**
 * InvoicesService — Round 3 of the Invoice Signing Epic.
 *
 * Business model (see docs/specs/pm-brief-invoice-signing.md):
 *
 *   1. Two transaction flows trigger invoice generation:
 *      a. SENIOR_INCOME — when the SENIOR pays out the 74% share (existing
 *         `payPayoutRequest` endpoint, which moves linked SENIOR_INCOME rows
 *         to PAID).
 *      b. SALARY — the instant the row enters status=PAID (either at
 *         `createSalary` creation time for the manual-pay flow, or via
 *         `paySalary` for the cron-created PENDING rows).
 *
 *   2. At trigger time we:
 *      - Render a signable PDF with the COMPANY auto-signature (and the
 *        "Ожидает подписи" placeholder for the counterparty).
 *      - Upload via DocumentsService.uploadInternal (category=INVOICE,
 *        owner=counterparty, bypasses RBAC + MIME checks).
 *      - Link the new document to the transaction via FK
 *        `transactions.invoice_document_id`.
 *      - Insert one COMPANY signature row (`AUTO_COMPANY`) with the PDF hash.
 *      - Emit a `INVOICE_SIGN_REQUIRED` notification for the counterparty.
 *      Idempotent: a second trigger with the same tx is a no-op.
 *
 *   3. When the counterparty clicks "Подписать":
 *      - Re-download the current PDF, compute SHA-256, compare with the
 *        COMPANY signature's stored hash — if they differ, refuse with 409
 *        (someone replaced the document between gen and sign).
 *      - Insert a COUNTERPARTY signature row (`MANUAL_CLICK`) with the new
 *        IP / user-agent / hash.
 *      - Re-render the PDF with BOTH signatures + upload it as a fresh
 *        Document. Soft-delete the previous one (audit trail), repoint the
 *        FK. Notify ADMIN that the invoice is signed.
 *
 *   4. Public `/verify/:transactionId` endpoint (no auth) returns the same
 *      data minus private fields (ip / user_agent / full hash) — used by the
 *      QR code on the printed PDF.
 *
 * RBAC summary:
 *   - List / get: ADMIN + ACCOUNTANT see everything; others see only their
 *     own (counterparty).
 *   - Sign: only the counterparty can sign. Verified against the type-derived
 *     counterparty rule (SENIOR for SENIOR_INCOME, receiver for SALARY).
 *   - Auto-create: never user-facing (called by TransactionsService trigger).
 *   - Verify: no auth at all.
 */
import { HttpStatus, Injectable, Logger, forwardRef, Inject, Optional } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import type {
  ContractTargetRole,
  InvoiceDto,
  InvoiceListFilters,
  InvoiceListItem,
  InvoiceVerifyResponse,
  SessionUser,
} from '@crm/shared'
// task-i18n-stage4-task6: `NOTIFICATION_TITLES[type]` — the neutral, frozen
// legacy title `CreateNotificationInput.title` still requires (NOT NULL
// column) — no longer a per-call hand-written Russian string.
import { amountsDiffer, NOTIFICATION_TITLES } from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import {
  contractTemplates,
  invoiceSignatures,
  // security-review PR #456 round 2: `nonDeletedTransactions` (VIEW) covers
  // every LIST/aggregate read in this file (listInvoices, the internal
  // auto-create triggers, the linked-income lookups) — see schema.ts's doc
  // on the view. The raw `transactions` table stays imported ONLY for the
  // few single-row reads that need the ADMIN/ACCOUNTANT-sees-deleted-row
  // exception (getInvoice / signInvoice / verifyInvoice) and for writes —
  // each of those routes through `assertFoundAndVisible` /
  // `fetchVisibleTransactionOrThrow` / `fetchWritableTransactionOrThrow` so
  // fetch and guard are fused into one expression (round 2's fix for the
  // demonstrated "delete just the guard" bypass).
  nonDeletedTransactions,
  projects,
  signedContracts,
  transactionAuditLog,
  transactions,
  users,
  type Transaction,
} from '../database/schema'
import type { Env } from '../config/env'
import { DocumentsService } from '../documents/documents.service'
import { S3Service } from '../documents/s3.service'
import { NotificationsService } from '../notifications/notifications.service'
import { fetchWritableTransactionOrThrow } from '../finance/transaction-visibility.util'
import {
  InvoicePdfService,
  type InvoiceSignatureInfo,
  type InvoiceTransactionInfo,
} from './invoice-pdf.service'
import { sha256Hex } from '../common/pdf/pdf.utils'
import { extractIp, extractUserAgent, lastOctet } from './invoice-request.util'
import { buildCounterpartyInfo, getCounterpartyId } from './invoice-counterparty.util'
import { InvoiceQueryService } from './invoice-query.service'
import { InvoiceCreationService } from './invoice-creation.service'
import { InvoiceVerifyService } from './invoice-verify.service'
import { COMPANY_INFO } from './invoice-company-info.const'
import { buildVerifyUrl, type SignatureWithSignerName } from './invoice-dto.util'

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
interface ReissueState {
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

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name)

  // First ADMIN cached on first lookup. The pool is fixed (seed-only), so a
  // single in-memory entry is fine — no LRU needed. Invalidation: never, as
  // the spec says first-ADMIN-by-created_at is the only valid signer.
  private cachedAdminId: string | null = null

  private readonly queryService: InvoiceQueryService
  private readonly invoiceVerify: InvoiceVerifyService
  private readonly creationService: InvoiceCreationService

  constructor(
    private readonly db: DatabaseService,
    private readonly pdfService: InvoicePdfService,
    @Inject(forwardRef(() => DocumentsService))
    private readonly documentsService: DocumentsService,
    private readonly s3: S3Service,
    private readonly notificationsService: NotificationsService,
    private readonly config: ConfigService<Env, true>,
    @Optional() queryService?: InvoiceQueryService,
    @Optional() invoiceVerify?: InvoiceVerifyService,
  ) {
    // Built in the ctor BODY (not a param default): stub-constructed specs
    // bypass param defaults. Positional spec factories pass 6 args.
    this.queryService = queryService ?? new InvoiceQueryService(db)
    // L4: public verify + PAYOUT aggregate resolver live in InvoiceVerifyService.
    this.invoiceVerify = invoiceVerify ?? new InvoiceVerifyService(db, this.queryService)
    // L5: auto-create triggers live in InvoiceCreationService. Late-bound callbacks keep the
    // shared helpers (admin cache, aggregate amount, contract number, verify URL) single-copy
    // on this facade, so spies on them still intercept the trigger paths.
    this.creationService = new InvoiceCreationService(
      db,
      pdfService,
      documentsService,
      notificationsService,
      {
        getAdminId: () => this.getAdminId(),
        resolvePayoutAggregateAmount: (id) => this.resolvePayoutAggregateAmount(id),
        lookupContractNumber: (userId, role) => this.lookupContractNumber(userId, role),
        buildVerifyUrl: (id) => this.buildVerifyUrl(id),
      },
    )
  }

  // ===========================================================================
  // Auto-create (triggered from TransactionsService) — delegates to InvoiceCreationService
  // ===========================================================================

  /** SENIOR_INCOME → invoice (legacy per-row trigger). See InvoiceCreationService. */
  autoCreateForSeniorPayout(transactionId: string): Promise<void> {
    return this.creationService.autoCreateForSeniorPayout(transactionId)
  }

  /** PAYOUT → one aggregated invoice. See InvoiceCreationService. */
  autoCreateForPayout(payoutTxId: string): Promise<void> {
    return this.creationService.autoCreateForPayout(payoutTxId)
  }

  /** SALARY (PAID) → invoice. See InvoiceCreationService. */
  autoCreateForSalary(transactionId: string): Promise<void> {
    return this.creationService.autoCreateForSalary(transactionId)
  }

  /**
   * Lookup the most recent signed contract number for a given user + role.
   * Joins signed_contracts → contract_templates to filter by targetRole.
   * Returns null when the user has not signed a contract yet.
   */
  private async lookupContractNumber(
    userId: string,
    userRole: ContractTargetRole,
  ): Promise<string | null> {
    const rows = await this.db.db
      .select({ contractNumber: signedContracts.contractNumber })
      .from(signedContracts)
      .innerJoin(contractTemplates, eq(signedContracts.templateId, contractTemplates.id))
      .where(and(eq(signedContracts.userId, userId), eq(contractTemplates.targetRole, userRole)))
      .orderBy(desc(signedContracts.signedAt))
      .limit(1)
    return rows[0]?.contractNumber ?? null
  }

  // ===========================================================================
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
        await this.autoCreateForSalary(tx.id)
      } else if (tx.type === 'SENIOR_INCOME') {
        await this.autoCreateForSeniorPayout(tx.id)
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

  private async loadReissueState(transactionId: string): Promise<ReissueState | null> {
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
          // Stryker disable next-line StringLiteral: a Postgres query VALUE (which signer_role), not a shape — a unit double answers with canned rows whatever is asked, so only a live DB can tell them apart; proven by paid-salary-amount-edit.integration.spec.ts «reads the ACTIVE COUNTERPARTY snapshot…», which inserts a COMPANY row alongside and asserts the COMPANY figure is NOT the one returned (mutation-gate-integration-specs.md)
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
          // Stryker disable next-line StringLiteral: a Postgres query VALUE (which signer_role), not a shape — proven against real rows by paid-salary-amount-edit.integration.spec.ts «dates the ACTIVE COMPANY signature», which puts a COUNTERPARTY row with a different timestamp beside it (mutation-gate-integration-specs.md)
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
          // Stryker disable next-line StringLiteral: a Postgres query VALUE (which action), not a shape — proven by the real-DB test «ignores a line of another action», which records a `stage: VOID` metadata under a DIFFERENT action and asserts nothing comes back (mutation-gate-integration-specs.md)
          eq(transactionAuditLog.action, 'INVOICE_REISSUE_FAILED'),
          // Stryker disable next-line StringLiteral: likewise a query VALUE (which stage) — proven by «ignores the REISSUE stage», which records that stage and asserts nothing comes back
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

  // ===========================================================================
  // List
  // ===========================================================================

  async listInvoices(viewer: SessionUser, filters: InvoiceListFilters): Promise<InvoiceListItem[]> {
    return this.queryService.listInvoices(viewer, filters)
  }

  // ===========================================================================
  // Get one
  // ===========================================================================

  async getInvoice(viewer: SessionUser, transactionId: string): Promise<InvoiceDto> {
    return this.queryService.getInvoice(viewer, transactionId)
  }

  // ===========================================================================
  // Sign (counterparty)
  // ===========================================================================

  async signInvoice(
    viewer: SessionUser,
    transactionId: string,
    req: FastifyRequest,
  ): Promise<InvoiceDto> {
    // Fix-раунд 3 (task-680, SR-M-4). Checked FIRST, before the transaction
    // fetch or any write, so an impersonated sign attempt leaves zero trace
    // — mirrors the identical guard closed for contract signing
    // (`SignedContractsService.sign`, SR-M-2) and ToS acceptance
    // (`TosService.accept`, SR-M-3). `viewer` is the whole `SessionUser`
    // already (no field-by-field reconstruction like the contracts
    // controller needed) — `impersonatorId` cannot be dropped in transit.
    if (viewer.impersonatorId) {
      throw apiError('INVOICE_SIGN_IMPERSONATION', HttpStatus.FORBIDDEN)
    }

    // security-review PR #456 round 2: fetch + write-guard fused into one
    // call (see the `getInvoice` comment above for why this specific pattern
    // exists — round 2 defeated the round-1 two-statement version). A
    // deleted transaction's invoice used to be fully signable by its
    // (non-privileged) counterparty; non-privileged + deleted → 404 (hides
    // existence); privileged + deleted → 400 (blocks the sign).
    const tx = await fetchWritableTransactionOrThrow(this.db.db, transactionId, viewer)
    // task-aggregate-invoice-per-payout: PAYOUT rows now sign too.
    if (tx.type !== 'SENIOR_INCOME' && tx.type !== 'SALARY' && tx.type !== 'PAYOUT') {
      throw apiError('INVOICE_NOT_APPLICABLE_FOR_TX_TYPE', HttpStatus.NOT_FOUND)
    }
    if (!tx.invoiceDocumentId) {
      throw apiError('INVOICE_NOT_GENERATED_YET', HttpStatus.CONFLICT)
    }

    // ---- RBAC: viewer must be the counterparty ----
    if (getCounterpartyId(tx) !== viewer.id) {
      throw apiError('INVOICE_NOT_COUNTERPARTY', HttpStatus.FORBIDDEN)
    }

    // ---- Conflict: already signed ----
    // task-invoice-signature-integrity: scoped to ACTIVE (voidedAt IS NULL)
    // rows only. A transaction that went through void → reissue (AC2) can
    // carry a HISTORICAL COUNTERPARTY row from a prior, now-voided invoice
    // — that must not block signing the current, freshly-issued one.
    const existing = await this.db.db
      .select()
      .from(invoiceSignatures)
      .where(
        and(
          eq(invoiceSignatures.transactionId, tx.id),
          eq(invoiceSignatures.signerRole, 'COUNTERPARTY'),
          isNull(invoiceSignatures.voidedAt),
        ),
      )
      .limit(1)
    if (existing.length > 0) {
      throw apiError('INVOICE_ALREADY_SIGNED', HttpStatus.CONFLICT)
    }

    // ---- Re-fetch the COMPANY signature to verify hash equality ----
    // Same ACTIVE-only scoping as above — the COMPANY row this compares
    // against must be the one attesting to the CURRENT document.
    const companySig = await this.db.db
      .select()
      .from(invoiceSignatures)
      .where(
        and(
          eq(invoiceSignatures.transactionId, tx.id),
          eq(invoiceSignatures.signerRole, 'COMPANY'),
          isNull(invoiceSignatures.voidedAt),
        ),
      )
      .limit(1)
    if (companySig.length === 0) {
      throw apiError('INVOICE_COMPANY_SIGNATURE_MISSING', HttpStatus.CONFLICT)
    }

    // ---- Download current PDF, compute fresh hash, compare ----
    const doc = await this.documentsService.findByIdInternal(tx.invoiceDocumentId)
    if (!doc) throw apiError('INVOICE_DOCUMENT_NOT_FOUND', HttpStatus.CONFLICT)

    const pdfBuffer = await this.s3.getObject(doc.s3Key)
    const currentHash = sha256Hex(pdfBuffer)
    if (companySig[0]!.pdfHash !== currentHash) {
      throw apiError('INVOICE_PDF_MODIFIED_AFTER_SIGNATURE', HttpStatus.CONFLICT)
    }

    // ---- Fetch admin + counterparty rows ----
    // security-review round 2 (PR #600, MED-3): this fetch, the PAYOUT/
    // SENIOR_INCOME aggregation block below, and the txInfo construction all
    // used to run AFTER the COUNTERPARTY row was inserted — they now run
    // BEFORE it, so the resolved amount/currency can be written in the SAME
    // insert as amountSnapshot/currencySnapshot instead of a follow-up
    // UPDATE several queries later. That follow-up UPDATE was the exact gap
    // HIGH-1 found: any failure between the two round-trips left an ACTIVE
    // signature with a NULL snapshot, falling into the same live-amount
    // leak the migration's backfill exists to close for legacy rows — now
    // structurally impossible for newly-signed rows, not just backfilled
    // once.
    const adminId = await this.getAdminId()
    const adminRow = await this.db.db.query.users.findFirst({
      where: eq(users.id, adminId),
    })
    const counterpartyRow = await this.db.db.query.users.findFirst({
      where: eq(users.id, viewer.id),
    })
    if (!adminRow || !counterpartyRow) {
      throw apiError('INVOICE_USER_DATA_FETCH_FAILED', HttpStatus.CONFLICT)
    }
    const counterpartyInfo = buildCounterpartyInfo(counterpartyRow)

    // task-aggregate-invoice-per-payout. For PAYOUT rows we re-resolve the
    // aggregated description (contract number + project list) on every sign
    // so the re-rendered PDF matches what the COMPANY originally signed
    // byte-for-byte (which is what the hash-equality check above already
    // verified). For SENIOR_INCOME / SALARY we keep the legacy
    // project-name-per-row path.
    let projectName: string | null = null
    let projectNames: string[] | null = null
    let contractNumber: string | null = null
    // security-review round 5 (PR #600, HIGH-4): NEVER `?? tx.amount`. That
    // fallback used to be exactly what silently substituted a different
    // number into `amountSnapshot` than the one the PDF actually prints for
    // PAYOUT rows (the USDT payable vs. the aggregated linked-income sum,
    // BIZ-05) — the write-time twin of HIGH-3's read-time bug. For
    // `tx.type === 'PAYOUT'` the branch below either populates this or the
    // function has already thrown; there is no path that reaches `txInfo`
    // construction with it still null for a PAYOUT row.
    let payoutAmount: { amount: string; currency: Transaction['currency'] } | null = null
    if (tx.type === 'PAYOUT') {
      // A PAYOUT row without a payoutRequestId cannot be resolved at all —
      // refuse rather than let a bad/undefined amount reach the snapshot.
      if (!tx.payoutRequestId) {
        this.logger.error(
          `signInvoice: tx=${tx.id} type=PAYOUT has no payoutRequestId — cannot resolve a signable amount, refusing to sign`,
        )
        throw apiError('INVOICE_AMOUNT_VERIFICATION_FAILED', HttpStatus.CONFLICT)
      }
      // security-review PR #456 round 2: sourced from `nonDeletedTransactions`
      // (VIEW) — defensive-only (see autoCreateForPayout's identical filter),
      // but now structural rather than a condition to remember.
      const linkedIncomes = await this.db.db
        .select()
        .from(nonDeletedTransactions)
        .where(
          and(
            eq(nonDeletedTransactions.payoutRequestId, tx.payoutRequestId),
            inArray(nonDeletedTransactions.type, ['SENIOR_INCOME', 'DROP_INCOME']),
          ),
        )
      const names: string[] = []
      const seen = new Set<string>()
      for (const incomeRow of linkedIncomes) {
        if (!incomeRow.projectId || seen.has(incomeRow.projectId)) continue
        seen.add(incomeRow.projectId)
        const project = await this.db.db.query.projects.findFirst({
          where: eq(projects.id, incomeRow.projectId),
        })
        if (project) names.push(project.name)
      }
      projectNames = names
      contractNumber =
        counterpartyRow.role === 'ADMIN'
          ? null
          : await this.lookupContractNumber(counterpartyRow.id, counterpartyRow.role)
      // security-review round 4 (PR #600, HIGH-3) / round 5 (PR #600,
      // HIGH-4): amount/currency resolution goes through
      // `resolvePayoutAggregateAmount` — the SAME helper `verifyInvoice`
      // calls to recompute this when a legacy row has no snapshot, and
      // `autoCreateForPayout` calls to print the initial COMPANY-only PDF.
      // Re-queries the linked incomes a second time (the `linkedIncomes`
      // fetched above stays — it also drives the project-name/
      // contract-number resolution this helper doesn't need) — a tolerated
      // N+1 in this file already (see `autoCreateForPayout`'s own comment
      // on the same trade-off). The helper now COUNTS mixed currencies
      // instead of refusing (see its doc comment) — `null` here means
      // genuinely nothing to sign (no linked incomes), and this branch
      // refuses rather than fall back to a number nobody signed.
      const resolved = await this.resolvePayoutAggregateAmount(tx.payoutRequestId)
      if (!resolved) {
        this.logger.error(
          `signInvoice: tx=${tx.id} type=PAYOUT req=${tx.payoutRequestId} — aggregate amount could not be resolved (no linked incomes) — refusing to sign`,
        )
        throw apiError('INVOICE_AMOUNT_VERIFICATION_FAILED', HttpStatus.CONFLICT)
      }
      payoutAmount = resolved
    } else if (tx.type === 'SENIOR_INCOME' && tx.projectId) {
      const project = await this.db.db.query.projects.findFirst({
        where: eq(projects.id, tx.projectId),
      })
      if (project) projectName = project.name
    }

    const txInfo: InvoiceTransactionInfo = {
      id: tx.id,
      // PAYOUT rows render with the SENIOR_INCOME template (АКТ ВЫПОЛНЕННЫХ
      // РАБОТ) — same legal document, just aggregated content.
      type: (tx.type === 'PAYOUT' ? 'SENIOR_INCOME' : tx.type) as 'SENIOR_INCOME' | 'SALARY',
      // security-review round 5 (PR #600, HIGH-4): `payoutAmount!` — see
      // the field's own comment above for why this is safe: for a PAYOUT
      // row, the branch above either populated it or already threw.
      amount: tx.type === 'PAYOUT' ? payoutAmount!.amount : tx.amount,
      currency: tx.type === 'PAYOUT' ? payoutAmount!.currency : tx.currency,
      projectName,
      projectNames,
      contractNumber,
      salaryMonth: tx.salaryMonth ?? null,
      txDate: tx.txDate ?? tx.createdAt,
    }

    // ---- Insert COUNTERPARTY signature ----
    // AC3 + security-review round 2 (PR #600, MED-3): amountSnapshot /
    // currencySnapshot are frozen HERE, in the same INSERT, from `txInfo` —
    // what the FINAL re-rendered PDF actually contains — never recomputed
    // on read. This is what the public /verify endpoint reads instead of
    // the live tx.amount, so a LATER amount edit (or any write that
    // bypasses the AC2 void path) can never surface as "confirmed" by a
    // signature that never attested to it. Previously this was a separate
    // UPDATE issued several queries after the insert — see the comment
    // above the admin/counterparty fetch for why that window was closed.
    //
    // security-review round 2 (PR #600, MED-1): the insert now runs inside
    // its OWN `db.transaction`, opened with a `SELECT … FOR UPDATE` on the
    // transaction row — the SAME row `voidInvoiceForAmountEdit` locks for
    // the duration of ITS writes. This serialises the two calls: if a
    // void→reissue is concurrently in flight, this either waits for it to
    // commit and then observes `invoiceDocumentId` has already moved off
    // the document this call started from (→ 409, nothing inserted), or it
    // runs first and the void simply retires this fresh signature like any
    // other post-sign edit. Without this lock, a void→reissue landing here
    // used to let an ACTIVE COUNTERPARTY row survive for a document that
    // had already been superseded — `getSignaturesWithSignerNames` /
    // `getInvoice` would then report the FRESH reissue as "SIGNED" even
    // though nobody signed it, attesting to bytes nobody downloaded.
    const signedAt = new Date()
    const ip = extractIp(req)
    const userAgent = extractUserAgent(req)
    await this.db.db.transaction(async (dbtx) => {
      // The row-lock mode for the SELECT below — extracted to a named,
      // `as const`-asserted constant rather than inlined into the
      // `.for(...)` chain call. Empirically (not just stylistically)
      // deliberate: a bare string literal inlined into a `.method()` chain
      // continuation on its own line generates a StringLiteral mutant this
      // repo's Stryker version does not reliably attach a `next-line`
      // suppression comment to (unlike a comma-separated argument position,
      // e.g. the `inArray(...)` suppression a few hundred lines up, which
      // DOES attach correctly) — no unit mock models row locking, so no
      // assertion could kill that mutant either; only the integration spec
      // (real Postgres) can observe a wrong lock-mode string. `as const`
      // sidesteps the whole problem: Stryker does not mutate a literal in a
      // const-asserted position at all, so there is no unkillable mutant
      // left needing a suppression comment in the first place.
      const LOCK_MODE_UPDATE = 'update' as const
      const [locked] = await dbtx
        .select({ invoiceDocumentId: transactions.invoiceDocumentId })
        .from(transactions)
        .where(eq(transactions.id, tx.id))
        .for(LOCK_MODE_UPDATE)
        .limit(1)
      if (!locked || locked.invoiceDocumentId !== doc.id) {
        throw apiError('INVOICE_VOIDED', HttpStatus.CONFLICT)
      }
      await dbtx.insert(invoiceSignatures).values({
        transactionId: tx.id,
        signerRole: 'COUNTERPARTY',
        signerId: viewer.id,
        pdfHash: currentHash,
        method: 'MANUAL_CLICK',
        ipAddress: ip,
        userAgent,
        signedAt,
        amountSnapshot: txInfo.amount,
        currencySnapshot: txInfo.currency,
      })
    })

    // ---- Re-render PDF with both signatures ----
    const allSigs = await this.getSignaturesWithSignerNames(tx.id)

    const sigBlocks: InvoiceSignatureInfo[] = allSigs.map((s) => ({
      role: s.signerRole,
      signerName: s.signerName,
      signedAt: s.signedAt,
      method: s.method,
      // The tamper-detection throw above (`companySig[0].pdfHash !==
      // currentHash`) already made these equal by the time this line can
      // run — both ternary branches are FORCED to the identical value in
      // every reachable state, so no test can distinguish either branch of
      // this ternary from the other, or from a forced-true/false condition.
      // Stryker disable next-line ConditionalExpression,EqualityOperator,StringLiteral: both ternary branches are provably equal here — the tamper-detection throw above already enforces companySig[0].pdfHash === currentHash before this line runs.
      pdfHashFull: s.signerRole === 'COMPANY' ? companySig[0]!.pdfHash : currentHash,
      ipLastOctet: s.signerRole === 'COUNTERPARTY' && ip ? lastOctet(ip) : null,
    }))

    const { pdfBuffer: newPdf } = await this.pdfService.generateSignableInvoicePdf({
      transaction: txInfo,
      company: COMPANY_INFO,
      counterparty: counterpartyInfo,
      signatures: sigBlocks,
      verifyUrl: this.buildVerifyUrl(tx.id),
    })

    // ---- Upload new doc, soft-delete old, repoint FK ----
    const newDoc = await this.documentsService.uploadInternal({
      category: 'INVOICE',
      ownerId: counterpartyRow.id,
      file: newPdf,
      mimeType: 'application/pdf',
      name: `invoice-${tx.id.slice(0, 8)}-signed.pdf`,
      uploadedById: adminId,
    })
    await this.documentsService.softDeleteInternal(doc.id, adminId)
    // security-review round 2 (PR #600, MED-1): the repoint is CONDITIONAL
    // on invoiceDocumentId still being the document this call started from.
    // `signInvoice` and `voidInvoiceForAmountEdit` take no shared lock (the
    // S3 render/upload above would hold one far too long), so a concurrent
    // void→reissue landing in this window used to let this UPDATE silently
    // repoint onto a stale document — clobbering a fresh reissue, or (if
    // void landed between the insert above and here) leaving the
    // transaction permanently invoice-less, since autoCreate*'s idempotency
    // guard blocks on ANY non-null invoiceDocumentId, signed or not. Failing
    // loud instead: the caller is told to reload rather than silently
    // trusting a write that raced a void.
    // Only `repointed.length` is read below — which column(s)
    // `.returning(...)` projects does not change how many rows a matching
    // UPDATE returns, in Postgres or in this mock, so `{id:
    // transactions.id}` vs `{}` cannot be told apart by anything this file
    // could assert. Extracted to a named constant (not inlined into the
    // `.returning(...)` chain call) for the same reason as
    // `LOCK_MODE_UPDATE` above — a bare `.method()` chain continuation.
    // Stryker disable next-line ObjectLiteral: only repointed.length is read below; which columns are projected cannot change how many rows a matching UPDATE returns.
    const REPOINT_RETURNING = { id: transactions.id }
    const repointed = await this.db.db
      .update(transactions)
      .set({ invoiceDocumentId: newDoc.id, updatedAt: new Date() })
      .where(and(eq(transactions.id, tx.id), eq(transactions.invoiceDocumentId, doc.id)))
      .returning(REPOINT_RETURNING)
    if (repointed.length === 0) {
      throw apiError('INVOICE_VOIDED', HttpStatus.CONFLICT)
    }

    // ---- Notify ADMIN ----
    // task-i18n-stage4-task6, Step 5: counterparty name moves into `data`
    // (§10 — the popup shows it once, via `describeNotification`; the
    // neutral title no longer interpolates it).
    //
    // COPY-M-4 (copy-review круг 1, PR #714): `...moneyFields` from `txInfo`
    // (the SAME amount/currency the re-rendered PDF and signature snapshot
    // use, just above) — without it the admin could not tell which invoice
    // of a multi-invoice counterparty had just been signed.
    await this.notificationsService.create({
      userId: adminId,
      type: 'INVOICE_SIGNED',
      title: NOTIFICATION_TITLES.INVOICE_SIGNED,
      data: {
        counterpartyName: counterpartyRow.displayName,
        amount: txInfo.amount,
        currency: txInfo.currency,
      },
      link: `/documents?category=INVOICE&openTx=${tx.id}`,
    })

    this.logger.log(
      `signInvoice: tx=${tx.id} signed by counterparty=${viewer.id} hash=${currentHash.slice(0, 8)}`,
    )

    return this.getInvoice(viewer, tx.id)
  }

  // ===========================================================================
  // Public verify (no auth)
  // ===========================================================================

  verifyInvoice(transactionId: string): Promise<InvoiceVerifyResponse> {
    return this.invoiceVerify.verifyInvoice(transactionId)
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /** Delegates to InvoiceVerifyService (L4 extraction); single implementation shared with InvoiceCreationService via the late-bound callback. */
  private resolvePayoutAggregateAmount(
    payoutRequestId: string | null,
  ): ReturnType<InvoiceVerifyService['resolvePayoutAggregateAmount']> {
    return this.invoiceVerify.resolvePayoutAggregateAmount(payoutRequestId)
  }

  /**
   * Resolve the system ADMIN that signs as COMPANY. Spec rule: first ADMIN by
   * `created_at ASC`. Cached in-memory because the ADMIN pool is fixed
   * (seed-only) — there is no admin creation flow that would invalidate the
   * cache. If for some reason the cache is stale, the worst case is signing
   * with a user that still exists but is no longer the "first" — which is a
   * cosmetic concern handled by the single-ADMIN deployment policy.
   */
  private async getAdminId(): Promise<string> {
    if (this.cachedAdminId) return this.cachedAdminId
    const admin = await this.db.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'ADMIN'))
      .orderBy(asc(users.createdAt))
      .limit(1)
    if (admin.length === 0) {
      throw new Error('No ADMIN user found — cannot auto-sign invoices')
    }
    this.cachedAdminId = admin[0]!.id
    return this.cachedAdminId
  }

  /** FRONTEND_URL + /invoice/v/:id — used as the QR code payload. */
  private buildVerifyUrl(transactionId: string): string {
    const frontendUrl = this.config.get('FRONTEND_URL', { infer: true })
    return buildVerifyUrl(frontendUrl, transactionId)
  }

  /** Delegates to InvoiceQueryService (L4 extraction); kept for signInvoice / verifyInvoice. */
  private getSignaturesWithSignerNames(transactionId: string): Promise<SignatureWithSignerName[]> {
    return this.queryService.getSignaturesWithSignerNames(transactionId)
  }
}
