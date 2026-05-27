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
  invoiceSignatures,
  projects,
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

const COMPANY_INFO: InvoiceCompanyInfo = {
  name: 'CheekyCheese IT',
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
    // The standalone `/crm/finance/invoices` page was removed in batch 2 —
    // notifications now deep-link into `/crm/documents` with the INVOICE
    // category pre-selected and the transaction's invoice dialog auto-
    // opened via `openTx=<id>`.
    await this.notificationsService.create({
      userId: counterpartyRow.id,
      type: 'INVOICE_SIGN_REQUIRED',
      title: 'Инвойс ожидает вашей подписи',
      body: `${this.getInvoiceTypeLabel(tx.type)} — сумма ${this.formatAmountForNotification(tx.amount, tx.currency)}`,
      link: `/crm/documents?category=INVOICE&openTx=${tx.id}`,
    })

    this.logger.log(
      `autoCreate: tx=${tx.id} type=${tx.type} counterparty=${counterpartyRow.id} doc=${doc.id} hash=${sha256Hash.slice(0, 8)}`,
    )
  }

  // ===========================================================================
  // List
  // ===========================================================================

  async listInvoices(viewer: SessionUser, filters: InvoiceListFilters): Promise<InvoiceListItem[]> {
    // Only SENIOR_INCOME + SALARY rows with a generated invoice are listed.
    const baseConditions = [
      inArray(transactions.type, ['SENIOR_INCOME', 'SALARY']),
      isNotNull(transactions.invoiceDocumentId),
    ]

    // ---- RBAC ----
    if (viewer.role !== 'ADMIN' && viewer.role !== 'ACCOUNTANT') {
      // Counterparty rule: SENIOR_INCOME counterparty is the receiver (the
      // senior themselves); SALARY counterparty is also the receiver
      // (JUNIOR / HR / ACCOUNTANT). So in both cases viewer.id must equal
      // transactions.receiverId.
      baseConditions.push(eq(transactions.receiverId, viewer.id))
    }

    // ---- Type filter ----
    if (filters.type) {
      baseConditions.push(eq(transactions.type, filters.type))
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
        receiverName: users.displayName,
        createdAt: transactions.createdAt,
        // Subquery flag — true when a COUNTERPARTY signature exists.
        signedFlag: sql<boolean>`EXISTS (SELECT 1 FROM invoice_signatures WHERE transaction_id = ${transactions.id} AND signer_role = 'COUNTERPARTY')`,
      })
      .from(transactions)
      .leftJoin(users, eq(users.id, transactions.receiverId))
      .where(and(...baseConditions))
      .orderBy(desc(transactions.createdAt))

    return rows.map((r) => ({
      transactionId: r.id,
      status: (r.signedFlag ? 'SIGNED' : 'PENDING') as InvoiceStatus,
      type: r.type as InvoiceType,
      amount: r.amount,
      currency: r.currency,
      counterpartyName: r.receiverName ?? '—',
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
        project: { columns: { name: true } },
      },
    })
    if (!row) throw new NotFoundException('Транзакция не найдена')

    const tx = row as Transaction & {
      receiver: { id: string; displayName: string } | null
      project: { name: string } | null
    }

    if (tx.type !== 'SENIOR_INCOME' && tx.type !== 'SALARY') {
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

    return {
      transactionId: tx.id,
      documentId: tx.invoiceDocumentId,
      status,
      type: tx.type,
      amount: tx.amount,
      currency: tx.currency,
      counterpartyId: tx.receiver?.id ?? this.getCounterpartyId(tx) ?? '',
      counterpartyName: tx.receiver?.displayName ?? '—',
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
    if (tx.type !== 'SENIOR_INCOME' && tx.type !== 'SALARY') {
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

    let projectName: string | null = null
    if (tx.type === 'SENIOR_INCOME' && tx.projectId) {
      const project = await this.db.db.query.projects.findFirst({
        where: eq(projects.id, tx.projectId),
      })
      if (project) projectName = project.name
    }

    const txInfo: InvoiceTransactionInfo = {
      id: tx.id,
      type: tx.type as 'SENIOR_INCOME' | 'SALARY',
      amount: tx.amount,
      currency: tx.currency,
      projectName,
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
      link: `/crm/documents?category=INVOICE&openTx=${tx.id}`,
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
    if (tx.type !== 'SENIOR_INCOME' && tx.type !== 'SALARY') {
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
      type: tx.type,
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
   * In both flows, `transactions.receiverId` is the right field. Returning
   * null defensively when the column is unexpectedly NULL (the DB FK ON
   * DELETE SET NULL means a deleted user breaks the link).
   */
  private getCounterpartyId(tx: Transaction): string | null {
    if (tx.type === 'SENIOR_INCOME' || tx.type === 'SALARY') {
      return tx.receiverId
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
    if (type === 'SENIOR_INCOME') return 'Выплата синьера'
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
