/**
 * InvoicePdfService — generates the signable invoice PDF for the two
 * transaction flows that require client-side counter-signing:
 *
 *   1. SENIOR_INCOME (senior payout to the company / company → senior IOU
 *      settlement) -> the "act of services rendered"
 *   2. SALARY (company -> employee monthly salary) -> the "salary payment"
 *
 * i18n stage 5: every label is rendered in the RECIPIENT's locale
 * (`counterparty.locale` = the counterparty's `users.locale`) from the
 * `INVOICE_PDF_MESSAGES` catalog (`@crm/shared`) through a per-call
 * `createI18n(locale)` — never a global/active locale, so two concurrent
 * renders for recipients with different locales cannot bleed into each other.
 * Amounts, dates, the № short id, hash, verify URL, brand and the COMPANY
 * signature mask are data, not words, and are byte-identical across locales.
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
 *     block (brand name); "awaiting signature" placeholder for counterparty.
 *   - After counterparty click-sign: re-generated with both signature blocks
 *     including the 8-char short hash, timestamp, IP last-octet stamp.
 *
 * Fonts: pdf-lib's standard 14 fonts (Helvetica/Times/Courier) are AFM-encoded
 * with no Cyrillic glyphs. We ship Roboto Regular + Bold (Apache 2.0) under
 * `src/assets/fonts/` — the files carry the full Ukrainian alphabet (і ї є ґ)
 * and Latin (pinned by `invoice-pdf.locale.spec.ts`). pdf-lib needs `@pdf-lib/fontkit` registered on the doc
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
import { StandardFonts, rgb } from 'pdf-lib'

import { sha256Hex } from '../common/pdf/pdf.utils'
import { PDF_COLORS, PDF_LAYOUT } from '../common/pdf/pdf.constants'
import { PdfGenerationService } from '../common/pdf/pdf-generation.service'
import {
  INVOICE_PDF_MESSAGES,
  createI18n,
  renderMessage,
  type InvoiceSignerRole,
  type InvoiceSignatureMethod,
  type Locale,
} from '@crm/shared'
import {
  COMPANY_BRAND_NAME,
  buildDescription,
  drawCompanySignature,
  drawCounterpartySignature,
  drawLine,
  drawSectionHeader,
  drawVerifyBlock,
  formatAmount,
  formatDate,
  type Translate,
} from './invoice-pdf-render.util'

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
 * a "not provided, contact the administrator" line so we never silently ship a PDF with no
 * payment requisites.
 */
export interface InvoiceCounterpartyInfo {
  displayName: string
  /**
   * i18n stage 5. The RECIPIENT's locale (`users.locale` of this very
   * counterparty) — the language every label on the PDF is rendered in.
   * Required (not optional): a caller that forgets it must fail to compile
   * rather than silently ship every invoice in the default locale.
   */
  locale: Locale
  /**
   * `CASH` is supported only for SALARY invoices — used when the company pays
   * an employee in cash and there are no payment requisites to render. In this
   * case `paymentDetails` is ignored and the renderer draws only a single
   * localized "Method: cash (<CCY>)" line (no requisites placeholder), where `<CCY>` is
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
   * task-aggregate-invoice-per-payout. When set, the service-description block
   * renders the "services under contract № <contractNumber>" sentence as the
   * primary line. Required for the new aggregated-PAYOUT flow; when null/
   * undefined the legacy "share of project X" description is used.
   * Placeholder formula in v1: `CHK-${userId.slice(0,8)}-${year}`. A dedicated
   * contracts module will replace the formula in a later phase.
   */
  contractNumber?: string | null
  /** YYYY-MM. Used in the "Period: ..." line for both flows. */
  salaryMonth?: string | null
  /** Timestamp shown next to the date label, typically `tx_date ?? created_at`. */
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

// Re-exported for backward compatibility — callers that import
// COMPANY_BRAND_NAME from this module continue to compile unchanged.
// The constant now lives in invoice-pdf-render.util.ts.
export { COMPANY_BRAND_NAME }

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
    // and contractor block). Prefix with `_` so the unused-vars lint rule
    // recognises the intent.
    const { transaction, company: _company, counterparty, verifyUrl, uahEquivalent } = params

    // One i18n instance per render, in the recipient's locale. Everything
    // wordy below goes through `t`; nothing is concatenated from fragments.
    const i18n = createI18n(counterparty.locale)
    const t: Translate = (descriptor, values) => renderMessage(i18n, descriptor, values)

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
    this.pdfGen.drawBrandMark(page, markX, markY, markSize, layout.colors.brand)

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
    // but the address is never rendered. See the contractor block below
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
    const title = t(
      transaction.type === 'SENIOR_INCOME'
        ? INVOICE_PDF_MESSAGES.titleAct
        : INVOICE_PDF_MESSAGES.titleSalary,
    )
    this.pdfGen.drawText(page, title, {
      x: layout.margin,
      y,
      font: fontBold,
      size: 18,
      color: layout.colors.text,
    })
    y -= 16

    const shortId = transaction.id.replace(/-/g, '').slice(0, 8)
    this.pdfGen.drawText(page, t(INVOICE_PDF_MESSAGES.number, { number: shortId }), {
      x: layout.margin,
      y,
      font: fontRegular,
      size: 11,
      color: layout.colors.muted,
    })
    const dateLabel = t(INVOICE_PDF_MESSAGES.date, { date: formatDate(transaction.txDate) })
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

    // ----- Contractor block -----
    // task-fix-invoice-pdf-polish AC2: render brand name only — no address,
    // email or other contact fields. The `company.address` value remains on
    // the InvoiceCompanyInfo struct for backward compatibility but is no
    // longer drawn anywhere on the PDF body.
    y = drawSectionHeader(
      this.pdfGen,
      page,
      t(INVOICE_PDF_MESSAGES.sectionContractor),
      y,
      layout,
      fontBold,
    )
    y = drawLine(this.pdfGen, page, COMPANY_BRAND_NAME, y, layout, fontRegular)
    y -= 6
    y = this.pdfGen.drawSeparator(
      page,
      layout.margin,
      layout.margin + layout.contentWidth,
      y,
      layout.colors.separator,
    )

    // ----- Client block -----
    y = drawSectionHeader(
      this.pdfGen,
      page,
      t(INVOICE_PDF_MESSAGES.sectionClient),
      y,
      layout,
      fontBold,
    )
    y = drawLine(this.pdfGen, page, counterparty.displayName, y, layout, fontRegular)
    if (counterparty.paymentMethod === null) {
      y = drawLine(
        this.pdfGen,
        page,
        t(INVOICE_PDF_MESSAGES.requisitesMissing),
        y,
        layout,
        fontRegular,
        layout.colors.warning,
      )
    } else if (counterparty.paymentMethod === 'CASH') {
      // CASH (SALARY only): no requisites to render. The currency suffix
      // disambiguates the payout currency at a glance — 35 000 UAH cash vs
      // $500 USD cash vs €400 EUR cash look very different to a stakeholder.
      // No "(no requisites)" hint is drawn — the absence of requisites lines
      // is itself the signal, and the muted hint was visual noise (round 2
      // user feedback on PR #81).
      y = drawLine(
        this.pdfGen,
        page,
        t(INVOICE_PDF_MESSAGES.methodLine, {
          method: t(INVOICE_PDF_MESSAGES.methodCash, { currency: transaction.currency }),
        }),
        y,
        layout,
        fontRegular,
      )
    } else {
      // 'USDT ERC-20' is a network/token code, not a word — never translated.
      const methodLabel =
        counterparty.paymentMethod === 'USDT_ERC20'
          ? 'USDT ERC-20'
          : t(INVOICE_PDF_MESSAGES.methodBankUahFop)
      y = drawLine(
        this.pdfGen,
        page,
        t(INVOICE_PDF_MESSAGES.methodLine, { method: methodLabel }),
        y,
        layout,
        fontRegular,
      )
      for (const detail of counterparty.paymentDetails) {
        y = drawLine(this.pdfGen, page, detail, y, layout, fontRegular)
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

    // ----- Service description block -----
    y = drawSectionHeader(
      this.pdfGen,
      page,
      t(INVOICE_PDF_MESSAGES.sectionDescription),
      y,
      layout,
      fontBold,
    )
    const description = buildDescription(transaction, t)
    for (const line of description) {
      y = drawLine(this.pdfGen, page, line, y, layout, fontRegular)
    }
    y -= 6
    y = this.pdfGen.drawSeparator(
      page,
      layout.margin,
      layout.margin + layout.contentWidth,
      y,
      layout.colors.separator,
    )

    // ----- Amount due block (large prominent amount) -----
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
    y = drawSectionHeader(
      this.pdfGen,
      page,
      t(INVOICE_PDF_MESSAGES.sectionAmount),
      y,
      layout,
      fontBold,
    )
    // +4pt top-padding (over the drawSectionHeader's native 16pt) so the
    // distance from the section label baseline to the amount baseline (20pt)
    // matches the amount-to-UAH baseline distance below.
    y -= 4
    const amountLine = `${formatAmount(transaction.amount)} ${transaction.currency}`
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
      const equivLine = t(INVOICE_PDF_MESSAGES.uahEquivalent, {
        amount: uahEquivalent.formatted,
        rateDate: uahEquivalent.rateDate,
      })
      y = drawLine(this.pdfGen, page, equivLine, y, layout, fontRegular, layout.colors.muted)
    }
    y -= 6
    y = this.pdfGen.drawSeparator(
      page,
      layout.margin,
      layout.margin + layout.contentWidth,
      y,
      layout.colors.separator,
    )

    // ----- Signatures block -----
    y = drawSectionHeader(
      this.pdfGen,
      page,
      t(INVOICE_PDF_MESSAGES.sectionSignatures),
      y,
      layout,
      fontBold,
    )

    const sortedSignatures = [...params.signatures].sort((a, b) =>
      a.role === 'COMPANY' ? -1 : b.role === 'COMPANY' ? 1 : 0,
    )
    const companySig = sortedSignatures.find((s) => s.role === 'COMPANY')
    const counterpartySig = sortedSignatures.find((s) => s.role === 'COUNTERPARTY')

    y = drawCompanySignature(this.pdfGen, page, y, layout, fontBold, fontRegular, companySig, t)
    y -= 4
    y = drawCounterpartySignature(
      this.pdfGen,
      page,
      y,
      layout,
      fontBold,
      fontRegular,
      counterpartySig,
      counterparty.displayName,
      t,
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
    await drawVerifyBlock(this.pdfGen, page, doc, y, layout, fontRegular, verifyUrl, t)

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
  // Standard fonts re-export, escape hatch for callers that want pdf-lib's
  // built-in fonts (currently unused but kept for forward-compat with the
  // Round 3 InvoicesService which may want to embed unicode strings into
  // signed-by metadata via a standard font fallback).
  // ---------------------------------------------------------------------------

  static readonly StandardFonts = StandardFonts
}
