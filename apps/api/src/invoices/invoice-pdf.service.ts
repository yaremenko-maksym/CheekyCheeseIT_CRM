/**
 * InvoicePdfService — generates the signable invoice PDF for the two
 * transaction flows that require client-side counter-signing:
 *
 *   1. SENIOR_INCOME (senior payout to the company / company → senior IOU
 *      settlement) -> "АКТ ВЫПОЛНЕННЫХ РАБОТ"
 *   2. SALARY (company -> employee monthly salary) ->
 *      "ВЫПЛАТА ЗАРПЛАТЫ"
 *
 * task-drop-company-debt-and-invoices (PDF refresh):
 *   - Brand "Wedge Terminal" mark drawn in the header (left), brand
 *     wordmark "CheekyCheeseIT" right of the mark.
 *   - Admin personal names (Maksym / Kostya / Maksym Yaremenko) are NEVER
 *     rendered. The COMPANY signature shows only "CheekyCheeseIT".
 *   - Counterparty signature shows the contractor's display name.
 *   - Footer: "© <year> CheekyCheeseIT · verify URL".
 *
 * Two passes:
 *   - Auto-sign COMPANY: PDF generated with only the COMPANY signature
 *     block (brand name); "Ожидает подписи" placeholder for counterparty.
 *   - After counterparty click-sign: re-generated with both signature blocks
 *     including the 8-char short hash, timestamp, IP last-octet stamp.
 *
 * Fonts: pdf-lib's standard 14 fonts (Helvetica/Times/Courier) are AFM-encoded
 * with no Cyrillic glyphs. We ship Roboto Regular + Bold (Apache 2.0) under
 * `src/assets/fonts/`. pdf-lib needs `@pdf-lib/fontkit` registered on the doc
 * to embed custom TTFs; without it pdf-lib falls back to WinAnsi which
 * renders cyrillic as boxes.
 *
 * The generated PDF is purely a presentational record; the legal hook is the
 * `pdf_hash` (SHA-256 of these exact bytes) stored in `invoice_signatures`.
 * Therefore the layout must be deterministic: same input -> byte-identical
 * output. pdf-lib's CreationDate / ModDate metadata is randomised by default,
 * so we override both to the transaction-derived timestamp passed in.
 *
 * Phase 1 refactor (task-polish-7-pdf-generation-extraction):
 *   - Font loading, metadata pinning, QR embed, drawText, drawSeparator
 *     are now delegated to PdfGenerationService (common/pdf module).
 *   - Magic number constants replaced by PDF_COLORS + PDF_LAYOUT.
 *   - Public API generateSignableInvoicePdf unchanged (parameters + return).
 */
import { Injectable, Logger } from '@nestjs/common'
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, type Color } from 'pdf-lib'

import { sha256Hex, shortHash } from '../common/pdf/pdf.utils'
import { PDF_COLORS, PDF_LAYOUT } from '../common/pdf/pdf.constants'
import { PdfGenerationService } from '../common/pdf/pdf-generation.service'
import type { InvoiceSignerRole, InvoiceSignatureMethod } from '@crm/shared'

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/**
 * Side A (the company). Sourced from constants / env in real callers; passing
 * it in explicitly keeps the PDF service pure (no ConfigService coupling) and
 * makes tests trivial.
 */
export interface InvoiceCompanyInfo {
  name: string
  address: string
}

/**
 * Side B (the counterparty). `paymentMethod` mirrors the `users.payment_method`
 * column populated in PHASE 7. When `details` is empty the PDF falls back to
 * "Не указано, обратитесь к ADMIN" so we never silently ship a PDF with no
 * payment requisites.
 */
export interface InvoiceCounterpartyInfo {
  displayName: string
  /**
   * `CASH` is supported only for SALARY invoices — used when the company pays
   * an employee in cash and there are no payment requisites to render. In this
   * case `paymentDetails` is ignored and the renderer draws only a single
   * `Метод: Cash (<CCY>)` line (no requisites placeholder), where `<CCY>` is
   * the transaction currency (UAH / USD / EUR / USDT).
   */
  paymentMethod: 'USDT_ERC20' | 'BANK_UAH_FOP' | 'CASH' | null
  /** Free-form lines specific to the chosen method (wallet address, IBAN, etc.) */
  paymentDetails: string[]
}

/**
 * Subset of `Transaction` columns + joined fields needed for the PDF. We
 * accept an inline interface (rather than `TransactionWithRelations`) so the
 * service stays decoupled from Drizzle types; `invoices.service.ts` (Round 3)
 * will shape this object from a Drizzle query result.
 */
export interface InvoiceTransactionInfo {
  /** UUID, used to render the №, the verify URL and the deterministic ID. */
  id: string
  /** Only these two trigger an invoice. */
  type: 'SENIOR_INCOME' | 'SALARY'
  /** Decimal string (matches numeric serialization from the DB). */
  amount: string
  currency: 'USDT' | 'USD' | 'EUR' | 'UAH'
  /** Project name for SENIOR_INCOME; null/undefined for SALARY. Legacy:
   *  used by per-tx (non-aggregated) invoices; aggregated PAYOUT flow uses
   *  `projectNames` array instead. */
  projectName?: string | null
  /**
   * task-aggregate-invoice-per-payout round 2. Kept on the interface for
   * back-compat with the InvoicesService caller (which still passes it for
   * audit / logging), but the PDF body NEVER renders it: the description
   * block is intentionally limited to the contract reference + optional
   * period line. See `buildDescription` for the round-2 rationale.
   */
  projectNames?: string[] | null
  /**
   * task-aggregate-invoice-per-payout. When set, the «Описание услуг» block
   * renders «Услуги исполнителя согласно контракту № <contractNumber>» as the
   * primary line. Required for the new aggregated-PAYOUT flow; when null/
   * undefined the legacy «Доля по проекту X» description is used.
   * Placeholder formula in v1: `CHK-${userId.slice(0,8)}-${year}`. A dedicated
   * contracts module will replace the formula in a later phase.
   */
  contractNumber?: string | null
  /** YYYY-MM. Used in "Период: ..." line for both flows. */
  salaryMonth?: string | null
  /** Timestamp shown next to "Дата:", typically `tx_date ?? created_at`. */
  txDate: Date
}

/**
 * One signature row to be rendered. task-drop-company-debt-and-invoices:
 * `signerName` for COMPANY signatures is ignored — the PDF always renders
 * the brand "CheekyCheeseIT" so admin personal names never appear.
 */
export interface InvoiceSignatureInfo {
  role: InvoiceSignerRole
  signerName: string
  signedAt: Date
  method: InvoiceSignatureMethod
  /** Full 64-char SHA-256 hex from `invoice_signatures.pdf_hash`. Only the
   *  first 8 chars are rendered on the PDF (privacy + brevity). Optional;
   *  the first-pass (auto-COMPANY) invoice does not know its own hash yet. */
  pdfHashFull?: string
  /** IP last octet shown next to COUNTERPARTY name as a soft accountability
   *  signal. Optional and intentionally lossy (full IP never leaves the DB). */
  ipLastOctet?: string | null
}

/**
 * Brand name used in PDF signatures + footer. Replaces former admin
 * personal name renderings.
 *
 * Re-exported constant for backward compatibility — callers that import
 * COMPANY_BRAND_NAME from this module continue to compile unchanged.
 * The canonical source is PDF_BRAND.companyName in common/pdf/pdf.constants.ts.
 */
export const COMPANY_BRAND_NAME = 'CheekyCheeseIT'

/**
 * UAH equivalent block, pre-computed by the caller (Round 3 will call
 * `NbuCurrencyService.getRates(txDate)`). Optional: skip the line for UAH
 * transactions or when no rate is available.
 */
export interface InvoiceUahEquivalent {
  /** Already-formatted UAH amount, e.g. "50 432.10". */
  formatted: string
  /** Date string from NBU response, e.g. "26.05.2026". */
  rateDate: string
}

export interface GenerateSignableInvoiceParams {
  transaction: InvoiceTransactionInfo
  company: InvoiceCompanyInfo
  counterparty: InvoiceCounterpartyInfo
  signatures: InvoiceSignatureInfo[]
  /** Public verify URL, embedded as the QR code's payload. */
  verifyUrl: string
  /** Optional UAH equivalent block (skipped when currency = UAH). */
  uahEquivalent?: InvoiceUahEquivalent | null
}

export interface GenerateSignableInvoiceResult {
  pdfBuffer: Buffer
  sha256Hash: string
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class InvoicePdfService {
  private readonly logger = new Logger(InvoicePdfService.name)

  constructor(private readonly pdfGen: PdfGenerationService) {}

  /**
   * Render a signable invoice PDF and return its bytes + SHA-256.
   *
   * Determinism contract: same `params` -> byte-identical output -> same hash.
   * Achieved by (1) overriding pdf-lib's CreationDate/ModDate to the
   * transaction txDate via PdfGenerationService.applyDeterministicMetadata,
   * (2) explicitly passing `useObjectStreams: false` so pdf-lib doesn't add a
   * non-deterministic timestamp comment, (3) sorting signatures by role
   * (COMPANY first) before drawing.
   */
  async generateSignableInvoicePdf(
    params: GenerateSignableInvoiceParams,
  ): Promise<GenerateSignableInvoiceResult> {
    // task-fix-invoice-pdf-polish AC2: `company` is destructured for
    // back-compat with the InvoiceCompanyInfo struct shape but is no longer
    // rendered anywhere on the PDF (address line dropped from both header
    // and ИСПОЛНИТЕЛЬ block). Prefix with `_` so the unused-vars lint rule
    // recognises the intent.
    const { transaction, company: _company, counterparty, verifyUrl, uahEquivalent } = params

    // ----- Setup: delegate font embedding + doc creation to PdfGenerationService -----
    const {
      pdfDoc: doc,
      regularFont: fontRegular,
      boldFont: fontBold,
    } = await this.pdfGen.createDocument()

    // Pin metadata for determinism (delegates to PdfGenerationService which
    // sets CreationDate/ModDate + Producer/Creator from PDF_BRAND).
    this.pdfGen.applyDeterministicMetadata(doc, transaction.txDate)
    doc.setTitle(`Invoice ${transaction.id.slice(0, 8)}`)

    // A4 portrait in points (from PDF_LAYOUT constants)
    const pageWidth = PDF_LAYOUT.pageWidth
    const pageHeight = PDF_LAYOUT.pageHeight
    const page = doc.addPage([pageWidth, pageHeight])

    // ----- Layout constants (pulled from shared PDF_COLORS / PDF_LAYOUT) -----
    const layout = {
      margin: PDF_LAYOUT.pageMargin,
      contentWidth: PDF_LAYOUT.contentWidth,
      lineHeight: PDF_LAYOUT.lineHeight,
      sectionGap: PDF_LAYOUT.sectionGap,
      colors: {
        text: rgb(PDF_COLORS.text.r, PDF_COLORS.text.g, PDF_COLORS.text.b),
        muted: rgb(PDF_COLORS.muted.r, PDF_COLORS.muted.g, PDF_COLORS.muted.b),
        accent: rgb(PDF_COLORS.accent.r, PDF_COLORS.accent.g, PDF_COLORS.accent.b),
        brand: rgb(PDF_COLORS.brand.r, PDF_COLORS.brand.g, PDF_COLORS.brand.b),
        separator: rgb(PDF_COLORS.separator.r, PDF_COLORS.separator.g, PDF_COLORS.separator.b),
        warning: rgb(PDF_COLORS.warning.r, PDF_COLORS.warning.g, PDF_COLORS.warning.b),
        footer: rgb(PDF_COLORS.footer.r, PDF_COLORS.footer.g, PDF_COLORS.footer.b),
      },
    } as const

    let y = pageHeight - layout.margin

    // ----- Header: brand mark + wordmark -----
    const markSize = PDF_LAYOUT.brandMarkSize
    const markX = layout.margin
    const markY = y - markSize
    this.drawBrandMark(page, markX, markY, markSize, layout.colors.brand)

    this.pdfGen.drawText(page, COMPANY_BRAND_NAME, {
      x: markX + markSize + 12,
      y: markY + 11,
      font: fontBold,
      size: 16,
      color: layout.colors.text,
    })
    // task-fix-invoice-pdf-polish AC2: header-right address line removed.
    // The header now contains only the brand mark + wordmark. The `company`
    // param is still accepted (back-compat with `InvoicesService` callers)
    // but the address is never rendered. See the ИСПОЛНИТЕЛЬ block below
    // for the matching simplification.

    y -= markSize + 18
    y = this.pdfGen.drawSeparator(
      page,
      layout.margin,
      layout.margin + layout.contentWidth,
      y,
      layout.colors.separator,
    )

    // ----- Title + № + date row -----
    // task-fix-invoice-pdf-polish round 3 / AC2: rebalance the vertical
    // padding around the title. Round 2 left the title visually glued to the
    // header separator (no top breathing room) while leaving ~22pt below it
    // before the № / date row — net effect: title looked stitched to the
    // header. We now add 14pt of top padding and tighten the post-title
    // advance from 22pt to 16pt so the title sits centrally between the
    // header separator and the metadata row.
    y -= 14
    const title =
      transaction.type === 'SENIOR_INCOME' ? 'АКТ ВЫПОЛНЕННЫХ РАБОТ' : 'ВЫПЛАТА ЗАРПЛАТЫ'
    this.pdfGen.drawText(page, title, {
      x: layout.margin,
      y,
      font: fontBold,
      size: 18,
      color: layout.colors.text,
    })
    y -= 16

    const shortId = transaction.id.replace(/-/g, '').slice(0, 8)
    this.pdfGen.drawText(page, `№ ${shortId}`, {
      x: layout.margin,
      y,
      font: fontRegular,
      size: 11,
      color: layout.colors.muted,
    })
    const dateLabel = `Дата: ${this.formatDate(transaction.txDate)}`
    const dateWidth = fontRegular.widthOfTextAtSize(dateLabel, 11)
    this.pdfGen.drawText(page, dateLabel, {
      x: pageWidth - layout.margin - dateWidth,
      y,
      font: fontRegular,
      size: 11,
      color: layout.colors.muted,
    })
    y -= layout.lineHeight + 8

    y = this.pdfGen.drawSeparator(
      page,
      layout.margin,
      layout.margin + layout.contentWidth,
      y,
      layout.colors.separator,
    )

    // ----- ИСПОЛНИТЕЛЬ block -----
    // task-fix-invoice-pdf-polish AC2: render brand name only — no address,
    // email or other contact fields. The `company.address` value remains on
    // the InvoiceCompanyInfo struct for backward compatibility but is no
    // longer drawn anywhere on the PDF body.
    y = this.drawSectionHeader(page, 'ИСПОЛНИТЕЛЬ', y, layout, fontBold)
    y = this.drawLine(page, COMPANY_BRAND_NAME, y, layout, fontRegular)
    y -= 6
    y = this.pdfGen.drawSeparator(
      page,
      layout.margin,
      layout.margin + layout.contentWidth,
      y,
      layout.colors.separator,
    )

    // ----- ЗАКАЗЧИК block -----
    y = this.drawSectionHeader(page, 'ЗАКАЗЧИК', y, layout, fontBold)
    y = this.drawLine(page, counterparty.displayName, y, layout, fontRegular)
    if (counterparty.paymentMethod === null) {
      y = this.drawLine(
        page,
        'Реквизиты: Не указано, обратитесь к ADMIN',
        y,
        layout,
        fontRegular,
        layout.colors.warning,
      )
    } else if (counterparty.paymentMethod === 'CASH') {
      // CASH (SALARY only): no requisites to render. The currency suffix
      // disambiguates the payout currency at a glance — 35 000 UAH cash vs
      // $500 USD cash vs €400 EUR cash look very different to a stakeholder.
      // No "(без реквизитов)" hint is drawn — the absence of requisites lines
      // is itself the signal, and the muted hint was visual noise (round 2
      // user feedback on PR #81).
      y = this.drawLine(page, `Метод: Cash (${transaction.currency})`, y, layout, fontRegular)
    } else {
      const methodLabel =
        counterparty.paymentMethod === 'USDT_ERC20' ? 'USDT ERC-20' : 'Bank UAH (ФОП)'
      y = this.drawLine(page, `Метод: ${methodLabel}`, y, layout, fontRegular)
      for (const detail of counterparty.paymentDetails) {
        y = this.drawLine(page, detail, y, layout, fontRegular)
      }
    }
    y -= 6
    y = this.pdfGen.drawSeparator(
      page,
      layout.margin,
      layout.margin + layout.contentWidth,
      y,
      layout.colors.separator,
    )

    // ----- ОПИСАНИЕ УСЛУГИ block -----
    y = this.drawSectionHeader(page, 'ОПИСАНИЕ УСЛУГИ', y, layout, fontBold)
    const description = this.buildDescription(transaction)
    for (const line of description) {
      y = this.drawLine(page, line, y, layout, fontRegular)
    }
    y -= 6
    y = this.pdfGen.drawSeparator(
      page,
      layout.margin,
      layout.margin + layout.contentWidth,
      y,
      layout.colors.separator,
    )

    // ----- СУММА К ОПЛАТЕ block (large prominent amount) -----
    // task-fix-invoice-pdf-polish AC3 (round 2): the amount block must be
    // VERTICALLY SYMMETRIC — equal optical padding above and below the big
    // amount glyph. Previous round-1 layout had `y -= 16` above the amount
    // (inherited from drawSectionHeader's 14pt lineHeight + 2pt) but `y -= 22`
    // below it → the amount sat ~6pt closer to the section header than to the
    // UAH equivalent line, which read as a left-aligned crooked block in the
    // user's screenshot (02.06.2026 round 2).
    //
    // Fix: equalise both gaps by adding +4pt top-padding after the section
    // header and tightening the amount-to-UAH advance from 22pt → 18pt. Both
    // visual gaps now read as ~20pt and the block scans as a single centred
    // unit. Below the UAH line we keep the standard 14pt drawLine return +
    // 6pt margin before the separator so the next section breathes correctly.
    y = this.drawSectionHeader(page, 'СУММА К ОПЛАТЕ', y, layout, fontBold)
    // +4pt top-padding (over the drawSectionHeader's native 16pt) so the
    // distance from the section label baseline to the amount baseline (20pt)
    // matches the amount-to-UAH baseline distance below.
    y -= 4
    const amountLine = `${this.formatAmount(transaction.amount)} ${transaction.currency}`
    this.pdfGen.drawText(page, amountLine, {
      x: layout.margin,
      y,
      font: fontBold,
      size: 18,
      color: layout.colors.text,
    })
    // Symmetric 20pt advance (matches the 4pt+16pt above) so the amount glyph
    // sits dead-centre between its label and the UAH equiv line.
    y -= 20
    if (uahEquivalent && transaction.currency !== 'UAH') {
      const equivLine = `≈ ${uahEquivalent.formatted} UAH (курс НБУ ${uahEquivalent.rateDate})`
      y = this.drawLine(page, equivLine, y, layout, fontRegular, layout.colors.muted)
    }
    y -= 6
    y = this.pdfGen.drawSeparator(
      page,
      layout.margin,
      layout.margin + layout.contentWidth,
      y,
      layout.colors.separator,
    )

    // ----- ПОДПИСИ block -----
    y = this.drawSectionHeader(page, 'ПОДПИСИ', y, layout, fontBold)

    const sortedSignatures = [...params.signatures].sort((a, b) =>
      a.role === 'COMPANY' ? -1 : b.role === 'COMPANY' ? 1 : 0,
    )
    const companySig = sortedSignatures.find((s) => s.role === 'COMPANY')
    const counterpartySig = sortedSignatures.find((s) => s.role === 'COUNTERPARTY')

    y = this.drawCompanySignature(page, y, layout, fontBold, fontRegular, companySig)
    y -= 4
    y = this.drawCounterpartySignature(
      page,
      y,
      layout,
      fontBold,
      fontRegular,
      counterpartySig,
      counterparty.displayName,
    )
    y -= 4
    y = this.pdfGen.drawSeparator(
      page,
      layout.margin,
      layout.margin + layout.contentWidth,
      y,
      layout.colors.separator,
    )

    // ----- QR + verify link -----
    await this.drawVerifyBlock(page, doc, y, layout, fontRegular, verifyUrl)

    // ----- Footer -----
    const year = transaction.txDate.getUTCFullYear()
    const footerText = `© ${year} ${COMPANY_BRAND_NAME}`
    this.pdfGen.drawText(page, footerText, {
      x: layout.margin,
      y: layout.margin / 2,
      font: fontRegular,
      size: 9,
      color: layout.colors.footer,
    })
    const verifyShort = verifyUrl.replace(/^https?:\/\//, '')
    const verifyShortWidth = fontRegular.widthOfTextAtSize(verifyShort, 9)
    this.pdfGen.drawText(page, verifyShort, {
      x: pageWidth - layout.margin - verifyShortWidth,
      y: layout.margin / 2,
      font: fontRegular,
      size: 9,
      color: layout.colors.footer,
    })

    // ----- Save with deterministic options -----
    // useObjectStreams: false produces a slightly larger file but a more
    // diffable / hashable byte stream; pdf-lib's stream compression occasionally
    // varies offsets even for identical content.
    const pdfBytes = await doc.save({ useObjectStreams: false })
    const pdfBuffer = Buffer.from(pdfBytes)
    const hash = sha256Hex(pdfBuffer)

    this.logger.log(
      `Generated invoice PDF tx=${transaction.id} type=${transaction.type} ` +
        `size=${pdfBuffer.length}B hash=${hash.slice(0, 12)}`,
    )

    return { pdfBuffer, sha256Hash: hash }
  }

  // ---------------------------------------------------------------------------
  // Drawing helpers (invoice-specific)
  // ---------------------------------------------------------------------------

  /**
   * Draw the "Wedge Terminal" brand mark using pdf-lib's `drawSvgPath`.
   *
   * AC1 — task-fix-invoice-pdf-polish (round 2). Renders an EXACT byte-faithful
   * copy of the frontend `<BrandMark variant="flat" />` (see
   * `apps/web/app/components/brand-mark.tsx`) using the same SVG path data
   * (`viewBox 0 0 512 512`):
   *
   *   - Wedge body  : `M 112 112 L 422 215 A 18 18 0 0 1 432 233 …` (the
   *                   slanted top edge + rounded corners are reproduced — the
   *                   previous `drawRectangle` approach lost the slant and read
   *                   as a generic flat rectangle).
   *   - Holes (>_)  : three circles + one rounded-rect cursor pill, drawn in
   *                   the page background colour to read as cut-outs.
   *
   * pdf-lib 1.17 `drawSvgPath` supports M/L/A/C/Q/Z commands. It internally
   * flips the Y axis (`scale(s, -s)`) so SVG y-down draws upward in PDF.
   * The caller anchors at PDF coords `(x, y + size)` — the icon's top-left.
   *
   * IMPORTANT: hole shapes are filled with the page background (white). If
   * the invoice ever switches to a non-white background, the `bg` constant
   * must change in lockstep.
   */
  private drawBrandMark(page: PDFPage, x: number, y: number, size: number, color: Color): void {
    const scale = size / 512
    const anchorY = y + size
    const bg = rgb(1, 1, 1)

    // ---- 1. Wedge body — exact path copied from BrandMark.tsx (flat var.) ----
    const WEDGE_PATH =
      'M 112 112 L 422 215 A 18 18 0 0 1 432 233 L 432 402 A 18 18 0 0 1 414 416 L 110 416 A 18 18 0 0 1 96 398 L 96 124 A 18 18 0 0 1 112 112 Z'
    page.drawSvgPath(WEDGE_PATH, { x, y: anchorY, scale, color, borderWidth: 0 })

    // ---- 2. Punched-out chevron holes (`>_` terminal prompt) ----
    const circle = (cx: number, cy: number, r: number): string =>
      `M ${cx} ${cy - r} A ${r} ${r} 0 1 0 ${cx} ${cy + r} A ${r} ${r} 0 1 0 ${cx} ${cy - r} Z`
    const HOLES = [circle(190, 216, 25), circle(244, 274, 34), circle(190, 332, 25)]
    for (const path of HOLES) {
      page.drawSvgPath(path, { x, y: anchorY, scale, color: bg, borderWidth: 0 })
    }

    // ---- 3. Cursor pill — rounded rectangle (rx=13 in source SVG) ----
    const PILL_PATH =
      'M 315 258 L 373 258 A 13 13 0 0 1 386 271 L 386 277 A 13 13 0 0 1 373 290 L 315 290 A 13 13 0 0 1 302 277 L 302 271 A 13 13 0 0 1 315 258 Z'
    page.drawSvgPath(PILL_PATH, { x, y: anchorY, scale, color: bg, borderWidth: 0 })
  }

  private drawSectionHeader(
    page: PDFPage,
    title: string,
    y: number,
    layout: { margin: number; colors: { muted: Color }; lineHeight: number },
    fontBold: PDFFont,
  ): number {
    this.pdfGen.drawText(page, title, {
      x: layout.margin,
      y,
      font: fontBold,
      size: 9,
      color: layout.colors.muted,
    })
    return y - layout.lineHeight - 2
  }

  private drawLine(
    page: PDFPage,
    text: string,
    y: number,
    layout: { margin: number; colors: { text: Color }; lineHeight: number },
    fontRegular: PDFFont,
    color?: Color,
  ): number {
    this.pdfGen.drawText(page, text, {
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
  private drawCompanySignature(
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
  ): number {
    this.pdfGen.drawText(page, '1. От ИСПОЛНИТЕЛЯ', {
      x: layout.margin,
      y,
      font: fontBold,
      size: 11,
      color: layout.colors.text,
    })
    y -= layout.lineHeight + 2

    if (!sig) {
      this.pdfGen.drawText(page, '   Ожидает авто-подписи', {
        x: layout.margin,
        y,
        font: fontRegular,
        size: 11,
        color: layout.colors.muted,
      })
      return y - layout.lineHeight
    }

    // Brand name only — admin personal names must never appear on the PDF.
    this.pdfGen.drawText(page, `   ${COMPANY_BRAND_NAME}`, {
      x: layout.margin,
      y,
      font: fontRegular,
      size: 11,
      color: layout.colors.text,
    })
    y -= layout.lineHeight
    this.pdfGen.drawText(page, `   ${this.formatDateTime(sig.signedAt)}`, {
      x: layout.margin,
      y,
      font: fontRegular,
      size: 10,
      color: layout.colors.muted,
    })
    y -= layout.lineHeight
    const methodLabel =
      sig.method === 'AUTO_COMPANY' ? 'Автоматическая электронная' : 'Электронная click-подпись'
    this.pdfGen.drawText(page, `   Метод: ${methodLabel}`, {
      x: layout.margin,
      y,
      font: fontRegular,
      size: 10,
      color: layout.colors.muted,
    })
    return y - layout.lineHeight
  }

  private drawCounterpartySignature(
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
  ): number {
    this.pdfGen.drawText(page, '2. От ЗАКАЗЧИКА', {
      x: layout.margin,
      y,
      font: fontBold,
      size: 11,
      color: layout.colors.text,
    })
    y -= layout.lineHeight + 2

    if (!sig) {
      this.pdfGen.drawText(page, '   Ожидает подписи', {
        x: layout.margin,
        y,
        font: fontRegular,
        size: 11,
        color: layout.colors.warning,
      })
      this.pdfGen.drawText(page, `   (${fallbackName})`, {
        x: layout.margin,
        y: y - layout.lineHeight,
        font: fontRegular,
        size: 10,
        color: layout.colors.muted,
      })
      return y - layout.lineHeight * 2
    }

    this.pdfGen.drawText(page, `   ${sig.signerName}`, {
      x: layout.margin,
      y,
      font: fontRegular,
      size: 11,
      color: layout.colors.text,
    })
    y -= layout.lineHeight
    this.pdfGen.drawText(page, `   ${this.formatDateTime(sig.signedAt)}`, {
      x: layout.margin,
      y,
      font: fontRegular,
      size: 10,
      color: layout.colors.muted,
    })
    y -= layout.lineHeight

    if (sig.pdfHashFull) {
      const hashShort = shortHash(sig.pdfHashFull)
      this.pdfGen.drawText(page, `   Hash: ${hashShort}`, {
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

    const methodLabel =
      sig.method === 'AUTO_COMPANY' ? 'Автоматическая электронная' : 'Электронная click-подпись'
    this.pdfGen.drawText(page, `   Метод: ${methodLabel}`, {
      x: layout.margin,
      y,
      font: fontRegular,
      size: 10,
      color: layout.colors.muted,
    })
    return y - layout.lineHeight
  }

  private async drawVerifyBlock(
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
  ): Promise<void> {
    // Delegate QR PNG generation + embedding to PdfGenerationService.
    const qrImage = await this.pdfGen.embedQrPng(doc, verifyUrl)
    const qrSize = PDF_LAYOUT.qrSize
    const qrX = layout.margin
    const qrY = y - qrSize

    page.drawImage(qrImage, { x: qrX, y: qrY, width: qrSize, height: qrSize })

    const textX = qrX + qrSize + 14
    const textY = y - 16
    this.pdfGen.drawText(page, 'Проверить документ', {
      x: textX,
      y: textY,
      font: fontRegular,
      size: 10,
      color: layout.colors.muted,
    })
    this.pdfGen.drawText(page, verifyUrl, {
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
  private formatDate(d: Date): string {
    const dd = String(d.getUTCDate()).padStart(2, '0')
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
    const yyyy = d.getUTCFullYear()
    return `${dd}.${mm}.${yyyy}`
  }

  /** "26.05.2026 14:00:00 UTC", UTC for determinism. */
  private formatDateTime(d: Date): string {
    const date = this.formatDate(d)
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
  private formatAmount(amount: string): string {
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

  private buildDescription(tx: InvoiceTransactionInfo): string[] {
    if (tx.type === 'SENIOR_INCOME') {
      const lines: string[] = []
      // task-aggregate-invoice-per-payout round 2: the description must contain
      // ONLY the contract reference + (optional) period line. The list of
      // projects was previously rendered as a secondary «Проекты: A · B · C»
      // line, but user feedback (round 2, 02.06.2026) flagged it as noise — a
      // signed act covers the contractual scope, the per-project breakdown
      // lives in the linked transactions / payout receipt rather than the act
      // itself. We keep `projectNames` on the input interface for back-compat
      // with the InvoicesService caller (which still passes it for audit /
      // logging) but the PDF body never renders it.
      if (tx.contractNumber) {
        lines.push(`Услуги исполнителя согласно контракту № ${tx.contractNumber}`)
      } else if (tx.projectName) {
        // Legacy single-project per-tx invoices keep their original phrasing.
        lines.push(`Доля по проекту "${tx.projectName}"`)
      } else {
        // Aggregated PAYOUT with no signed contract on record — render em-dash
        // so the PDF has a contract reference line rather than a generic label.
        lines.push('Услуги исполнителя согласно контракту № —')
      }
      if (tx.salaryMonth) {
        lines.push(`Период: ${this.formatMonth(tx.salaryMonth)}`)
      }
      return lines
    }
    // SALARY
    const lines: string[] = []
    if (tx.salaryMonth) {
      lines.push(`Заработная плата сотрудника за ${this.formatMonth(tx.salaryMonth)}`)
    } else {
      lines.push('Заработная плата сотрудника')
    }
    return lines
  }

  /** "2026-05" -> "май 2026". Fallback to raw string on parse failure. */
  private formatMonth(yyyymm: string): string {
    const match = /^(\d{4})-(\d{2})$/.exec(yyyymm)
    if (!match) return yyyymm
    const yearStr = match[1]
    const monthStr = match[2]
    const monthIdx = Number(monthStr) - 1
    const months = [
      'январь',
      'февраль',
      'март',
      'апрель',
      'май',
      'июнь',
      'июль',
      'август',
      'сентябрь',
      'октябрь',
      'ноябрь',
      'декабрь',
    ]
    if (monthIdx < 0 || monthIdx >= months.length) return yyyymm
    return `${months[monthIdx]} ${yearStr}`
  }

  // ---------------------------------------------------------------------------
  // Standard fonts re-export, escape hatch for callers that want pdf-lib's
  // built-in fonts (currently unused but kept for forward-compat with the
  // Round 3 InvoicesService which may want to embed unicode strings into
  // signed-by metadata via a standard font fallback).
  // ---------------------------------------------------------------------------

  static readonly StandardFonts = StandardFonts
}
