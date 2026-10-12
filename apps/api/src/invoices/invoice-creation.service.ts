/**
 * InvoiceCreationService — auto-create side of the Invoice Signing Epic,
 * extracted from InvoicesService (giant-decomposition leaf L5, behavior-preserving MOVE).
 *
 * Owns the three triggers (`autoCreateForSeniorPayout`, `autoCreateForPayout`,
 * `autoCreateForSalary`) and the shared `autoCreate` implementation. It is a plain
 * class built inside the InvoicesService constructor (no DI registration): it reuses
 * the facade's already-injected `DocumentsService` (forwardRef-resolved there), so no
 * new provider edge and no module cycle appear.
 *
 * Helpers that `signInvoice` / `verifyInvoice` share with the triggers (`getAdminId` with
 * its in-memory cache, `resolvePayoutAggregateAmount`, `lookupContractNumber`,
 * `buildVerifyUrl`) stay on the facade and are reached through late-bound callbacks,
 * so there is exactly one copy of each and spies on the facade keep working.
 */
import { Logger } from '@nestjs/common'
import { and, eq, inArray } from 'drizzle-orm'
import type { ContractTargetRole } from '@crm/shared'
import { NOTIFICATION_TITLES } from '@crm/shared'
import { DatabaseService } from '../database/database.service'
import {
  invoiceSignatures,
  nonDeletedTransactions,
  projects,
  transactions,
  users,
  type Transaction,
} from '../database/schema'
import { DocumentsService } from '../documents/documents.service'
import { NotificationsService } from '../notifications/notifications.service'
import {
  InvoicePdfService,
  type InvoiceSignatureInfo,
  type InvoiceTransactionInfo,
} from './invoice-pdf.service'
import { buildCounterpartyInfo, getCounterpartyId } from './invoice-counterparty.util'
import { COMPANY_INFO } from './invoice-company-info.const'

/** Facade-owned helpers shared with the sign / verify paths (see file header). */
export interface InvoiceCreationDeps {
  getAdminId: () => Promise<string>
  resolvePayoutAggregateAmount: (payoutRequestId: string | null) => Promise<{
    amount: string
    currency: Transaction['currency']
    mixedCurrency: boolean
  } | null>
  lookupContractNumber: (userId: string, userRole: ContractTargetRole) => Promise<string | null>
  buildVerifyUrl: (transactionId: string) => string
}

export class InvoiceCreationService {
  // Same log context as before the extraction (the facade's name).
  private readonly logger = new Logger('InvoicesService')

  constructor(
    private readonly db: DatabaseService,
    private readonly pdfService: InvoicePdfService,
    private readonly documentsService: DocumentsService,
    private readonly notificationsService: NotificationsService,
    private readonly deps: InvoiceCreationDeps,
  ) {}

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
   *   - Currency = resolved via `resolvePayoutAggregateAmount` (the earliest
   *     linked income by `createdAt`, deterministic `ORDER BY`). Mixed
   *     currency is a SUPPORTED configuration (the helper counts the blind
   *     sum and flags `mixedCurrency` rather than refusing) — corrected
   *     security-review round 6, MED-I: this used to say "unsupported edge
   *     case" and pointed at PHASE 8 smart-contracts, which were cancelled
   *     2026-06-17 (see `resolvePayoutAggregateAmount`'s own doc comment
   *     below for the current, load-bearing rule).
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

    const adminId = await this.deps.getAdminId()
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
    const resolvedAmount = await this.deps.resolvePayoutAggregateAmount(payoutTx.payoutRequestId)
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
    // security-review round 6 (PR #600, LOW): `salaryMonth` below reads the
    // "first" linked income by the SAME deterministic order the amount/
    // currency above were just resolved with (`resolvePayoutAggregateAmount`'s
    // `ORDER BY createdAt ASC`) — `linkedIncomes` itself (fetched above, no
    // `ORDER BY`) is NOT that order, so indexing `[0]` on it directly would
    // silently mean two different things by "first linked income" in the
    // same function: an unordered Postgres row for the date, an ordered one
    // for the money. Sorting a copy here (not `linkedIncomes` itself — the
    // project-name loop below iterates it order-independently, so mutating
    // in place would be a needless side effect) restores single meaning.
    const earliestLinkedIncome = [...linkedIncomes].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    )[0]
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
        : await this.deps.lookupContractNumber(counterpartyRow.id, counterpartyRow.role)

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
      // Use the salary month of the earliest linked income (by createdAt —
      // same order as `aggregatedAmount`/`aggregatedCurrency` above) — they
      // all belong to the same payout cycle so the month is consistent.
      // NULL falls through to "no period line". `!` (not `?.`), matching
      // `resolvePayoutAggregateAmount`'s own `linkedIncomes[0]!.currency` a
      // few hundred lines down: `linkedIncomes.length === 0` already
      // returned above, so `[...linkedIncomes].sort(...)[0]` cannot be
      // undefined — `?.` here would silently accept a `never`-in-practice
      // path that mutation testing cannot tell apart from the real one
      // (security-review round 6, mutation-gate closure).
      salaryMonth: earliestLinkedIncome!.salaryMonth ?? null,
      txDate,
    }
    const counterpartyInfo = buildCounterpartyInfo(counterpartyRow)
    const verifyUrl = this.deps.buildVerifyUrl(payoutTx.id)
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

    // task-i18n-stage4-task6, Step 5: neutral legacy title (still required —
    // NOT NULL column, `NotificationsService`'s doc comment), amount/currency
    // now structured `data` instead of a hand-written Russian `body`.
    await this.notificationsService.create({
      userId: counterpartyRow.id,
      type: 'INVOICE_SIGN_REQUIRED',
      title: NOTIFICATION_TITLES.INVOICE_SIGN_REQUIRED,
      data: { amount: aggregatedAmount, currency: aggregatedCurrency },
      link: `/documents?category=INVOICE&openTx=${payoutTx.id}`,
    })

    this.logger.log(
      `autoCreateForPayout: PAYOUT=${payoutTx.id} req=${payoutTx.payoutRequestId} ` +
        `incomes=${linkedIncomes.length} projects=${projectNames.length} ` +
        `counterparty=${counterpartyRow.id} doc=${doc.id} hash=${sha256Hash.slice(0, 8)}`,
    )
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

    const counterpartyId = getCounterpartyId(tx)
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

    const adminId = await this.deps.getAdminId()
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
    const counterpartyInfo = buildCounterpartyInfo(counterpartyRow)
    const verifyUrl = this.deps.buildVerifyUrl(tx.id)

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
      title: NOTIFICATION_TITLES.INVOICE_SIGN_REQUIRED,
      data: { amount: tx.amount, currency: tx.currency },
      link: `/documents?category=INVOICE&openTx=${tx.id}`,
    })

    this.logger.log(
      `autoCreate: tx=${tx.id} type=${tx.type} counterparty=${counterpartyRow.id} doc=${doc.id} hash=${sha256Hash.slice(0, 8)}`,
    )
  }
}
