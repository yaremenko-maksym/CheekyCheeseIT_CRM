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
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
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
  InvoicePdfService,
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
    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, transactionId),
    })
    if (!tx) return // tx gone — nothing to do (defensive)
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
    const payoutTx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, payoutTxId),
    })
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
    const linkedIncomes = await this.db.db.query.transactions.findMany({
      where: and(
        eq(transactions.payoutRequestId, payoutTx.payoutRequestId),
        inArray(transactions.type, ['SENIOR_INCOME', 'DROP_INCOME']),
      ),
    })
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

    // Aggregate amount + collect project names. Per-project lookup is
    // tolerated as the linked income count is bounded by the number of
    // active projects per senior (typically ≤ 6). The N+1 query is
    // acceptable here — caching would over-engineer for the expected fanout.
    const aggregatedAmount = linkedIncomes
      .reduce((sum, row) => sum + parseFloat(row.amount), 0)
      .toString()
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

    // Resolve txDate/period/currency for the invoice payload. The PAYOUT row
    // itself is what the SENIOR signed on-chain — its txDate (= request paid
    // moment) is the most precise stamp.
    const aggregatedCurrency = (linkedIncomes[0]?.currency ?? payoutTx.currency) as
      | 'USDT'
      | 'USD'
      | 'EUR'
      | 'UAH'
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
    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, transactionId),
    })
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
  // List
  // ===========================================================================

  async listInvoices(viewer: SessionUser, filters: InvoiceListFilters): Promise<InvoiceListItem[]> {
    // task-aggregate-invoice-per-payout. PAYOUT rows now also carry an
    // invoice (the aggregated one). The counterparty for PAYOUT is the
    // sender (senior / drop) — see getCounterpartyId — so the join below
    // resolves via COALESCE(receiverId, senderId).
    const baseConditions = [
      inArray(transactions.type, ['SENIOR_INCOME', 'SALARY', 'PAYOUT']),
      isNotNull(transactions.invoiceDocumentId),
    ]

    // ---- RBAC ----
    if (viewer.role !== 'ADMIN' && viewer.role !== 'ACCOUNTANT') {
      // Counterparty rule:
      //   - SENIOR_INCOME / SALARY counterparty = `receiverId`
      //   - PAYOUT counterparty = `senderId`
      // The viewer must match the appropriate field for the row's type.
      baseConditions.push(
        sql`((${transactions.type} IN ('SENIOR_INCOME', 'SALARY') AND ${transactions.receiverId} = ${viewer.id})
            OR (${transactions.type} = 'PAYOUT' AND ${transactions.senderId} = ${viewer.id}))`,
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
        baseConditions.push(sql`${transactions.type} IN ('SENIOR_INCOME', 'PAYOUT')`)
      } else {
        baseConditions.push(eq(transactions.type, filters.type))
      }
    }

    // ---- Status filter (computed via EXISTS on invoice_signatures) ----
    if (filters.status === 'PENDING') {
      baseConditions.push(
        sql`NOT EXISTS (SELECT 1 FROM invoice_signatures WHERE transaction_id = ${transactions.id} AND signer_role = 'COUNTERPARTY')`,
      )
    } else if (filters.status === 'SIGNED') {
      baseConditions.push(
        sql`EXISTS (SELECT 1 FROM invoice_signatures WHERE transaction_id = ${transactions.id} AND signer_role = 'COUNTERPARTY')`,
      )
    }

    const rows = await this.db.db
      .select({
        id: transactions.id,
        type: transactions.type,
        amount: transactions.amount,
        currency: transactions.currency,
        receiverId: transactions.receiverId,
        // task-aggregate-invoice-per-payout. Join the user via COALESCE so
        // PAYOUT rows resolve through senderId. The expression returns the
        // counterparty's displayName regardless of row type.
        counterpartyName: sql<string | null>`COALESCE(${users.displayName}, '—')`,
        createdAt: transactions.createdAt,
        // Subquery flag — true when a COUNTERPARTY signature exists.
        signedFlag: sql<boolean>`EXISTS (SELECT 1 FROM invoice_signatures WHERE transaction_id = ${transactions.id} AND signer_role = 'COUNTERPARTY')`,
      })
      .from(transactions)
      .leftJoin(
        users,
        sql`${users.id} = COALESCE(${transactions.receiverId}, ${transactions.senderId})`,
      )
      .where(and(...baseConditions))
      .orderBy(desc(transactions.createdAt))

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
    const row = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, transactionId),
      with: {
        receiver: { columns: { id: true, displayName: true } },
        sender: { columns: { id: true, displayName: true } },
        project: { columns: { name: true } },
      },
    })
    if (!row) throw new NotFoundException('Транзакция не найдена')

    const tx = row as Transaction & {
      receiver: { id: string; displayName: string } | null
      sender: { id: string; displayName: string } | null
      project: { name: string } | null
    }

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
    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, transactionId),
    })
    if (!tx) throw new NotFoundException('Транзакция не найдена')
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
    const existing = await this.db.db
      .select()
      .from(invoiceSignatures)
      .where(
        and(
          eq(invoiceSignatures.transactionId, tx.id),
          eq(invoiceSignatures.signerRole, 'COUNTERPARTY'),
        ),
      )
      .limit(1)
    if (existing.length > 0) {
      throw new ConflictException('Инвойс уже подписан')
    }

    // ---- Re-fetch the COMPANY signature to verify hash equality ----
    const companySig = await this.db.db
      .select()
      .from(invoiceSignatures)
      .where(
        and(
          eq(invoiceSignatures.transactionId, tx.id),
          eq(invoiceSignatures.signerRole, 'COMPANY'),
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

    // ---- Insert COUNTERPARTY signature ----
    const signedAt = new Date()
    const ip = this.extractIp(req)
    const userAgent = this.extractUserAgent(req)
    await this.db.db.insert(invoiceSignatures).values({
      transactionId: tx.id,
      signerRole: 'COUNTERPARTY',
      signerId: viewer.id,
      pdfHash: currentHash,
      method: 'MANUAL_CLICK',
      ipAddress: ip,
      userAgent,
      signedAt,
    })

    // ---- Re-render PDF with both signatures ----
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

    const allSigs = await this.getSignaturesWithSignerNames(tx.id)
    const counterpartyInfo = this.buildCounterpartyInfo(counterpartyRow)

    const sigBlocks: InvoiceSignatureInfo[] = allSigs.map((s) => ({
      role: s.signerRole,
      signerName: s.signerName,
      signedAt: s.signedAt,
      method: s.method,
      pdfHashFull: s.signerRole === 'COMPANY' ? companySig[0]!.pdfHash : currentHash,
      ipLastOctet: s.signerRole === 'COUNTERPARTY' && ip ? this.lastOctet(ip) : null,
    }))

    // task-aggregate-invoice-per-payout. For PAYOUT rows we re-resolve the
    // aggregated description (contract number + project list) on every sign
    // so the re-rendered PDF matches what the COMPANY originally signed
    // byte-for-byte (which is what the hash-equality check above already
    // verified). For SENIOR_INCOME / SALARY we keep the legacy
    // project-name-per-row path.
    let projectName: string | null = null
    let projectNames: string[] | null = null
    let contractNumber: string | null = null
    // BIZ-05 (MED): For PAYOUT rows, amount/currency must come from the
    // aggregated linked income rows (exactly as autoCreateForPayout does),
    // NOT from tx.amount/tx.currency (which is the payableAmount in USDT).
    // Using tx.amount would produce a different amount in the re-rendered PDF
    // than what the COMPANY signed, making the counterparty-signed copy inconsistent.
    let payoutAggregatedAmount: string | null = null
    let payoutAggregatedCurrency: string | null = null
    if (tx.type === 'PAYOUT' && tx.payoutRequestId) {
      const linkedIncomes = await this.db.db.query.transactions.findMany({
        where: and(
          eq(transactions.payoutRequestId, tx.payoutRequestId),
          inArray(transactions.type, ['SENIOR_INCOME', 'DROP_INCOME']),
        ),
      })
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
      // Aggregate amount + currency from linked incomes — mirrors autoCreateForPayout
      // so the re-rendered PDF uses the same values as the COMPANY-signed original.
      if (linkedIncomes.length > 0) {
        payoutAggregatedAmount = linkedIncomes
          .reduce((sum, row) => sum + parseFloat(row.amount), 0)
          .toString()
        payoutAggregatedCurrency = linkedIncomes[0]!.currency ?? tx.currency
      }
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
      // BIZ-05: Use aggregated linked income amount/currency for PAYOUT rows,
      // falling back to tx.amount/tx.currency only when no linked incomes found
      // (defensive — should never happen in production).
      amount: tx.type === 'PAYOUT' ? (payoutAggregatedAmount ?? tx.amount) : tx.amount,
      currency:
        tx.type === 'PAYOUT'
          ? ((payoutAggregatedCurrency ?? tx.currency) as typeof tx.currency)
          : tx.currency,
      projectName,
      projectNames,
      contractNumber,
      salaryMonth: tx.salaryMonth ?? null,
      txDate: tx.txDate ?? tx.createdAt,
    }

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
    await this.db.db
      .update(transactions)
      .set({ invoiceDocumentId: newDoc.id, updatedAt: new Date() })
      .where(eq(transactions.id, tx.id))

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
    const tx = await this.db.db.query.transactions.findFirst({
      where: eq(transactions.id, transactionId),
    })
    if (!tx) throw new NotFoundException('Инвойс не найден')
    // task-aggregate-invoice-per-payout: PAYOUT rows are valid invoice anchors.
    if (tx.type !== 'SENIOR_INCOME' && tx.type !== 'SALARY' && tx.type !== 'PAYOUT') {
      throw new NotFoundException('Инвойс не найден')
    }
    if (!tx.invoiceDocumentId) {
      throw new NotFoundException('Инвойс ещё не сгенерирован')
    }

    const sigs = await this.getSignaturesWithSignerNames(tx.id)
    const status: InvoiceStatus = sigs.some((s) => s.signerRole === 'COUNTERPARTY')
      ? 'SIGNED'
      : 'PENDING'

    return {
      transactionId: tx.id,
      status,
      amount: tx.amount,
      currency: tx.currency,
      // Public InvoiceType enum is SENIOR_INCOME | SALARY — PAYOUT maps to
      // SENIOR_INCOME for the verify response.
      type: (tx.type === 'PAYOUT' ? 'SENIOR_INCOME' : tx.type) as 'SENIOR_INCOME' | 'SALARY',
      // CRITICAL: only public fields. Strip ip / user_agent / full hash.
      signatures: sigs.map((s) => ({
        role: s.signerRole,
        signerName: s.signerName,
        signedAt: s.signedAt.toISOString(),
        pdfHashShort: s.pdfHashShort,
      })),
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

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
    }>
  > {
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
      })
      .from(invoiceSignatures)
      .leftJoin(users, eq(users.id, invoiceSignatures.signerId))
      .where(eq(invoiceSignatures.transactionId, transactionId))

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
    }))
  }
}
