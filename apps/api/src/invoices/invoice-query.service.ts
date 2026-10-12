/**
 * InvoiceQueryService — read side of the Invoice Signing Epic, extracted from
 * InvoicesService (giant-decomposition leaf L4, behavior-preserving MOVE).
 *
 * Owns `listInvoices`, `getInvoice` (with the `assertCanViewInvoice` RBAC gate)
 * and `getSignaturesWithSignerNames`. Depends on `DatabaseService` only; the
 * InvoicesService facade keeps the public delegates and still calls
 * `getSignaturesWithSignerNames` from `signInvoice` / `verifyInvoice`.
 */
import { HttpStatus, Injectable } from '@nestjs/common'
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { InvoiceDto, InvoiceListFilters, InvoiceListItem, SessionUser } from '@crm/shared'
import { apiError } from '../common/api-error'
import { DatabaseService } from '../database/database.service'
import {
  invoiceSignatures,
  nonDeletedTransactions,
  transactions,
  users,
  type Transaction,
} from '../database/schema'
import { assertFoundAndVisible } from '../finance/transaction-visibility.util'
import { assertCanViewInvoice } from './invoice-view-access.util'
import {
  sortAndMapSignatureRows,
  toInvoiceDto,
  toInvoiceListItem,
  type SignatureWithSignerName,
} from './invoice-dto.util'

@Injectable()
export class InvoiceQueryService {
  constructor(private readonly db: DatabaseService) {}

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

    return rows.map(toInvoiceListItem)
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
      throw apiError('INVOICE_NOT_APPLICABLE_FOR_TX_TYPE', HttpStatus.NOT_FOUND)
    }
    if (!tx.invoiceDocumentId) {
      throw apiError('INVOICE_NOT_GENERATED_YET', HttpStatus.NOT_FOUND)
    }

    // RBAC: ADMIN + ACCOUNTANT pass; others must be the counterparty.
    assertCanViewInvoice(viewer, tx)

    const signatures = await this.getSignaturesWithSignerNames(tx.id)
    return toInvoiceDto(tx, tx.invoiceDocumentId, signatures)
  }

  /**
   * Fetch all signatures for a transaction + the signer's displayName. Sorted
   * deterministically (COMPANY first then COUNTERPARTY) so the PDF re-render
   * pass is reproducible.
   */
  async getSignaturesWithSignerNames(transactionId: string): Promise<SignatureWithSignerName[]> {
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

    return sortAndMapSignatureRows(rows)
  }
}
