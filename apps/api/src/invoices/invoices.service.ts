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
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
  Inject,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import {
  type ContractTargetRole,
  type InvoiceDto,
  type InvoiceListFilters,
  type InvoiceListItem,
  type InvoiceStatus,
  type InvoiceType,
  type InvoiceVerifyResponse,
  type SessionUser,
} from '@crm/shared'
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
  transactions,
  users,
  type Transaction,
} from '../database/schema'
import type { Env } from '../config/env'
import { DocumentsService } from '../documents/documents.service'
import { S3Service } from '../documents/s3.service'
import { NotificationsService } from '../notifications/notifications.service'
import {
  assertFoundAndVisible,
  fetchVisibleTransactionOrThrow,
  fetchWritableTransactionOrThrow,
} from '../finance/transaction-visibility.util'
import {
  InvoicePdfService,
  COMPANY_BRAND_NAME,
  type InvoiceCompanyInfo,
  type InvoiceCounterpartyInfo,
  type InvoiceSignatureInfo,
  type InvoiceTransactionInfo,
} from './invoice-pdf.service'
import { sha256Hex, shortHash } from './invoice-pdf.utils'

// ---------------------------------------------------------------------------
// Company info constants (TBD — currently hardcoded; future migration into
// `/admin/settings` epic will move these into the DB)
// ---------------------------------------------------------------------------

// task-drop-company-debt-and-invoices: brand name is centralised in
// invoice-pdf.service.ts (COMPANY_BRAND_NAME). The `name` field is no
// longer rendered on the PDF (the header uses the brand const directly),
// but the InvoiceCompanyInfo struct still requires it for backward compat.
const COMPANY_INFO: InvoiceCompanyInfo = {
  name: 'CheekyCheeseIT',
  address: 'Україна, м. Київ',
}

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name)

  // First ADMIN cached on first lookup. The pool is fixed (seed-only), so a
  // single in-memory entry is fine — no LRU needed. Invalidation: never, as
  // the spec says first-ADMIN-by-created_at is the only valid signer.
  private cachedAdminId: string | null = null

  constructor(
    private readonly db: DatabaseService,
    private readonly pdfService: InvoicePdfService,
    @Inject(forwardRef(() => DocumentsService))
    private readonly documentsService: DocumentsService,
    private readonly s3: S3Service,
    private readonly notificationsService: NotificationsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // ===========================================================================
  // Auto-create (triggered from TransactionsService)
  // ===========================================================================

  /**
   * Trigger 1: SENIOR_INCOME → invoice. Called from
   * `TransactionsService.payPayoutRequest` after the payout request flips to
   * PAID. The senior themselves is the counterparty (the invoice represents
   * the 74% they're paying back to the company).
   *
   * task-aggregate-invoice-per-payout: this trigger is kept for legacy /
   * settle-by-company callers (`PendingSettlementService.settleByCompany`)
   * that still create one invoice per SENIOR_INCOME row. The main payout
   * flow now uses `autoCreateForPayout` (one invoice per PAYOUT, aggregating
   * all linked income rows).
   */
  async autoCreateForSeniorPayout(transactionId: string): Promise<void> {
    // security-review PR #456 round 2: sourced from `nonDeletedTransactions`
    // (VIEW) — "row not found" now structurally covers "deleted" too, no
    // separate `if (tx.deletedAt) return` needed (there is nothing to forget:
    // a deleted row cannot be returned by this query at all).
    const [tx] = await this.db.db
      .select()
      .from(nonDeletedTransactions)
      .where(eq(nonDeletedTransactions.id, transactionId))
      .limit(1)
    if (!tx) return // tx gone (or soft-deleted) — nothing to do (defensive)
    if (tx.type !== 'SENIOR_INCOME') return
    await this.autoCreate(tx)
  }

  /**
   * task-aggregate-invoice-per-payout. Trigger 3: PAYOUT → invoice. Called
   * from `TransactionsService.payPayoutRequest` after the cascade flips the
   * PAYOUT row to PAID. Aggregates every SENIOR_INCOME / DROP_INCOME row that
   * shares the same `payoutRequestId` into a single invoice:
   *
   *   - Amount = sum of linked income amounts (defensive: also matches the
   *     PAYOUT row's own amount for the senior-keeps share, but we use the
   *     income sum so the invoice text aligns with what the SENIOR billed
   *     the company for).
   *   - Currency = first linked income's currency (mixed-currency is an
   *     unsupported edge case; PHASE 8 will rework when smart-contracts ship).
   *   - Description = «Услуги исполнителя согласно контракту № <N>» where
   *     `<N>` is the placeholder formula `CHK-<userId-prefix>-<year>` per
   *     spec AC3 Variant B (no migration).
   *   - Counterparty = receiver of the PAYOUT cascade. In senior-projects
   *     this is the senior themselves (= receiver of the income); in
   *     drop-projects this is the drop user (project.dropId). We resolve via
   *     the first linked income's `receiverId` which is the correct field for
   *     both flows.
   *
   * Idempotency anchor: `transactions.invoice_document_id` on the PAYOUT row
   * itself. Replaying the trigger (e.g. retry after S3 outage) is a no-op
   * once the doc is linked.
   */
  async autoCreateForPayout(payoutTxId: string): Promise<void> {
    // security-review PR #456 round 2: see autoCreateForSeniorPayout — sourced
    // from the view, "not found" covers "deleted" structurally.
    const [payoutTx] = await this.db.db
      .select()
      .from(nonDeletedTransactions)
      .where(eq(nonDeletedTransactions.id, payoutTxId))
      .limit(1)
    if (!payoutTx) return
    if (payoutTx.type !== 'PAYOUT') return
    if (!payoutTx.payoutRequestId) {
      this.logger.warn(`autoCreateForPayout: PAYOUT tx=${payoutTxId} has no payoutRequestId`)
      return
    }

    // Idempotency guard on the PAYOUT row.
    if (payoutTx.invoiceDocumentId) {
      this.logger.debug(`autoCreateForPayout: PAYOUT ${payoutTxId} already has invoice — skip`)
      return
    }

    // Fetch all linked income rows that contributed to this payout.
    // security-review PR #456 round 2: sourced from `nonDeletedTransactions`
    // (VIEW) — `adminDeleteTransaction` already refuses to delete any row
    // with `payoutRequestId` set, so this is defensive-only, but the view
    // means there is no filter to forget either way.
    const linkedIncomes = await this.db.db
      .select()
      .from(nonDeletedTransactions)
      .where(
        and(
          eq(nonDeletedTransactions.payoutRequestId, payoutTx.payoutRequestId),
          inArray(nonDeletedTransactions.type, ['SENIOR_INCOME', 'DROP_INCOME']),
        ),
      )
    if (linkedIncomes.length === 0) {
      this.logger.warn(
        `autoCreateForPayout: PAYOUT ${payoutTxId} has no linked SENIOR_INCOME/DROP_INCOME — skip`,
      )
      return
    }

    // Counterparty resolution: receiver of the income rows (drop owner or
    // senior). All linked incomes share the same receiver in practice — a
    // payout_request is per-senior (or per-drop in the drop flow). We pick
    // the first non-null receiver defensively.
    const firstWithReceiver = linkedIncomes.find((i) => i.receiverId)
    const counterpartyId = firstWithReceiver?.receiverId ?? null
    if (!counterpartyId) {
      this.logger.warn(
        `autoCreateForPayout: PAYOUT ${payoutTxId} — no receiver found on linked incomes`,
      )
      return
    }

    const counterpartyRow = await this.db.db.query.users.findFirst({
      where: eq(users.id, counterpartyId),
    })
    if (!counterpartyRow) {
      this.logger.warn(`autoCreateForPayout: counterparty ${counterpartyId} missing`)
      return
    }

    const adminId = await this.getAdminId()
    const adminRow = await this.db.db.query.users.findFirst({
      where: eq(users.id, adminId),
    })
    if (!adminRow) {
      this.logger.error(`autoCreateForPayout: ADMIN user ${adminId} not found`)
      return
    }

    // security-review round 5 (PR #600, HIGH-4): amount/currency now come
    // from `resolvePayoutAggregateAmount` — the SAME helper `signInvoice`
    // and `verifyInvoice` use. This used to be a THIRD, independently
    // maintained copy of the same arithmetic, with a comment asking future
    // edits to keep it "in sync" with signInvoice's copy by hand — exactly
    // the drift class round 5's finding is about. `linkedIncomes` (fetched
    // above) stays in scope below for project-name resolution, which this
    // helper does not need — a tolerated N+1, same trade-off already
    // documented on that fetch.
    const resolvedAmount = await this.resolvePayoutAggregateAmount(payoutTx.payoutRequestId)
    if (!resolvedAmount) {
      // Defensive-only: `payoutRequestId` was already confirmed truthy and
      // `linkedIncomes.length > 0` was already confirmed above — this call
      // re-queries the same rows and should always resolve. "Should never
      // happen in production" per the same trade-off as the
      // `linkedIncomes.length === 0` check above.
      this.logger.error(
        `autoCreateForPayout: PAYOUT ${payoutTxId} — aggregate amount could not be resolved despite ${linkedIncomes.length} linked income(s) present — skip`,
      )
      return
    }
    const aggregatedAmount = resolvedAmount.amount
    const aggregatedCurrency = resolvedAmount.currency
    const projectNames: string[] = []
    const seenProjectIds = new Set<string>()
    for (const incomeRow of linkedIncomes) {
      if (!incomeRow.projectId || seenProjectIds.has(incomeRow.projectId)) continue
      seenProjectIds.add(incomeRow.projectId)
      const project = await this.db.db.query.projects.findFirst({
        where: eq(projects.id, incomeRow.projectId),
      })
      if (project) projectNames.push(project.name)
    }

    // Resolve txDate for the invoice payload. The PAYOUT row itself is what
    // the SENIOR signed on-chain — its txDate (= request paid moment) is
    // the most precise stamp.
    const txDate = payoutTx.txDate ?? payoutTx.createdAt
    // ADMIN doesn't sign contracts (see signed_contracts CHECK constraint).
    // Counterparty is JUNIOR/HR/ACCOUNTANT/SENIOR/DROP in practice; defensive null for ADMIN.
    const contractNumber =
      counterpartyRow.role === 'ADMIN'
        ? null
        : await this.lookupContractNumber(counterpartyRow.id, counterpartyRow.role)

    // PDF generation — aggregated invoice uses the new contract-line
    // description, with the project list as a secondary line if any are
    // known.
    const txInfo: InvoiceTransactionInfo = {
      id: payoutTx.id,
      type: 'SENIOR_INCOME',
      amount: aggregatedAmount,
      currency: aggregatedCurrency,
      projectName: null,
      projectNames,
      contractNumber,
      // Use the salary month of the first linked income — they all belong to
      // the same payout cycle so the month is consistent. NULL falls through
      // to "no period line".
      salaryMonth: linkedIncomes[0]?.salaryMonth ?? null,
      txDate,
    }
    const counterpartyInfo = this.buildCounterpartyInfo(counterpartyRow)
    const verifyUrl = this.buildVerifyUrl(payoutTx.id)
    const sigForAdmin: InvoiceSignatureInfo = {
      role: 'COMPANY',
      signerName: adminRow.displayName,
      signedAt: new Date(),
      method: 'AUTO_COMPANY',
    }

    const { pdfBuffer, sha256Hash } = await this.pdfService.generateSignableInvoicePdf({
      transaction: txInfo,
      company: COMPANY_INFO,
      counterparty: counterpartyInfo,
      signatures: [sigForAdmin],
      verifyUrl,
    })

    const doc = await this.documentsService.uploadInternal({
      category: 'INVOICE',
      ownerId: counterpartyRow.id,
      file: pdfBuffer,
      mimeType: 'application/pdf',
      name: `invoice-${payoutTx.id.slice(0, 8)}.pdf`,
      uploadedById: adminId,
    })

    await this.db.db
      .update(transactions)
      .set({ invoiceDocumentId: doc.id, updatedAt: new Date() })
      .where(eq(transactions.id, payoutTx.id))

    await this.db.db.insert(invoiceSignatures).values({
      transactionId: payoutTx.id,
      signerRole: 'COMPANY',
      signerId: adminId,
      pdfHash: sha256Hash,
      method: 'AUTO_COMPANY',
      ipAddress: null,
      userAgent: null,
    })

    await this.notificationsService.create({
      userId: counterpartyRow.id,
      type: 'INVOICE_SIGN_REQUIRED',
      title: 'Инвойс ожидает вашей подписи',
      body: `Выплата синьора — сумма ${this.formatAmountForNotification(aggregatedAmount, aggregatedCurrency)}`,
      link: `/documents?category=INVOICE&openTx=${payoutTx.id}`,
    })

    this.logger.log(
      `autoCreateForPayout: PAYOUT=${payoutTx.id} req=${payoutTx.payoutRequestId} ` +
        `incomes=${linkedIncomes.length} projects=${projectNames.length} ` +
        `counterparty=${counterpartyRow.id} doc=${doc.id} hash=${sha256Hash.slice(0, 8)}`,
    )
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

  /**
   * Trigger 2: SALARY → invoice. Called from `TransactionsService` whenever
   * a SALARY row transitions to PAID (either via createSalary with
   * status=PAID, or via paySalary). The receiver (JUNIOR / HR / ACCOUNTANT)
   * is the counterparty.
   */
  async autoCreateForSalary(transactionId: string): Promise<void> {
    // security-review PR #456 round 2: see autoCreateForSeniorPayout.
    const [tx] = await this.db.db
      .select()
      .from(nonDeletedTransactions)
      .where(eq(nonDeletedTransactions.id, transactionId))
      .limit(1)
    if (!tx) return
    if (tx.type !== 'SALARY') return
    await this.autoCreate(tx)
  }

  /**
   * Shared implementation. Idempotent: skips if `invoice_document_id` is
   * already populated (a previous trigger already generated the document).
   * Wraps the PDF gen + S3 upload + signature + notification in a logical
   * sequence — no explicit transaction since the steps span S3 (not
   * transactional anyway). Failure midway leaves the PDF in S3 but no
   * signature row, which `autoCreate` re-running will detect and replace.
   */
  private async autoCreate(tx: Transaction): Promise<void> {
    // ---- Idempotency guard ----
    if (tx.invoiceDocumentId) {
      this.logger.debug(`autoCreate: tx ${tx.id} already has invoiceDocumentId, skipping`)
      return
    }

    const counterpartyId = this.getCounterpartyId(tx)
    if (!counterpartyId) {
      this.logger.warn(`autoCreate: tx ${tx.id} has no counterparty — skip`)
      return
    }

    const counterpartyRow = await this.db.db.query.users.findFirst({
      where: eq(users.id, counterpartyId),
    })
    if (!counterpartyRow) {
      this.logger.warn(`autoCreate: counterparty ${counterpartyId} missing`)
      return
    }

    const adminId = await this.getAdminId()
    const adminRow = await this.db.db.query.users.findFirst({
      where: eq(users.id, adminId),
    })
    if (!adminRow) {
      this.logger.error(`autoCreate: ADMIN user ${adminId} not found`)
      return
    }

    // Resolve project name for SENIOR_INCOME so the PDF body can render
    // "Доля по проекту ...". Skipped for SALARY (project is irrelevant).
    let projectName: string | null = null
    if (tx.type === 'SENIOR_INCOME' && tx.projectId) {
      const project = await this.db.db.query.projects.findFirst({
        where: eq(projects.id, tx.projectId),
      })
      if (project) projectName = project.name
    }

    // ---- 1. Generate the COMPANY-only PDF ----
    const txInfo: InvoiceTransactionInfo = {
      id: tx.id,
      type: tx.type as 'SENIOR_INCOME' | 'SALARY',
      amount: tx.amount,
      currency: tx.currency,
      projectName,
      salaryMonth: tx.salaryMonth ?? null,
      txDate: tx.txDate ?? tx.createdAt,
    }
    const counterpartyInfo = this.buildCounterpartyInfo(counterpartyRow)
    const verifyUrl = this.buildVerifyUrl(tx.id)

    const sigForAdmin: InvoiceSignatureInfo = {
      role: 'COMPANY',
      signerName: adminRow.displayName,
      signedAt: new Date(),
      method: 'AUTO_COMPANY',
    }

    const { pdfBuffer, sha256Hash } = await this.pdfService.generateSignableInvoicePdf({
      transaction: txInfo,
      company: COMPANY_INFO,
      counterparty: counterpartyInfo,
      signatures: [sigForAdmin],
      verifyUrl,
    })

    // ---- 2. Upload as INVOICE document ----
    const doc = await this.documentsService.uploadInternal({
      category: 'INVOICE',
      ownerId: counterpartyRow.id,
      file: pdfBuffer,
      mimeType: 'application/pdf',
      name: `invoice-${tx.id.slice(0, 8)}.pdf`,
      uploadedById: adminId,
    })

    // ---- 3. Link document to transaction ----
    await this.db.db
      .update(transactions)
      .set({ invoiceDocumentId: doc.id, updatedAt: new Date() })
      .where(eq(transactions.id, tx.id))

    // ---- 4. Insert COMPANY auto-signature ----
    await this.db.db.insert(invoiceSignatures).values({
      transactionId: tx.id,
      signerRole: 'COMPANY',
      signerId: adminId,
      pdfHash: sha256Hash,
      method: 'AUTO_COMPANY',
      // ip/user-agent NULL for auto-sign — recorded explicitly so a future
      // query "show only manual signatures" stays trivial.
      ipAddress: null,
      userAgent: null,
    })

    // ---- 5. Notify counterparty ----
    // The standalone `/finance/invoices` page was removed in batch 2 —
    // notifications now deep-link into `/documents` with the INVOICE
    // category pre-selected and the transaction's invoice dialog auto-
    // opened via `openTx=<id>`.
    await this.notificationsService.create({
      userId: counterpartyRow.id,
      type: 'INVOICE_SIGN_REQUIRED',
      title: 'Инвойс ожидает вашей подписи',
      body: `${this.getInvoiceTypeLabel(tx.type)} — сумма ${this.formatAmountForNotification(tx.amount, tx.currency)}`,
      link: `/documents?category=INVOICE&openTx=${tx.id}`,
    })

    this.logger.log(
      `autoCreate: tx=${tx.id} type=${tx.type} counterparty=${counterpartyRow.id} doc=${doc.id} hash=${sha256Hash.slice(0, 8)}`,
    )
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
  async voidAndReissueInvoiceForAmountEdit(transactionId: string, actorId: string): Promise<void> {
    const { hadInvoice } = await this.voidInvoiceForAmountEdit(transactionId, actorId)
    if (hadInvoice) await this.reissueInvoiceIfStillPaid(transactionId)
  }

  // ===========================================================================
  // List
  // ===========================================================================

  async listInvoices(viewer: SessionUser, filters: InvoiceListFilters): Promise<InvoiceListItem[]> {
    // task-aggregate-invoice-per-payout. PAYOUT rows now also carry an
    // invoice (the aggregated one). The counterparty for PAYOUT is the
    // sender (senior / drop) — see getCounterpartyId — so the join below
    // resolves via COALESCE(receiverId, senderId).
    //
    // security-review PR #456 round 2: sourced from `nonDeletedTransactions`
    // (VIEW, see schema.ts) instead of the raw table + a hand-written
    // `TRANSACTION_NOT_DELETED` condition — a soft-deleted row cannot appear
    // in this list no matter what, there is no condition to omit. Excluded
    // for EVERYONE (no ADMIN/ACCOUNTANT `includeDeleted` toggle like
    // `TransactionsService.findAll` — an admin inspecting a deleted row's
    // invoice uses the Finance ▸ Transactions view instead).
    const baseConditions = [
      inArray(nonDeletedTransactions.type, ['SENIOR_INCOME', 'SALARY', 'PAYOUT']),
      isNotNull(nonDeletedTransactions.invoiceDocumentId),
    ]

    // ---- RBAC ----
    if (viewer.role !== 'ADMIN' && viewer.role !== 'ACCOUNTANT') {
      // Counterparty rule:
      //   - SENIOR_INCOME / SALARY counterparty = `receiverId`
      //   - PAYOUT counterparty = `senderId`
      // The viewer must match the appropriate field for the row's type.
      baseConditions.push(
        sql`((${nonDeletedTransactions.type} IN ('SENIOR_INCOME', 'SALARY') AND ${nonDeletedTransactions.receiverId} = ${viewer.id})
            OR (${nonDeletedTransactions.type} = 'PAYOUT' AND ${nonDeletedTransactions.senderId} = ${viewer.id}))`,
      )
    }

    // ---- Type filter ----
    if (filters.type) {
      // Allow only invoice-eligible types as before. The public InvoiceType
      // schema is SENIOR_INCOME | SALARY; PAYOUT-anchored invoices surface
      // to the UI as `SENIOR_INCOME` (mapped below). When the caller
      // filters `type=SENIOR_INCOME` we include both real SENIOR_INCOMEs
      // and the aggregated PAYOUT rows so the existing UI stays intact.
      if (filters.type === 'SENIOR_INCOME') {
        baseConditions.push(sql`${nonDeletedTransactions.type} IN ('SENIOR_INCOME', 'PAYOUT')`)
      } else {
        baseConditions.push(eq(nonDeletedTransactions.type, filters.type))
      }
    }

    // ---- Status filter (computed via EXISTS on invoice_signatures) ----
    // task-invoice-signature-integrity: scoped to voided_at IS NULL — a
    // voided COUNTERPARTY row belongs to a PRIOR, superseded invoice (AC2)
    // and must not make a freshly-reissued (still-PENDING) invoice show up
    // as SIGNED.
    //
    // security-review round 2 (PR #600, MED-4): both branches below, and
    // the `signedFlag` subquery a few lines down, are exercised DIRECTLY by
    // invoice-signature-integrity.integration.spec.ts's void→reissue test —
    // it calls `listInvoices({status:'PENDING'})` / `{status:'SIGNED'}`
    // against the real database right after a reissue (asserting the fresh,
    // unsigned invoice shows up as PENDING and NOT as SIGNED) and again
    // after the counterparty re-signs (asserting the flip to SIGNED). This
    // replaces the ROUND-1 claim of this comment, which pointed at SIBLING
    // queries (`getSignaturesWithSignerNames`/`getInvoice`) that never
    // actually called `listInvoices` itself — accurate about the SQL
    // pattern, not about THIS call site.
    if (filters.status === 'PENDING') {
      baseConditions.push(
        sql`NOT EXISTS (SELECT 1 FROM invoice_signatures WHERE transaction_id = ${nonDeletedTransactions.id} AND signer_role = 'COUNTERPARTY' AND voided_at IS NULL)`,
      )
    } else if (filters.status === 'SIGNED') {
      baseConditions.push(
        sql`EXISTS (SELECT 1 FROM invoice_signatures WHERE transaction_id = ${nonDeletedTransactions.id} AND signer_role = 'COUNTERPARTY' AND voided_at IS NULL)`,
      )
    }

    const rows = await this.db.db
      .select({
        id: nonDeletedTransactions.id,
        type: nonDeletedTransactions.type,
        amount: nonDeletedTransactions.amount,
        currency: nonDeletedTransactions.currency,
        receiverId: nonDeletedTransactions.receiverId,
        // task-aggregate-invoice-per-payout. Join the user via COALESCE so
        // PAYOUT rows resolve through senderId. The expression returns the
        // counterparty's displayName regardless of row type.
        counterpartyName: sql<string | null>`COALESCE(${users.displayName}, '—')`,
        createdAt: nonDeletedTransactions.createdAt,
        // Subquery flag — true when an ACTIVE COUNTERPARTY signature exists
        // (voided_at IS NULL — see the status-filter comment above).
        // Stryker disable next-line StringLiteral: a raw SQL fragment run by
        // Postgres — the unit-test harness for this service is a mocked
        // Drizzle layer (invoices.service.spec.ts) that never executes SQL
        // text, so no unit test can distinguish this from an empty string.
        // security-review round 2 (PR #600, MED-4): DIRECTLY exercised by
        // invoice-signature-integrity.integration.spec.ts's `listInvoices`
        // calls (see the status-filter comment above for the exact
        // scenario) — the real database is what can see this line, and it
        // now actually runs this exact query, not just a sibling one.
        signedFlag: sql<boolean>`EXISTS (SELECT 1 FROM invoice_signatures WHERE transaction_id = ${nonDeletedTransactions.id} AND signer_role = 'COUNTERPARTY' AND voided_at IS NULL)`,
      })
      .from(nonDeletedTransactions)
      .leftJoin(
        users,
        sql`${users.id} = COALESCE(${nonDeletedTransactions.receiverId}, ${nonDeletedTransactions.senderId})`,
      )
      .where(and(...baseConditions))
      .orderBy(desc(nonDeletedTransactions.createdAt))

    return rows.map((r) => ({
      transactionId: r.id,
      status: (r.signedFlag ? 'SIGNED' : 'PENDING') as InvoiceStatus,
      // Public InvoiceType is SENIOR_INCOME | SALARY. Aggregated PAYOUT
      // invoices map to SENIOR_INCOME so the UI label («Выплата синьора»)
      // and existing filters keep working — the aggregation is an
      // implementation detail of the backend.
      type: (r.type === 'PAYOUT' ? 'SENIOR_INCOME' : r.type) as InvoiceType,
      amount: r.amount,
      currency: r.currency,
      counterpartyName: r.counterpartyName ?? '—',
      createdAt: r.createdAt.toISOString(),
    }))
  }

  // ===========================================================================
  // Get one
  // ===========================================================================

  async getInvoice(viewer: SessionUser, transactionId: string): Promise<InvoiceDto> {
    // security-review PR #456 round 2: `assertFoundAndVisible` fuses the
    // not-found check AND the visibility guard into the return value of THIS
    // fetch — round 1 had them as two separate statements, and the round-2
    // review deleted just the guard line to prove the scanner would not
    // notice. There is no longer a line to delete that removes only the
    // guard: the assignment IS the guard. MUST run before assertCanViewInvoice
    // (ownership) — same ordering rule as TransactionsService.findOne.
    const tx = assertFoundAndVisible(
      (await this.db.db.query.transactions.findFirst({
        where: eq(transactions.id, transactionId),
        with: {
          receiver: { columns: { id: true, displayName: true } },
          sender: { columns: { id: true, displayName: true } },
          project: { columns: { name: true } },
        },
      })) as
        | (Transaction & {
            receiver: { id: string; displayName: string } | null
            sender: { id: string; displayName: string } | null
            project: { name: string } | null
          })
        | undefined,
      viewer,
    )

    // task-aggregate-invoice-per-payout: PAYOUT rows now carry invoices too.
    if (tx.type !== 'SENIOR_INCOME' && tx.type !== 'SALARY' && tx.type !== 'PAYOUT') {
      throw new NotFoundException('Инвойс не предусмотрен для этого типа транзакции')
    }
    if (!tx.invoiceDocumentId) {
      throw new NotFoundException('Инвойс ещё не сгенерирован')
    }

    // RBAC: ADMIN + ACCOUNTANT pass; others must be the counterparty.
    this.assertCanViewInvoice(viewer, tx)

    const signatures = await this.getSignaturesWithSignerNames(tx.id)
    const status: InvoiceStatus = signatures.some((s) => s.signerRole === 'COUNTERPARTY')
      ? 'SIGNED'
      : 'PENDING'

    // Counterparty side for the DTO depends on the row's type — for PAYOUT
    // it's the sender (senior / drop), otherwise the receiver. See
    // `getCounterpartyId` for the canonical rule.
    const counterpartyUser = tx.type === 'PAYOUT' ? tx.sender : tx.receiver
    return {
      transactionId: tx.id,
      documentId: tx.invoiceDocumentId,
      status,
      // PAYOUT-anchored invoices are surfaced as SENIOR_INCOME to the UI
      // (the InvoiceType enum is SENIOR_INCOME | SALARY).
      type: (tx.type === 'PAYOUT' ? 'SENIOR_INCOME' : tx.type) as InvoiceType,
      amount: tx.amount,
      currency: tx.currency,
      counterpartyId: counterpartyUser?.id ?? this.getCounterpartyId(tx) ?? '',
      counterpartyName: counterpartyUser?.displayName ?? '—',
      projectName: tx.project?.name ?? null,
      salaryMonth: tx.salaryMonth ?? null,
      signatures: signatures.map((s) => ({
        id: s.id,
        transactionId: s.transactionId,
        signerRole: s.signerRole,
        signerId: s.signerId,
        signerName: s.signerName,
        signedAt: s.signedAt.toISOString(),
        pdfHashShort: s.pdfHashShort,
        method: s.method,
      })),
      createdAt: tx.createdAt.toISOString(),
    }
  }

  // ===========================================================================
  // Sign (counterparty)
  // ===========================================================================

  async signInvoice(
    viewer: SessionUser,
    transactionId: string,
    req: FastifyRequest,
  ): Promise<InvoiceDto> {
    // security-review PR #456 round 2: fetch + write-guard fused into one
    // call (see the `getInvoice` comment above for why this specific pattern
    // exists — round 2 defeated the round-1 two-statement version). A
    // deleted transaction's invoice used to be fully signable by its
    // (non-privileged) counterparty; non-privileged + deleted → 404 (hides
    // existence); privileged + deleted → 400 (blocks the sign).
    const tx = await fetchWritableTransactionOrThrow(this.db.db, transactionId, viewer)
    // task-aggregate-invoice-per-payout: PAYOUT rows now sign too.
    if (tx.type !== 'SENIOR_INCOME' && tx.type !== 'SALARY' && tx.type !== 'PAYOUT') {
      throw new NotFoundException('Инвойс не предусмотрен для этого типа транзакции')
    }
    if (!tx.invoiceDocumentId) {
      throw new ConflictException('Инвойс ещё не сгенерирован — повторите попытку позже')
    }

    // ---- RBAC: viewer must be the counterparty ----
    if (this.getCounterpartyId(tx) !== viewer.id) {
      throw new ForbiddenException('Вы не контрагент этой транзакции')
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
      throw new ConflictException('Инвойс уже подписан')
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
      throw new ConflictException('Отсутствует подпись компании')
    }

    // ---- Download current PDF, compute fresh hash, compare ----
    const doc = await this.documentsService.findByIdInternal(tx.invoiceDocumentId)
    if (!doc) throw new ConflictException('Документ инвойса не найден')

    const pdfBuffer = await this.s3.getObject(doc.s3Key)
    const currentHash = sha256Hex(pdfBuffer)
    if (companySig[0]!.pdfHash !== currentHash) {
      throw new ConflictException(
        'PDF был изменён после первой подписи — обратитесь к администратору',
      )
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
      throw new ConflictException('Не удалось получить данные пользователей')
    }
    const counterpartyInfo = this.buildCounterpartyInfo(counterpartyRow)

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
        throw new ConflictException(
          'Не удалось подтвердить сумму этого инвойса — обратитесь к администратору',
        )
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
        throw new ConflictException(
          'Не удалось подтвердить сумму этого инвойса — обратитесь к администратору',
        )
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
    const ip = this.extractIp(req)
    const userAgent = this.extractUserAgent(req)
    await this.db.db.transaction(async (dbtx) => {
      const [locked] = await dbtx
        .select({ invoiceDocumentId: transactions.invoiceDocumentId })
        .from(transactions)
        .where(eq(transactions.id, tx.id))
        .for('update')
        .limit(1)
      if (!locked || locked.invoiceDocumentId !== doc.id) {
        throw new ConflictException('Инвойс был аннулирован — обновите страницу')
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
      pdfHashFull: s.signerRole === 'COMPANY' ? companySig[0]!.pdfHash : currentHash,
      ipLastOctet: s.signerRole === 'COUNTERPARTY' && ip ? this.lastOctet(ip) : null,
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
    const repointed = await this.db.db
      .update(transactions)
      .set({ invoiceDocumentId: newDoc.id, updatedAt: new Date() })
      .where(and(eq(transactions.id, tx.id), eq(transactions.invoiceDocumentId, doc.id)))
      .returning({ id: transactions.id })
    if (repointed.length === 0) {
      throw new ConflictException('Инвойс был аннулирован — обновите страницу')
    }

    // ---- Notify ADMIN ----
    await this.notificationsService.create({
      userId: adminId,
      type: 'INVOICE_SIGNED',
      title: `${counterpartyRow.displayName} подписал инвойс`,
      body: `${this.getInvoiceTypeLabel(tx.type)} — сумма ${this.formatAmountForNotification(tx.amount, tx.currency)}`,
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
      throw new NotFoundException('Инвойс не найден')
    }
    // task-aggregate-invoice-per-payout: PAYOUT rows are valid invoice anchors.
    if (tx.type !== 'SENIOR_INCOME' && tx.type !== 'SALARY' && tx.type !== 'PAYOUT') {
      throw new NotFoundException('Инвойс не найден')
    }
    if (!tx.invoiceDocumentId) {
      throw new NotFoundException('Инвойс ещё не сгенерирован')
    }

    const sigs = await this.getSignaturesWithSignerNames(tx.id)

    // SEC-11: gate on SIGNED status — an invoice is publicly verifiable only
    // once the counterparty has signed. Returning data for PENDING invoices
    // would expose amount and counterparty name via transactionId enumeration
    // before the employee has consented to the payment record.
    const counterpartySig = sigs.find((s) => s.signerRole === 'COUNTERPARTY')
    if (!counterpartySig) {
      throw new NotFoundException('Инвойс не найден')
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
    //     `tx.amount` IS the historically-safe fallback for this case: for
    //     SALARY/SENIOR_INCOME, BIZ-18 blocked ALL PAID-amount edits
    //     unconditionally while these rows were signed, so no divergence
    //     was ever possible in the first place.
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
    // per-signature (no schema change this round), so `false` is the
    // honest default there: no recomputation happened for THIS response.
    let mixedCurrency = false
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
        throw new ConflictException(
          'Не удалось подтвердить сумму этого инвойса — обратитесь к администратору',
        )
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
      // CRITICAL: only public fields. Strip ip / user_agent / full hash.
      // SEC-05: mask COMPANY signer name with brand constant — the PDF already
      // does this via drawCompanySignature; the verify API must mirror it so
      // the admin's personal display name is never exposed to unauthenticated
      // callers enumerating the public verify endpoint.
      signatures: sigs.map((s) => ({
        role: s.signerRole,
        signerName: s.signerRole === 'COMPANY' ? COMPANY_BRAND_NAME : s.signerName,
        signedAt: s.signedAt.toISOString(),
        pdfHashShort: s.pdfHashShort,
      })),
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

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
  private async resolvePayoutAggregateAmount(payoutRequestId: string | null): Promise<{
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

  /**
   * Counterparty id derivation:
   *   SENIOR_INCOME — the senior is the counterparty (receiver of the income).
   *   SALARY        — the employee is the counterparty (receiver of the
   *                   salary).
   *   PAYOUT        — task-aggregate-invoice-per-payout. The aggregated
   *                   invoice anchors on the PAYOUT row. The PAYOUT row's
   *                   `senderId` is the senior / drop that initiated the
   *                   payout — they are the counterparty (the entity signing
   *                   on behalf of «ИСПОЛНИТЕЛЬ» in the act).
   * Returning null defensively when the column is unexpectedly NULL (the DB
   * FK ON DELETE SET NULL means a deleted user breaks the link).
   */
  private getCounterpartyId(tx: Transaction): string | null {
    if (tx.type === 'SENIOR_INCOME' || tx.type === 'SALARY') {
      return tx.receiverId
    }
    if (tx.type === 'PAYOUT') {
      return tx.senderId
    }
    return null
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

  /**
   * Pretty label used in notifications. Mirrors the frontend
   * `apps/web/app/lib/invoice-labels.ts` helper so the notification body the
   * user sees in the bell dropdown matches the type badge on the matching
   * invoice card / dialog header.
   */
  private getInvoiceTypeLabel(type: string): string {
    // task-aggregate-invoice-per-payout: PAYOUT rows share the senior
    // payout label (the invoice represents the same money flow — senior
    // settling with the company).
    if (type === 'SENIOR_INCOME' || type === 'PAYOUT') return 'Выплата синьора'
    if (type === 'SALARY') return 'Зарплата'
    return 'Инвойс'
  }

  /**
   * Normalise a NUMERIC amount string for human-readable display in
   * notifications: drop trailing zeros, cap at 2 decimals, ru-RU locale
   * (thin-space thousands separator).
   *
   * UT round 1: the raw `tx.amount` was emitted into the notification body
   * as `1500.000000` (Postgres NUMERIC trailing zeros) which looked broken.
   */
  private formatAmountForNotification(amount: string, currency: string): string {
    const num = Number(amount)
    if (!Number.isFinite(num)) return `${amount} ${currency}`
    return `${num.toLocaleString('ru-RU', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} ${currency}`
  }

  /**
   * Build the counterparty info struct for the PDF service. Pulls payment
   * requisites off the user row — branches by `paymentMethod` because USDT
   * and Bank UAH ФОП have completely different field layouts.
   */
  private buildCounterpartyInfo(user: typeof users.$inferSelect): InvoiceCounterpartyInfo {
    const details: string[] = []
    if (user.paymentMethod === 'USDT_ERC20') {
      if (user.walletUsdtErc20) details.push(`USDT (ERC-20): ${user.walletUsdtErc20}`)
      if (user.walletUsdtLabel) details.push(user.walletUsdtLabel)
    } else if (user.paymentMethod === 'BANK_UAH_FOP') {
      if (user.bankUahRecipient) details.push(`Отримувач: ${user.bankUahRecipient}`)
      if (user.bankUahIban) details.push(`IBAN: ${user.bankUahIban}`)
      if (user.bankUahRnokpp) details.push(`РНОКПП: ${user.bankUahRnokpp}`)
      if (user.bankUahBankName) details.push(`Банк: ${user.bankUahBankName}`)
    }
    return {
      displayName: user.displayName,
      paymentMethod: user.paymentMethod ?? null,
      paymentDetails: details,
    }
  }

  /** FRONTEND_URL + /invoice/v/:id — used as the QR code payload. */
  private buildVerifyUrl(transactionId: string): string {
    const frontendUrl = this.config.get('FRONTEND_URL', { infer: true })
    return `${frontendUrl}/invoice/v/${transactionId}`
  }

  /**
   * Extract the client IP from a Fastify request. We prefer `req.ip` (which
   * Fastify resolves through trustProxy if configured) and fall back to
   * `x-forwarded-for`. Returns null when neither is available so the DB
   * column stays NULL instead of an empty string.
   */
  private extractIp(req: FastifyRequest): string | null {
    if (req.ip) return req.ip
    const xff = req.headers['x-forwarded-for']
    if (typeof xff === 'string' && xff.length > 0) {
      return xff.split(',')[0]!.trim()
    }
    if (Array.isArray(xff) && xff.length > 0) {
      return xff[0]!.split(',')[0]!.trim()
    }
    return null
  }

  private extractUserAgent(req: FastifyRequest): string | null {
    const ua = req.headers['user-agent']
    if (typeof ua === 'string' && ua.length > 0) return ua
    return null
  }

  /** Last octet of an IPv4 string; empty for IPv6 / null inputs. */
  private lastOctet(ip: string): string | null {
    const m = /^(\d+\.\d+\.\d+\.)(\d+)$/.exec(ip)
    return m ? m[2]! : null
  }

  /**
   * RBAC for `getInvoice`: ADMIN + ACCOUNTANT see everything; everyone else
   * must be the counterparty. Throws 403 with a Russian message.
   */
  private assertCanViewInvoice(viewer: SessionUser, tx: Transaction): void {
    if (viewer.role === 'ADMIN' || viewer.role === 'ACCOUNTANT') return
    if (this.getCounterpartyId(tx) === viewer.id) return
    throw new ForbiddenException('Нет доступа к этому инвойсу')
  }

  /**
   * Fetch all signatures for a transaction + the signer's displayName. Sorted
   * deterministically (COMPANY first then COUNTERPARTY) so the PDF re-render
   * pass is reproducible.
   */
  private async getSignaturesWithSignerNames(transactionId: string): Promise<
    Array<{
      id: string
      transactionId: string
      signerRole: 'COMPANY' | 'COUNTERPARTY'
      signerId: string
      signerName: string
      signedAt: Date
      pdfHash: string
      pdfHashShort: string
      method: 'AUTO_COMPANY' | 'MANUAL_CLICK'
      /** AC3 — populated only on COUNTERPARTY rows signed after this migration. */
      amountSnapshot: string | null
      currencySnapshot: string | null
    }>
  > {
    // task-invoice-signature-integrity: every caller (getInvoice, signInvoice,
    // verifyInvoice) wants signatures for the transaction's CURRENT invoice
    // only — a voided row belongs to a PRIOR, superseded invoice generation
    // (AC2) and must never be reported as "this is signed" for the current
    // one. Scoping here, once, means no caller can forget it.
    const rows = await this.db.db
      .select({
        id: invoiceSignatures.id,
        transactionId: invoiceSignatures.transactionId,
        signerRole: invoiceSignatures.signerRole,
        signerId: invoiceSignatures.signerId,
        signerName: users.displayName,
        signedAt: invoiceSignatures.signedAt,
        pdfHash: invoiceSignatures.pdfHash,
        method: invoiceSignatures.method,
        amountSnapshot: invoiceSignatures.amountSnapshot,
        currencySnapshot: invoiceSignatures.currencySnapshot,
      })
      .from(invoiceSignatures)
      .leftJoin(users, eq(users.id, invoiceSignatures.signerId))
      .where(
        and(eq(invoiceSignatures.transactionId, transactionId), isNull(invoiceSignatures.voidedAt)),
      )

    // Sort: COMPANY first (so the PDF always renders the same order) then
    // COUNTERPARTY. Within the same role we sort by signedAt for stability.
    const sorted = [...rows].sort((a, b) => {
      if (a.signerRole === b.signerRole) {
        return a.signedAt.getTime() - b.signedAt.getTime()
      }
      return a.signerRole === 'COMPANY' ? -1 : 1
    })

    return sorted.map((r) => ({
      id: r.id,
      transactionId: r.transactionId,
      signerRole: r.signerRole as 'COMPANY' | 'COUNTERPARTY',
      signerId: r.signerId,
      signerName: r.signerName ?? '—',
      signedAt: r.signedAt,
      pdfHash: r.pdfHash,
      pdfHashShort: shortHash(r.pdfHash),
      method: r.method as 'AUTO_COMPANY' | 'MANUAL_CLICK',
      amountSnapshot: r.amountSnapshot,
      currencySnapshot: r.currencySnapshot,
    }))
  }
}
