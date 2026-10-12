/**
 * Pure draw/format helpers for the signable invoice PDF, extracted verbatim
 * from InvoicePdfService (size refactor, behavior-preserving).
 *
 * Free functions only: every dependency the old private methods read off
 * `this` (the PdfGenerationService drawing primitives) is an explicit
 * argument. Nothing here verifies or computes signatures — the verify URL and
 * the signature fields are inputs, rendered as given.
 */
import type { PDFDocument, PDFFont, PDFPage, Color } from 'pdf-lib'

import { shortHash } from '../common/pdf/pdf.utils'
import { PDF_LAYOUT } from '../common/pdf/pdf.constants'
import type { PdfGenerationService } from '../common/pdf/pdf-generation.service'
import {
  INVOICE_PDF_MESSAGES,
  INVOICE_PDF_MONTH_MESSAGES,
  type InvoiceSignatureMethod,
} from '@crm/shared'
import type { MessageDescriptor } from '@lingui/core'
import type { InvoiceSignatureInfo, InvoiceTransactionInfo } from './invoice-pdf.service'

/** Renders one catalog descriptor in the recipient's locale (bound per render). */
export type Translate = (descriptor: MessageDescriptor, values?: Record<string, unknown>) => string

/** The drawing primitives the helpers need from PdfGenerationService. */
export type PdfDrawer = Pick<PdfGenerationService, 'drawText' | 'embedQrPng'>

/**
 * Brand name used in PDF signatures + footer. Replaces former admin
 * personal name renderings.
 *
 * Re-exported by invoice-pdf.service.ts for backward compatibility — callers
 * that import COMPANY_BRAND_NAME from the service continue to compile unchanged.
 */
export const COMPANY_BRAND_NAME = 'CheekyCheeseIT'

// ---------------------------------------------------------------------------
// Drawing helpers (invoice-specific)
// ---------------------------------------------------------------------------

export function drawSectionHeader(
  pdfGen: PdfDrawer,
  page: PDFPage,
  title: string,
  y: number,
  layout: { margin: number; colors: { muted: Color }; lineHeight: number },
  fontBold: PDFFont,
): number {
  pdfGen.drawText(page, title, {
    x: layout.margin,
    y,
    font: fontBold,
    size: 9,
    color: layout.colors.muted,
  })
  return y - layout.lineHeight - 2
}

export function drawLine(
  pdfGen: PdfDrawer,
  page: PDFPage,
  text: string,
  y: number,
  layout: { margin: number; colors: { text: Color }; lineHeight: number },
  fontRegular: PDFFont,
  color?: Color,
): number {
  pdfGen.drawText(page, text, {
    x: layout.margin,
    y,
    font: fontRegular,
    size: 11,
    color: color ?? layout.colors.text,
  })
  return y - layout.lineHeight
}

/**
 * task-drop-company-debt-and-invoices. COMPANY signature renders the brand
 * "CheekyCheeseIT" only — never the underlying admin's personal name. The
 * `signerName` field on `sig` is intentionally ignored.
 */
export function drawCompanySignature(
  pdfGen: PdfDrawer,
  page: PDFPage,
  y: number,
  layout: {
    margin: number
    colors: { text: Color; muted: Color }
    lineHeight: number
  },
  fontBold: PDFFont,
  fontRegular: PDFFont,
  sig: InvoiceSignatureInfo | undefined,
  t: Translate,
): number {
  pdfGen.drawText(page, t(INVOICE_PDF_MESSAGES.signatureContractor), {
    x: layout.margin,
    y,
    font: fontBold,
    size: 11,
    color: layout.colors.text,
  })
  y -= layout.lineHeight + 2

  if (!sig) {
    pdfGen.drawText(page, `   ${t(INVOICE_PDF_MESSAGES.signaturePendingAuto)}`, {
      x: layout.margin,
      y,
      font: fontRegular,
      size: 11,
      color: layout.colors.muted,
    })
    return y - layout.lineHeight
  }

  // Brand name only — admin personal names must never appear on the PDF.
  pdfGen.drawText(page, `   ${COMPANY_BRAND_NAME}`, {
    x: layout.margin,
    y,
    font: fontRegular,
    size: 11,
    color: layout.colors.text,
  })
  y -= layout.lineHeight
  pdfGen.drawText(page, `   ${formatDateTime(sig.signedAt)}`, {
    x: layout.margin,
    y,
    font: fontRegular,
    size: 10,
    color: layout.colors.muted,
  })
  y -= layout.lineHeight
  pdfGen.drawText(page, `   ${signatureMethodLine(sig.method, t)}`, {
    x: layout.margin,
    y,
    font: fontRegular,
    size: 10,
    color: layout.colors.muted,
  })
  return y - layout.lineHeight
}

export function drawCounterpartySignature(
  pdfGen: PdfDrawer,
  page: PDFPage,
  y: number,
  layout: {
    margin: number
    colors: { text: Color; muted: Color; warning: Color }
    lineHeight: number
  },
  fontBold: PDFFont,
  fontRegular: PDFFont,
  sig: InvoiceSignatureInfo | undefined,
  fallbackName: string,
  t: Translate,
): number {
  pdfGen.drawText(page, t(INVOICE_PDF_MESSAGES.signatureClient), {
    x: layout.margin,
    y,
    font: fontBold,
    size: 11,
    color: layout.colors.text,
  })
  y -= layout.lineHeight + 2

  if (!sig) {
    pdfGen.drawText(page, `   ${t(INVOICE_PDF_MESSAGES.signaturePending)}`, {
      x: layout.margin,
      y,
      font: fontRegular,
      size: 11,
      color: layout.colors.warning,
    })
    pdfGen.drawText(page, `   (${fallbackName})`, {
      x: layout.margin,
      y: y - layout.lineHeight,
      font: fontRegular,
      size: 10,
      color: layout.colors.muted,
    })
    return y - layout.lineHeight * 2
  }

  pdfGen.drawText(page, `   ${sig.signerName}`, {
    x: layout.margin,
    y,
    font: fontRegular,
    size: 11,
    color: layout.colors.text,
  })
  y -= layout.lineHeight
  pdfGen.drawText(page, `   ${formatDateTime(sig.signedAt)}`, {
    x: layout.margin,
    y,
    font: fontRegular,
    size: 10,
    color: layout.colors.muted,
  })
  y -= layout.lineHeight

  if (sig.pdfHashFull) {
    const hashShort = shortHash(sig.pdfHashFull)
    pdfGen.drawText(page, `   Hash: ${hashShort}`, {
      x: layout.margin,
      y,
      font: fontRegular,
      size: 10,
      color: layout.colors.muted,
    })
    y -= layout.lineHeight
  }

  // task-fix-invoice-pdf-polish round 3 / AC1: the IP last-octet was
  // previously rendered as "IP: ...42" below the hash line. User feedback
  // (02.06.2026) flagged it as out of place in a customer-facing signature
  // block — the IP remains persisted on `invoice_signatures` for audit
  // purposes but is no longer drawn on the PDF. The `ipLastOctet` field
  // stays on the input interface so existing callers compile without
  // changes; the value is simply not rendered.

  pdfGen.drawText(page, `   ${signatureMethodLine(sig.method, t)}`, {
    x: layout.margin,
    y,
    font: fontRegular,
    size: 10,
    color: layout.colors.muted,
  })
  return y - layout.lineHeight
}

export async function drawVerifyBlock(
  pdfGen: PdfDrawer,
  page: PDFPage,
  doc: PDFDocument,
  y: number,
  layout: {
    margin: number
    colors: { text: Color; muted: Color; accent: Color }
    lineHeight: number
  },
  fontRegular: PDFFont,
  verifyUrl: string,
  t: Translate,
): Promise<void> {
  // Delegate QR PNG generation + embedding to PdfGenerationService.
  const qrImage = await pdfGen.embedQrPng(doc, verifyUrl)
  const qrSize = PDF_LAYOUT.qrSize
  const qrX = layout.margin
  const qrY = y - qrSize

  page.drawImage(qrImage, { x: qrX, y: qrY, width: qrSize, height: qrSize })

  const textX = qrX + qrSize + 14
  const textY = y - 16
  pdfGen.drawText(page, t(INVOICE_PDF_MESSAGES.verify), {
    x: textX,
    y: textY,
    font: fontRegular,
    size: 10,
    color: layout.colors.muted,
  })
  pdfGen.drawText(page, verifyUrl, {
    x: textX,
    y: textY - layout.lineHeight,
    font: fontRegular,
    size: 9,
    color: layout.colors.accent,
  })
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** "26.05.2026", DD.MM.YYYY in UTC to stay deterministic. */
export function formatDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const yyyy = d.getUTCFullYear()
  return `${dd}.${mm}.${yyyy}`
}

/** "26.05.2026 14:00:00 UTC", UTC for determinism. */
export function formatDateTime(d: Date): string {
  const date = formatDate(d)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mi = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')
  return `${date} ${hh}:${mi}:${ss} UTC`
}

/**
 * Format the numeric amount preserving up to 6 decimals (matches DB
 * `numeric(18,6)`). Trailing zeros are trimmed so "1234.567000" -> "1234.567"
 * but "1234.500000" -> "1234.50" (always keep at least 2 decimals for
 * readability).
 */
export function formatAmount(amount: string): string {
  const num = Number(amount)
  if (!Number.isFinite(num)) return amount
  const fixed = num.toFixed(6)
  // Trim trailing zeros but keep at least 2 decimals.
  const trimmed = fixed.replace(/(\.\d{2})\d*?0+$/, '$1').replace(/(\.\d*?[1-9])0+$/, '$1')
  // Thousand separators using a plain space.
  const [intPart, decPart] = trimmed.split('.')
  const withSep = (intPart ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return decPart !== undefined ? `${withSep}.${decPart}` : withSep
}

/**
 * "Method: <automatic electronic | electronic click signature>" — one message
 * for the line, one per method label, so a locale never reorders fragments.
 */
export function signatureMethodLine(method: InvoiceSignatureMethod, t: Translate): string {
  return t(INVOICE_PDF_MESSAGES.methodLine, {
    method: t(
      method === 'AUTO_COMPANY'
        ? INVOICE_PDF_MESSAGES.signatureMethodAuto
        : INVOICE_PDF_MESSAGES.signatureMethodClick,
    ),
  })
}

export function buildDescription(tx: InvoiceTransactionInfo, t: Translate): string[] {
  if (tx.type === 'SENIOR_INCOME') {
    const lines: string[] = []
    // task-aggregate-invoice-per-payout round 2: the description must contain
    // ONLY the contract reference + (optional) period line. The list of
    // projects was previously rendered as a secondary «Projects: A · B · C»
    // line, but user feedback (round 2, 02.06.2026) flagged it as noise — a
    // signed act covers the contractual scope, the per-project breakdown
    // lives in the linked transactions / payout receipt rather than the act
    // itself. We keep `projectNames` on the input interface for back-compat
    // with the InvoicesService caller (which still passes it for audit /
    // logging) but the PDF body never renders it.
    if (tx.contractNumber) {
      lines.push(t(INVOICE_PDF_MESSAGES.descriptionContract, { contractNumber: tx.contractNumber }))
    } else if (tx.projectName) {
      // Legacy single-project per-tx invoices keep their original phrasing.
      lines.push(t(INVOICE_PDF_MESSAGES.descriptionProject, { projectName: tx.projectName }))
    } else {
      // Aggregated PAYOUT with no signed contract on record — render em-dash
      // so the PDF has a contract reference line rather than a generic label.
      lines.push(t(INVOICE_PDF_MESSAGES.descriptionContract, { contractNumber: '—' }))
    }
    if (tx.salaryMonth) {
      lines.push(
        t(INVOICE_PDF_MESSAGES.descriptionPeriod, {
          period: formatPeriod(tx.salaryMonth, t),
        }),
      )
    }
    return lines
  }
  // SALARY
  const lines: string[] = []
  if (tx.salaryMonth) {
    lines.push(
      t(INVOICE_PDF_MESSAGES.descriptionSalaryForPeriod, {
        period: formatPeriod(tx.salaryMonth, t),
      }),
    )
  } else {
    lines.push(t(INVOICE_PDF_MESSAGES.descriptionSalary))
  }
  return lines
}

/**
 * "2026-05" -> "травень 2026" / "May 2026" (month name from the catalog, the
 * month-year order from the `period` message). Fallback to the raw string on
 * parse failure or an out-of-range month — never "undefined 2026".
 */
export function formatPeriod(yyyymm: string, t: Translate): string {
  const match = /^(\d{4})-(\d{2})$/.exec(yyyymm)
  if (!match) return yyyymm
  const monthKey = match[2] as string
  if (!(monthKey in INVOICE_PDF_MONTH_MESSAGES)) return yyyymm
  const descriptor = INVOICE_PDF_MONTH_MESSAGES[monthKey as keyof typeof INVOICE_PDF_MONTH_MESSAGES]
  return t(INVOICE_PDF_MESSAGES.period, { month: t(descriptor), year: match[1] })
}
