import type {
  InvoiceDto,
  InvoiceListItem,
  InvoiceStatus,
  InvoiceType,
  InvoiceVerifyResponse,
} from '@crm/shared'
import { shortHash } from '../common/pdf/pdf.utils'
import type { Transaction } from '../database/schema'
import { COMPANY_BRAND_NAME } from './invoice-pdf.service'
import { getCounterpartyId } from './invoice-counterparty.util'

/** A signature row joined with the signer's display name (current invoice generation only). */
export interface SignatureWithSignerName {
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
}

/** Raw row shape selected by `getSignaturesWithSignerNames` before sorting/mapping. */
export interface SignatureRow {
  id: string
  transactionId: string
  signerRole: string
  signerId: string
  signerName: string | null
  signedAt: Date
  pdfHash: string
  method: string
  amountSnapshot: string | null
  currencySnapshot: string | null
}

/** Raw row shape selected by `listInvoices`. */
export interface InvoiceListRow {
  id: string
  type: string
  amount: string
  currency: InvoiceListItem['currency']
  counterpartyName: string | null
  signedFlag: boolean
  createdAt: Date
}

/** Transaction + joined relations as loaded by `getInvoice`. */
export type InvoiceDetailTx = Transaction & {
  receiver: { id: string; displayName: string } | null
  sender: { id: string; displayName: string } | null
  project: { name: string } | null
}

/**
 * Public InvoiceType is SENIOR_INCOME | SALARY. Aggregated PAYOUT invoices map
 * to SENIOR_INCOME so the UI label and existing filters keep working — the
 * aggregation is an implementation detail of the backend.
 */
export function toPublicInvoiceType(type: string): InvoiceType {
  return (type === 'PAYOUT' ? 'SENIOR_INCOME' : type) as InvoiceType
}

export function toInvoiceListItem(r: InvoiceListRow): InvoiceListItem {
  return {
    transactionId: r.id,
    status: (r.signedFlag ? 'SIGNED' : 'PENDING') as InvoiceStatus,
    type: toPublicInvoiceType(r.type),
    amount: r.amount,
    currency: r.currency,
    counterpartyName: r.counterpartyName ?? '—',
    createdAt: r.createdAt.toISOString(),
  }
}

/** `tx.invoiceDocumentId` must already be asserted non-null by the caller. */
export function toInvoiceDto(
  tx: InvoiceDetailTx,
  documentId: string,
  signatures: SignatureWithSignerName[],
): InvoiceDto {
  const status: InvoiceStatus = signatures.some((s) => s.signerRole === 'COUNTERPARTY')
    ? 'SIGNED'
    : 'PENDING'
  // Counterparty side for the DTO depends on the row's type — for PAYOUT
  // it's the sender (senior / drop), otherwise the receiver. See
  // `getCounterpartyId` for the canonical rule.
  const counterpartyUser = tx.type === 'PAYOUT' ? tx.sender : tx.receiver
  return {
    transactionId: tx.id,
    documentId,
    status,
    type: toPublicInvoiceType(tx.type),
    amount: tx.amount,
    currency: tx.currency,
    counterpartyId: counterpartyUser?.id ?? getCounterpartyId(tx) ?? '',
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

/**
 * Sort: COMPANY first (so the PDF always renders the same order) then
 * COUNTERPARTY. Within the same role we sort by signedAt for stability.
 */
export function sortAndMapSignatureRows(rows: SignatureRow[]): SignatureWithSignerName[] {
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

/**
 * Public verify signatures. CRITICAL: only public fields — strips ip /
 * user_agent / full hash. SEC-05: the COMPANY signer name is masked with the
 * brand constant so the admin's personal display name is never exposed to
 * unauthenticated callers.
 */
export function toPublicVerifySignatures(
  sigs: SignatureWithSignerName[],
): InvoiceVerifyResponse['signatures'] {
  return sigs.map((s) => ({
    role: s.signerRole,
    signerName: s.signerRole === 'COMPANY' ? COMPANY_BRAND_NAME : s.signerName,
    signedAt: s.signedAt.toISOString(),
    pdfHashShort: s.pdfHashShort,
  }))
}

/** FRONTEND_URL + /invoice/v/:id — used as the QR code payload. */
export function buildVerifyUrl(frontendUrl: string, transactionId: string): string {
  return `${frontendUrl}/invoice/v/${transactionId}`
}
