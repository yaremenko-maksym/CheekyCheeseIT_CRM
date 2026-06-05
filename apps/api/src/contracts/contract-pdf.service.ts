/**
 * ContractPdfService — render a signed contract's markdown snapshot to PDF.
 *
 * Phase 2 of the PDF refactor: reuses the shared PdfGenerationService
 * (font loading, deterministic metadata, QR embedding) extracted in #106 so
 * contract PDFs share the invoice rendering infrastructure.
 *
 * Determinism contract: the same signed contract (same bodyMarkdown +
 * signedAt) produces a byte-identical PDF → identical SHA-256. This matters
 * for audit re-download integrity. Achieved via `applyDeterministicMetadata`
 * (pins CreationDate/ModDate to signedAt) + `useObjectStreams: false`.
 *
 * The markdown renderer is intentionally minimal — `bodyMarkdownSnapshot` is
 * produced from an ADMIN-authored template (trusted), so we support only the
 * subset templates actually use: `#`/`##` headings, `- ` bullets, `**bold**`
 * inline runs, blank-line paragraph breaks, and word-wrapping. No third-party
 * markdown engine is pulled in.
 */
import { Injectable } from '@nestjs/common'
import { rgb, type PDFDocument, type PDFFont, type PDFPage, type Color } from 'pdf-lib'

import { PdfGenerationService } from '../common/pdf/pdf-generation.service'
import { PDF_COLORS, PDF_LAYOUT, PDF_BRAND } from '../common/pdf/pdf.constants'
import { sha256Hex } from '../common/pdf/pdf.utils'

export interface GenerateContractPdfParams {
  /**
   * A3-1: Rendered as '—' when empty/null (unsigned preview).
   * Real value when signed (CHK-N-YYYY).
   */
  contractNumber: string
  /** bodyMarkdownSnapshot — already variable-interpolated at sign time. */
  bodyMarkdown: string
  /**
   * A3-1: signature block logic driven by this field.
   *   - Non-empty → render real signature (name + date + IP + QR).
   *   - Empty string '' → render «Требуется подпись участника» (unsigned preview mode).
   * isPreview removed — this field is the single conditional.
   */
  signedTypedName: string
  /**
   * A3-1: optional — defaults to `new Date()` when null (unsigned preview).
   * Used for deterministic PDF metadata and signed-date rendering.
   */
  signedAt: Date | null
  /** Last octet only (privacy) — rendered in the signature block. NULL if unknown. */
  signedIpLastOctet: string | null
  /**
   * Public verify URL — encoded into the QR code.
   * Empty string '' → QR and verifyUrl footer NOT rendered (unsigned preview).
   */
  verifyUrl: string
}

export interface GenerateContractPdfResult {
  pdfBuffer: Buffer
  sha256Hash: string
}

/** Mutable rendering cursor — tracks the active page and Y baseline. */
interface Cursor {
  page: PDFPage
  y: number
}

/** A styled text run (one font weight) produced by inline-bold parsing. */
interface Run {
  text: string
  bold: boolean
}

const BODY_SIZE = 11
const H1_SIZE = 16
const H2_SIZE = 13
const BULLET_INDENT = 14
/** Y below which we break to a new page (leaves room for the footer + QR). */
const BOTTOM_LIMIT = PDF_LAYOUT.pageMargin + 70

@Injectable()
export class ContractPdfService {
  constructor(private readonly pdfGen: PdfGenerationService) {}

  async generateContractPdf(params: GenerateContractPdfParams): Promise<GenerateContractPdfResult> {
    const { pdfDoc, regularFont, boldFont } = await this.pdfGen.createDocument()

    const textColor = rgb(PDF_COLORS.text.r, PDF_COLORS.text.g, PDF_COLORS.text.b)
    const mutedColor = rgb(PDF_COLORS.muted.r, PDF_COLORS.muted.g, PDF_COLORS.muted.b)
    const brandColor = rgb(PDF_COLORS.brand.r, PDF_COLORS.brand.g, PDF_COLORS.brand.b)
    const separatorColor = rgb(
      PDF_COLORS.separator.r,
      PDF_COLORS.separator.g,
      PDF_COLORS.separator.b,
    )
    const footerColor = rgb(PDF_COLORS.footer.r, PDF_COLORS.footer.g, PDF_COLORS.footer.b)

    const { pageWidth, pageHeight, pageMargin, contentWidth } = PDF_LAYOUT
    const rightEdge = pageMargin + contentWidth

    const cursor: Cursor = {
      page: pdfDoc.addPage([pageWidth, pageHeight]),
      y: pageHeight - pageMargin,
    }

    // ---- Letterhead: brand mark + company name + contract № -----------
    const markSize = PDF_LAYOUT.brandMarkSize
    const markX = pageMargin
    const markY = cursor.y - markSize
    this.pdfGen.drawBrandMark(cursor.page, markX, markY, markSize, brandColor)

    const wordmarkX = markX + markSize + 10
    this.pdfGen.drawText(cursor.page, PDF_BRAND.companyName, {
      x: wordmarkX,
      y: markY + markSize * 0.55,
      font: boldFont,
      size: 16,
      color: textColor,
    })
    cursor.y -= markSize + 10

    // A3-1: show '—' when contractNumber is empty (unsigned preview).
    const isSigned = Boolean(params.signedTypedName?.trim())
    const displayContractNumber = params.contractNumber || '—'
    this.pdfGen.drawText(cursor.page, `Контракт № ${displayContractNumber}`, {
      x: pageMargin,
      y: cursor.y,
      font: regularFont,
      size: BODY_SIZE,
      color: mutedColor,
    })
    cursor.y -= 14
    // Show signed date only when the contract is actually signed.
    if (isSigned && params.signedAt) {
      this.pdfGen.drawText(cursor.page, `Подписан: ${formatDateRu(params.signedAt)}`, {
        x: pageMargin,
        y: cursor.y,
        font: regularFont,
        size: BODY_SIZE,
        color: mutedColor,
      })
    }
    cursor.y -= 10
    cursor.y = this.pdfGen.drawSeparator(
      cursor.page,
      pageMargin,
      rightEdge,
      cursor.y,
      separatorColor,
    )
    cursor.y -= 6

    // ---- Body (markdown) ----------------------------------------------
    const lines = params.bodyMarkdown.split('\n')
    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/, '')

      // Blank line → paragraph gap.
      if (line.trim() === '') {
        cursor.y -= BODY_SIZE * 0.6
        continue
      }

      if (line.startsWith('## ')) {
        this.renderParagraph(pdfDoc, cursor, parseInlineBold(line.slice(3)), {
          size: H2_SIZE,
          forceBold: true,
          indent: 0,
          regularFont,
          boldFont,
          color: textColor,
          leftX: pageMargin,
          rightEdge,
        })
        continue
      }
      if (line.startsWith('# ')) {
        this.renderParagraph(pdfDoc, cursor, parseInlineBold(line.slice(2)), {
          size: H1_SIZE,
          forceBold: true,
          indent: 0,
          regularFont,
          boldFont,
          color: textColor,
          leftX: pageMargin,
          rightEdge,
        })
        continue
      }
      if (line.startsWith('- ') || line.startsWith('* ')) {
        // Bullet glyph, then the wrapped item text indented.
        this.ensureSpace(pdfDoc, cursor, PDF_LAYOUT.lineHeight)
        this.pdfGen.drawText(cursor.page, '•', {
          x: pageMargin,
          y: cursor.y,
          font: regularFont,
          size: BODY_SIZE,
          color: textColor,
        })
        this.renderParagraph(pdfDoc, cursor, parseInlineBold(line.slice(2)), {
          size: BODY_SIZE,
          forceBold: false,
          indent: BULLET_INDENT,
          regularFont,
          boldFont,
          color: textColor,
          leftX: pageMargin,
          rightEdge,
        })
        continue
      }

      this.renderParagraph(pdfDoc, cursor, parseInlineBold(line), {
        size: BODY_SIZE,
        forceBold: false,
        indent: 0,
        regularFont,
        boldFont,
        color: textColor,
        leftX: pageMargin,
        rightEdge,
      })
    }

    // ---- Signature block ----------------------------------------------
    this.ensureSpace(pdfDoc, cursor, 70)
    cursor.y -= 12
    cursor.y = this.pdfGen.drawSeparator(
      cursor.page,
      pageMargin,
      rightEdge,
      cursor.y,
      separatorColor,
    )
    cursor.y -= 4
    this.pdfGen.drawText(cursor.page, 'Подпись', {
      x: pageMargin,
      y: cursor.y,
      font: boldFont,
      size: 12,
      color: textColor,
    })
    cursor.y -= 16

    if (isSigned) {
      // Signed mode — show resolved name, date, and trailing IP segment.
      this.pdfGen.drawText(cursor.page, params.signedTypedName, {
        x: pageMargin,
        y: cursor.y,
        font: regularFont,
        size: BODY_SIZE,
        color: textColor,
      })
      cursor.y -= 14
      const ipSuffix = params.signedIpLastOctet ? ` · IP …${params.signedIpLastOctet}` : ''
      const signedAtDisplay = params.signedAt ? formatDateRu(params.signedAt) : ''
      this.pdfGen.drawText(cursor.page, `${signedAtDisplay}${ipSuffix}`, {
        x: pageMargin,
        y: cursor.y,
        font: regularFont,
        size: 9,
        color: mutedColor,
      })
    } else {
      // A3-1: unsigned preview — show placeholder text instead of signer info.
      // No name, no date, no IP — the document has not been signed yet.
      this.pdfGen.drawText(cursor.page, 'Требуется подпись участника', {
        x: pageMargin,
        y: cursor.y,
        font: regularFont,
        size: BODY_SIZE,
        color: mutedColor,
      })
    }

    // ---- QR + footer — only when verifyUrl is provided (signed contracts) --
    // A3-1: empty verifyUrl = unsigned preview → omit QR and footer.
    if (isSigned && params.verifyUrl) {
      const qrImage = await this.pdfGen.embedQrPng(pdfDoc, params.verifyUrl)
      const finalPage = cursor.page
      finalPage.drawImage(qrImage, {
        x: rightEdge - PDF_LAYOUT.qrSize,
        y: pageMargin,
        width: PDF_LAYOUT.qrSize,
        height: PDF_LAYOUT.qrSize,
      })
      this.pdfGen.drawText(finalPage, `Проверка: ${params.verifyUrl}`, {
        x: pageMargin,
        y: pageMargin + 8,
        font: regularFont,
        size: 8,
        color: footerColor,
      })
    }

    // ---- Deterministic save -------------------------------------------
    // A3-1: unsigned preview has no signedAt — pin metadata to a fixed epoch so the
    // preview is byte-deterministic (re-rendering the same draft → same sha256).
    this.pdfGen.applyDeterministicMetadata(pdfDoc, params.signedAt ?? new Date(0))
    const bytes = await pdfDoc.save({ useObjectStreams: false })
    const buffer = Buffer.from(bytes)

    return { pdfBuffer: buffer, sha256Hash: sha256Hex(buffer) }
  }

  /**
   * Render a paragraph of styled runs with word-wrapping and page breaks.
   * Advances `cursor.y` and may switch `cursor.page` on overflow.
   */
  private renderParagraph(
    pdfDoc: PDFDocument,
    cursor: Cursor,
    runs: Run[],
    opts: {
      size: number
      forceBold: boolean
      indent: number
      regularFont: PDFFont
      boldFont: PDFFont
      color: Color
      leftX: number
      rightEdge: number
    },
  ): void {
    const lineHeight = opts.size * 1.3
    const startX = opts.leftX + opts.indent
    const maxRight = opts.rightEdge
    this.ensureSpace(pdfDoc, cursor, lineHeight)
    let x = startX

    for (const run of runs) {
      const font = opts.forceBold || run.bold ? opts.boldFont : opts.regularFont
      // Split keeping whitespace so we can wrap on word boundaries.
      const tokens = run.text.split(/(\s+)/).filter((t) => t.length > 0)
      for (const token of tokens) {
        const tokenWidth = font.widthOfTextAtSize(token, opts.size)
        if (x + tokenWidth > maxRight && x > startX) {
          cursor.y -= lineHeight
          this.ensureSpace(pdfDoc, cursor, lineHeight)
          x = startX
          // Skip leading whitespace token at the start of a wrapped line.
          if (/^\s+$/.test(token)) continue
        }
        this.pdfGen.drawText(cursor.page, token, {
          x,
          y: cursor.y,
          font,
          size: opts.size,
          color: opts.color,
        })
        x += tokenWidth
      }
    }
    cursor.y -= lineHeight
  }

  /**
   * Ensure at least `needed` vertical points remain before BOTTOM_LIMIT;
   * otherwise start a new page and reset the cursor to the top margin.
   */
  private ensureSpace(pdfDoc: PDFDocument, cursor: Cursor, needed: number): void {
    if (cursor.y - needed < BOTTOM_LIMIT) {
      cursor.page = pdfDoc.addPage([PDF_LAYOUT.pageWidth, PDF_LAYOUT.pageHeight])
      cursor.y = PDF_LAYOUT.pageHeight - PDF_LAYOUT.pageMargin
    }
  }
}

/** Split a line into alternating regular / bold runs on `**` markers. */
function parseInlineBold(line: string): Run[] {
  const segments = line.split('**')
  const runs: Run[] = []
  segments.forEach((segment, index) => {
    if (segment.length === 0) return
    runs.push({ text: segment, bold: index % 2 === 1 })
  })
  return runs.length > 0 ? runs : [{ text: '', bold: false }]
}

/** Format a date as DD.MM.YYYY HH:mm (UTC) — deterministic, locale-free. */
function formatDateRu(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const d = pad(date.getUTCDate())
  const m = pad(date.getUTCMonth() + 1)
  const y = date.getUTCFullYear()
  const hh = pad(date.getUTCHours())
  const mm = pad(date.getUTCMinutes())
  return `${d}.${m}.${y} ${hh}:${mm} UTC`
}
