/**
 * InvoicePdfService — generates the signable invoice PDF for the two
 * transaction flows that require client-side counter-signing:
 *
 *   1. SENIOR_INCOME (74% senior payout to the company smart contract) ->
 *      "АКТ ВЫПОЛНЕННЫХ РАБОТ"
 *   2. SALARY (company -> employee monthly salary) ->
 *      "ВЫПЛАТА ЗАРПЛАТЫ"
 *
 * Two passes:
 *   - Auto-sign COMPANY: PDF generated with only the ADMIN signature block;
 *     "Ожидает подписи" placeholder where the counterparty will sign.
 *   - After counterparty click-sign: re-generated with both signature blocks
 *     including the 8-char short hash, timestamp, IP last-octet stamp.
 *
 * Why a dedicated service (instead of extending existing `pdf-invoice.service`):
 * the existing finance module has NO such file (only `etherscan.service`,
 * `nbu-currency.service`, `salary-cron.service`, `transactions.*`). PDFs are
 * touched today only by `documents/compression.service.ts` which optimises
 * incoming PDF uploads, completely orthogonal. Creating a new service inside
 * `invoices/` keeps the upcoming `invoices.service.ts` (Round 3) and its PDF
 * dependency colocated and avoids leaking PDF concerns into FinanceModule.
 *
 * Fonts: pdf-lib's standard 14 fonts (Helvetica/Times/Courier) are AFM-encoded
 * with no Cyrillic glyphs. We ship Roboto Regular + Bold (Apache 2.0) under
 * `src/assets/fonts/`. pdf-lib needs `@pdf-lib/fontkit` registered on the doc
 * to embed custom TTFs; that bit is easy to miss; without it pdf-lib falls
 * back to WinAnsi which renders cyrillic as boxes.
 *
 * The generated PDF is purely a presentational record; the legal hook is the
 * `pdf_hash` (SHA-256 of these exact bytes) stored in `invoice_signatures`.
 * Therefore the layout must be deterministic: same input -> byte-identical
 * output. pdf-lib's CreationDate / ModDate metadata is randomised by default,
 * so we override both to the transaction-derived timestamp passed in.
 */
import { Injectable, Logger } from '@nestjs/common'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, type Color } from 'pdf-lib'
// IMPORTANT: pdf-lib re-exports fontkit only via the dedicated package. Custom
// font embedding silently breaks otherwise.
import fontkit from '@pdf-lib/fontkit'
import QRCode from 'qrcode'

import { sha256Hex, shortHash } from './invoice-pdf.utils'
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
  paymentMethod: 'USDT_ERC20' | 'BANK_UAH_FOP' | null
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
  /** Project name for SENIOR_INCOME; null/undefined for SALARY. */
  projectName?: string | null
  /** YYYY-MM. Used in "Период: ..." line for both flows. */
  salaryMonth?: string | null
  /** Timestamp shown next to "Дата:", typically `tx_date ?? created_at`. */
  txDate: Date
}

/**
 * One signature row to be rendered. The PDF service stays unaware of the DB;
 * the caller (Round 3 InvoicesService) joins `users` to provide `signerName`.
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

/**
 * Resolves the bundled font under `src/assets/fonts/` whether the code runs
 * from `src/` (Vitest, tsx) or from `dist/` (production `node`). Nest CLI
 * mirrors `src/assets/...` -> `dist/assets/...` (see nest-cli.json), so the
 * same relative path works in both layouts.
 */
function resolveFontPath(filename: string): string {
  return resolve(__dirname, '..', 'assets', 'fonts', filename)
}

@Injectable()
export class InvoicePdfService {
  private readonly logger = new Logger(InvoicePdfService.name)

  // Cache the .ttf bytes once per process; they never change and re-reading
  // the disk on every invoice would burn ~300 KB x N requests for no reason.
  private fontRegularBytes: Buffer | null = null
  private fontBoldBytes: Buffer | null = null

  /**
   * Render a signable invoice PDF and return its bytes + SHA-256.
   *
   * Determinism contract: same `params` -> byte-identical output -> same hash.
   * Achieved by (1) overriding pdf-lib's CreationDate/ModDate to the
   * transaction txDate, (2) explicitly passing `useObjectStreams: false` so
   * pdf-lib doesn't add a non-deterministic timestamp comment, (3) sorting
   * the signatures by role (COMPANY first) before drawing.
   */
  async generateSignableInvoicePdf(
    params: GenerateSignableInvoiceParams,
  ): Promise<GenerateSignableInvoiceResult> {
    const { transaction, company, counterparty, verifyUrl, uahEquivalent } = params

    // ----- Setup -----
    const doc = await PDFDocument.create()
    doc.registerFontkit(fontkit)

    const regularBytes = await this.loadRegularFont()
    const boldBytes = await this.loadBoldFont()
    const fontRegular = await doc.embedFont(regularBytes, { subset: true })
    const fontBold = await doc.embedFont(boldBytes, { subset: true })

    // Pin metadata for determinism. pdf-lib uses `new Date()` by default which
    // would defeat the hash-equality contract relied on by the verify path.
    doc.setCreationDate(transaction.txDate)
    doc.setModificationDate(transaction.txDate)
    doc.setTitle(`Invoice ${transaction.id.slice(0, 8)}`)
    doc.setProducer('CheekyCheese IT CRM')
    doc.setCreator('CheekyCheese IT CRM')

    // A4 portrait in points: 595.28 x 841.89
    const page = doc.addPage([595.28, 841.89])

    // ----- Layout constants -----
    const layout = {
      margin: 50,
      contentWidth: 595.28 - 100,
      lineHeight: 14,
      sectionGap: 18,
      colors: {
        text: rgb(0.1, 0.1, 0.12),
        muted: rgb(0.45, 0.45, 0.5),
        accent: rgb(0.15, 0.35, 0.7),
        separator: rgb(0.85, 0.85, 0.88),
        warning: rgb(0.85, 0.55, 0.1),
      },
    } as const

    let y = 841.89 - layout.margin

    // ----- Header (brand) -----
    this.drawText(page, company.name, {
      x: layout.margin,
      y,
      font: fontBold,
      size: 18,
      color: layout.colors.text,
    })
    y -= 24

    // ----- Title -----
    const title =
      transaction.type === 'SENIOR_INCOME' ? 'АКТ ВЫПОЛНЕННЫХ РАБОТ' : 'ВЫПЛАТА ЗАРПЛАТЫ'
    this.drawText(page, title, {
      x: layout.margin,
      y,
      font: fontBold,
      size: 16,
      color: layout.colors.accent,
    })
    y -= 22

    // ----- Number + Date row -----
    const shortId = transaction.id.replace(/-/g, '').slice(0, 8)
    this.drawText(page, `№: ${shortId}`, {
      x: layout.margin,
      y,
      font: fontRegular,
      size: 11,
      color: layout.colors.text,
    })
    this.drawText(page, `Дата: ${this.formatDate(transaction.txDate)}`, {
      x: layout.margin + 250,
      y,
      font: fontRegular,
      size: 11,
      color: layout.colors.text,
    })
    y -= layout.lineHeight + 4

    y = this.drawSeparator(page, y, layout)

    // ----- ИСПОЛНИТЕЛЬ block -----
    y = this.drawSectionHeader(page, 'ИСПОЛНИТЕЛЬ:', y, layout, fontBold)
    y = this.drawLine(page, company.name, y, layout, fontRegular)
    y = this.drawLine(page, `Адрес: ${company.address}`, y, layout, fontRegular)
    y -= 4
    y = this.drawSeparator(page, y, layout)

    // ----- ЗАКАЗЧИК block -----
    y = this.drawSectionHeader(page, 'ЗАКАЗЧИК:', y, layout, fontBold)
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
    } else {
      const methodLabel = counterparty.paymentMethod === 'USDT_ERC20' ? 'USDT ERC-20' : 'ФОП UAH'
      y = this.drawLine(page, `Метод: ${methodLabel}`, y, layout, fontRegular)
      for (const detail of counterparty.paymentDetails) {
        y = this.drawLine(page, detail, y, layout, fontRegular)
      }
    }
    y -= 4
    y = this.drawSeparator(page, y, layout)

    // ----- ОПИСАНИЕ УСЛУГИ block -----
    y = this.drawSectionHeader(page, 'ОПИСАНИЕ УСЛУГИ:', y, layout, fontBold)
    const description = this.buildDescription(transaction)
    for (const line of description) {
      y = this.drawLine(page, line, y, layout, fontRegular)
    }
    y -= 4
    y = this.drawSeparator(page, y, layout)

    // ----- СУММА К ОПЛАТЕ block -----
    y = this.drawSectionHeader(page, 'СУММА К ОПЛАТЕ:', y, layout, fontBold)
    const amountLine = `${this.formatAmount(transaction.amount)} ${transaction.currency}`
    this.drawText(page, amountLine, {
      x: layout.margin,
      y,
      font: fontBold,
      size: 14,
      color: layout.colors.accent,
    })
    y -= 18
    if (
      uahEquivalent &&
      transaction.currency !== 'UAH' // skip when transaction itself is UAH
    ) {
      const equivLine = `(приблизительно ${uahEquivalent.formatted} UAH по курсу НБУ ${uahEquivalent.rateDate})`
      y = this.drawLine(page, equivLine, y, layout, fontRegular, layout.colors.muted)
    }
    y -= 4
    y = this.drawSeparator(page, y, layout)

    // ----- ПОДПИСИ block -----
    y = this.drawSectionHeader(page, 'ПОДПИСИ:', y, layout, fontBold)

    // Always render the COMPANY slot first, COUNTERPARTY second. Sort the
    // input so a caller swapping the array order can't change the PDF bytes
    // (would break the hash determinism contract).
    const sortedSignatures = [...params.signatures].sort((a, b) =>
      a.role === 'COMPANY' ? -1 : b.role === 'COMPANY' ? 1 : 0,
    )
    const companySig = sortedSignatures.find((s) => s.role === 'COMPANY')
    const counterpartySig = sortedSignatures.find((s) => s.role === 'COUNTERPARTY')

    y = this.drawCompanySignature(page, y, layout, fontBold, fontRegular, companySig)
    y -= 6
    y = this.drawCounterpartySignature(page, y, layout, fontBold, fontRegular, counterpartySig)
    y -= 6
    y = this.drawSeparator(page, y, layout)

    // ----- QR + verify link -----
    await this.drawVerifyBlock(page, doc, y, layout, fontRegular, verifyUrl)

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
  // Font loading
  // ---------------------------------------------------------------------------

  private async loadRegularFont(): Promise<Buffer> {
    if (this.fontRegularBytes) return this.fontRegularBytes
    const path = resolveFontPath('Roboto-Regular.ttf')
    this.fontRegularBytes = readFileSync(path)
    this.logger.debug(`Loaded font Regular: ${this.fontRegularBytes.length}B from ${path}`)
    return this.fontRegularBytes
  }

  private async loadBoldFont(): Promise<Buffer> {
    if (this.fontBoldBytes) return this.fontBoldBytes
    const path = resolveFontPath('Roboto-Bold.ttf')
    this.fontBoldBytes = readFileSync(path)
    this.logger.debug(`Loaded font Bold: ${this.fontBoldBytes.length}B from ${path}`)
    return this.fontBoldBytes
  }

  // ---------------------------------------------------------------------------
  // Drawing helpers
  // ---------------------------------------------------------------------------

  private drawText(
    page: PDFPage,
    text: string,
    opts: { x: number; y: number; font: PDFFont; size: number; color: Color },
  ): void {
    page.drawText(text, {
      x: opts.x,
      y: opts.y,
      size: opts.size,
      font: opts.font,
      color: opts.color,
    })
  }

  /** Draws a horizontal separator and returns the new `y` cursor. */
  private drawSeparator(
    page: PDFPage,
    y: number,
    layout: { margin: number; contentWidth: number; colors: { separator: Color } },
  ): number {
    page.drawLine({
      start: { x: layout.margin, y },
      end: { x: layout.margin + layout.contentWidth, y },
      thickness: 0.5,
      color: layout.colors.separator,
    })
    return y - 12
  }

  private drawSectionHeader(
    page: PDFPage,
    title: string,
    y: number,
    layout: { margin: number; colors: { muted: Color }; lineHeight: number },
    fontBold: PDFFont,
  ): number {
    this.drawText(page, title, {
      x: layout.margin,
      y,
      font: fontBold,
      size: 10,
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
    this.drawText(page, text, {
      x: layout.margin,
      y,
      font: fontRegular,
      size: 11,
      color: color ?? layout.colors.text,
    })
    return y - layout.lineHeight
  }

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
    this.drawText(page, '1. От ИСПОЛНИТЕЛЯ:', {
      x: layout.margin,
      y,
      font: fontBold,
      size: 11,
      color: layout.colors.text,
    })
    y -= layout.lineHeight + 2

    if (!sig) {
      // Should never happen; the caller always passes COMPANY signature in
      // the PDF that exists (AUTO_COMPANY is the first thing to happen).
      this.drawText(page, '   Ожидает авто-подписи', {
        x: layout.margin,
        y,
        font: fontRegular,
        size: 11,
        color: layout.colors.muted,
      })
      return y - layout.lineHeight
    }

    const name = sig.signerName || 'ADMIN'
    this.drawText(page, `   ${name} (ADMIN)`, {
      x: layout.margin,
      y,
      font: fontRegular,
      size: 11,
      color: layout.colors.text,
    })
    y -= layout.lineHeight
    this.drawText(page, `   ${this.formatDateTime(sig.signedAt)}`, {
      x: layout.margin,
      y,
      font: fontRegular,
      size: 10,
      color: layout.colors.muted,
    })
    y -= layout.lineHeight
    const methodLabel =
      sig.method === 'AUTO_COMPANY' ? 'Автоматическая электронная' : 'Электронная click-подпись'
    this.drawText(page, `   Метод: ${methodLabel}`, {
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
  ): number {
    this.drawText(page, '2. От ЗАКАЗЧИКА:', {
      x: layout.margin,
      y,
      font: fontBold,
      size: 11,
      color: layout.colors.text,
    })
    y -= layout.lineHeight + 2

    if (!sig) {
      this.drawText(page, '   Ожидает подписи', {
        x: layout.margin,
        y,
        font: fontRegular,
        size: 11,
        color: layout.colors.warning,
      })
      return y - layout.lineHeight
    }

    this.drawText(page, `   ${sig.signerName}`, {
      x: layout.margin,
      y,
      font: fontRegular,
      size: 11,
      color: layout.colors.text,
    })
    y -= layout.lineHeight
    this.drawText(page, `   ${this.formatDateTime(sig.signedAt)}`, {
      x: layout.margin,
      y,
      font: fontRegular,
      size: 10,
      color: layout.colors.muted,
    })
    y -= layout.lineHeight

    if (sig.pdfHashFull) {
      const hashShort = shortHash(sig.pdfHashFull)
      this.drawText(page, `   Hash: ${hashShort}`, {
        x: layout.margin,
        y,
        font: fontRegular,
        size: 10,
        color: layout.colors.muted,
      })
      y -= layout.lineHeight
    }

    if (sig.ipLastOctet) {
      this.drawText(page, `   IP: ...${sig.ipLastOctet}`, {
        x: layout.margin,
        y,
        font: fontRegular,
        size: 10,
        color: layout.colors.muted,
      })
      y -= layout.lineHeight
    }

    const methodLabel =
      sig.method === 'AUTO_COMPANY' ? 'Автоматическая электронная' : 'Электронная click-подпись'
    this.drawText(page, `   Метод: ${methodLabel}`, {
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
    // Render QR as PNG -> embed into PDF. Use medium error correction (M);
    // tradeoff: more redundancy = larger image but survives photo-of-screen
    // scenarios that printed QRs frequently encounter.
    const qrPngBuffer = await QRCode.toBuffer(verifyUrl, {
      errorCorrectionLevel: 'M',
      type: 'png',
      width: 220,
      margin: 1,
      color: { dark: '#1a2540', light: '#ffffff' },
    })

    const qrImage = await doc.embedPng(qrPngBuffer)
    const qrSize = 90
    const qrX = layout.margin
    const qrY = y - qrSize

    page.drawImage(qrImage, {
      x: qrX,
      y: qrY,
      width: qrSize,
      height: qrSize,
    })

    const textX = qrX + qrSize + 14
    const textY = y - 16
    this.drawText(page, 'Проверить документ:', {
      x: textX,
      y: textY,
      font: fontRegular,
      size: 10,
      color: layout.colors.muted,
    })
    this.drawText(page, verifyUrl, {
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
      if (tx.projectName) {
        lines.push(`Доля по проекту "${tx.projectName}"`)
      } else {
        lines.push('Доля по проекту')
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
