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
 * subset templates actually use:
 *   - `#`/`##` headings
 *   - `- ` / `* ` bullets
 *   - `**bold**` inline runs
 *   - `` `backtick` `` spans — backticks stripped, inner text rendered plainly
 *   - `> ` blockquotes (disclaimer paragraphs — rendered muted, no literal `>`)
 *   - empty blockquote (`>` or `> ` alone) → treated as blank line
 *   - `<br>` / `<br/>` inline — forces a line break within a paragraph/heading
 *   - `---` / `***` / `___` horizontal rule — renders as thin separator line
 *     (ONLY in bilingual/two-column bodies; preserved as-is in single-column
 *     bodies to keep MED-1 byte-determinism for existing signed PDFs)
 *   - blank-line paragraph breaks
 *   - word-wrapping
 *   - markdown pipe-tables `| UA | EN |` → two-column layout (ADDITIVE path)
 *
 * Two-column path is purely additive: non-table lines follow the original
 * renderParagraph/bullet/heading path byte-for-byte, ensuring existing
 * signed PDFs remain byte-identical on re-render.
 *
 * "Bilingual" detection: a body is bilingual when it contains at least one
 * pipe-table row (`isTableRow`). This drives both the `---` → separator
 * upgrade and the bilingual signature block.
 */
import { Injectable } from '@nestjs/common'
import { rgb } from 'pdf-lib'

import { PdfGenerationService } from '../common/pdf/pdf-generation.service'
import { PDF_COLORS, PDF_LAYOUT, PDF_BRAND, CONTRACT_COMPANY } from '../common/pdf/pdf.constants'
import { sha256Hex } from '../common/pdf/pdf.utils'
import {
  BODY_SIZE,
  ensureSpace,
  parseInlineBold,
  renderParagraph,
  renderParagraphWithBreaks,
  renderTableBlock,
  type Cursor,
} from './contract-pdf-render.util'

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
   *   - Non-empty → render real signature (name + date + QR).
   *   - Empty string '' → render «Потрібен підпис учасника» (unsigned preview mode).
   * isPreview removed — this field is the single conditional.
   * IP address removed from output (AC7) — stored in DB for audit only.
   */
  signedTypedName: string
  /**
   * A3-1: optional — defaults to `new Date()` when null (unsigned preview).
   * Used for deterministic PDF metadata and signed-date rendering.
   */
  signedAt: Date | null
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

const H1_SIZE = 16
const H2_SIZE = 13
const BULLET_INDENT = 14
/** Line height for signature block text */
const SIG_LINE_HEIGHT = 14

/**
 * Returns true when a line looks like a markdown pipe-table row.
 * Pattern: optional leading whitespace, pipe, anything, pipe, optional trailing WS.
 */
function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line)
}

/**
 * Returns true when the body markdown contains at least one pipe-table row.
 *
 * Used to drive two conditional behaviours:
 *   1. `---` / `***` / `___` horizontal rules are rendered as thin separator
 *      lines (instead of literal text) — only in bilingual bodies.
 *   2. The signature block uses bilingual UA/EN labels instead of the
 *      single-column Russian labels.
 *
 * Bilingual detection is a pre-pass so it is computed once before chunking.
 */
function isBilingualBody(markdown: string): boolean {
  return markdown.split('\n').some((l) => isTableRow(l))
}

/**
 * Returns true when the line is a markdown horizontal rule:
 * exactly `---`, `***`, or `___` (optionally surrounded by whitespace).
 */
function isHorizontalRule(line: string): boolean {
  return /^\s*(---|\*\*\*|___)\s*$/.test(line)
}

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

    // ---- Letterhead: brand mark + company name (left) + legal entity (right) ---
    const markSize = PDF_LAYOUT.brandMarkSize
    const markX = pageMargin
    const markY = cursor.y - markSize
    this.pdfGen.drawBrandMark(cursor.page, markX, markY, markSize, brandColor)

    // AC5: vertically center the wordmark within the brand mark height.
    const wordmarkFontSize = 16
    const wordmarkX = markX + markSize + 10
    this.pdfGen.drawText(cursor.page, PDF_BRAND.companyName, {
      x: wordmarkX,
      y: markY + (markSize - wordmarkFontSize) / 2 + wordmarkFontSize * 0.25,
      font: boldFont,
      size: wordmarkFontSize,
      color: textColor,
    })

    // Legal entity block — right-aligned in the letterhead (T3).
    const legalLines = [
      CONTRACT_COMPANY.legalName,
      CONTRACT_COMPANY.address,
      CONTRACT_COMPANY.country,
    ]
    const legalFontSize = 8
    const legalLineHeight = 10
    let legalY = markY + markSize - legalFontSize
    for (const line of legalLines) {
      const lineWidth = regularFont.widthOfTextAtSize(line, legalFontSize)
      this.pdfGen.drawText(cursor.page, line, {
        x: rightEdge - lineWidth,
        y: legalY,
        font: regularFont,
        size: legalFontSize,
        color: mutedColor,
      })
      legalY -= legalLineHeight
    }

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
    if (isSigned && params.signedAt) {
      this.pdfGen.drawText(cursor.page, `Підписано: ${formatDateRu(params.signedAt)}`, {
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

    // ---- Body (markdown) -----------------------------------------------
    // Bilingual detection: pre-pass to determine rendering mode.
    // A bilingual body contains at least one pipe-table row.
    // This drives: (1) `---` → thin separator, (2) bilingual signature block.
    const bilingual = isBilingualBody(params.bodyMarkdown)

    // Pre-process: group consecutive table rows into blocks so we can hand
    // them off to the two-column renderer as a unit while leaving all other
    // lines on the original single-column path.
    // Drop manual signature-placeholder rows (e.g. `| Підпис: \_\_\_ | Signature: \_\_\_ |`)
    // from bilingual contracts — signatures are rendered in the dedicated block
    // below, not as blank fill-in lines. Single-column bodies are left untouched
    // to preserve their byte-identical determinism.
    const isSignaturePlaceholderRow = (l: string): boolean =>
      /(Підпис|Подпис[ьи]?|Signature)\s*:\s*(\\?_){3,}/iu.test(l)
    const allBodyLines = params.bodyMarkdown.split('\n')
    const rawLines = bilingual
      ? allBodyLines.filter((l) => !isSignaturePlaceholderRow(l))
      : allBodyLines

    type LineChunk = { kind: 'line'; value: string } | { kind: 'table'; rows: string[] }

    const chunks: LineChunk[] = []
    let tableAcc: string[] = []

    for (const rawLine of rawLines) {
      const line = rawLine.replace(/\s+$/, '')
      if (isTableRow(line)) {
        tableAcc.push(line)
      } else {
        if (tableAcc.length > 0) {
          chunks.push({ kind: 'table', rows: tableAcc })
          tableAcc = []
        }
        chunks.push({ kind: 'line', value: line })
      }
    }
    if (tableAcc.length > 0) {
      chunks.push({ kind: 'table', rows: tableAcc })
    }

    for (const chunk of chunks) {
      if (chunk.kind === 'table') {
        renderTableBlock(this.pdfGen, pdfDoc, cursor, chunk.rows, {
          regularFont,
          boldFont,
          textColor,
          mutedColor,
        })
        continue
      }

      const line = chunk.value

      // Blank line → paragraph gap.
      if (line.trim() === '') {
        cursor.y -= BODY_SIZE * 0.6
        continue
      }

      // Horizontal rule: `---` / `***` / `___` (bilingual path only).
      // Single-column bodies preserve these as-is to keep MED-1 byte-identity.
      if (bilingual && isHorizontalRule(line)) {
        cursor.y -= 4
        cursor.y = this.pdfGen.drawSeparator(
          cursor.page,
          pageMargin,
          rightEdge,
          cursor.y,
          separatorColor,
        )
        cursor.y -= 4
        continue
      }

      // Blockquote: `> text` — render as muted paragraph without the `>` prefix.
      // Empty blockquote (`>` alone or `> ` with only spaces) → blank line.
      if (line.startsWith('>')) {
        const content = line.slice(1).replace(/^\s/, '')
        if (content.trim() === '') {
          cursor.y -= BODY_SIZE * 0.6
        } else {
          renderParagraph(this.pdfGen, pdfDoc, cursor, parseInlineBold(content), {
            size: BODY_SIZE,
            forceBold: false,
            indent: 0,
            regularFont,
            boldFont,
            color: mutedColor,
            leftX: pageMargin,
            rightEdge,
          })
        }
        continue
      }

      if (line.startsWith('## ')) {
        renderParagraphWithBreaks(this.pdfGen, pdfDoc, cursor, line.slice(3), {
          size: H2_SIZE,
          forceBold: true,
          regularFont,
          boldFont,
          color: textColor,
          leftX: pageMargin,
          rightEdge,
        })
        continue
      }
      if (line.startsWith('# ')) {
        renderParagraphWithBreaks(this.pdfGen, pdfDoc, cursor, line.slice(2), {
          size: H1_SIZE,
          forceBold: true,
          regularFont,
          boldFont,
          color: textColor,
          leftX: pageMargin,
          rightEdge,
        })
        continue
      }
      if (line.startsWith('- ') || line.startsWith('* ')) {
        ensureSpace(pdfDoc, cursor, PDF_LAYOUT.lineHeight)
        this.pdfGen.drawText(cursor.page, '•', {
          x: pageMargin,
          y: cursor.y,
          font: regularFont,
          size: BODY_SIZE,
          color: textColor,
        })
        renderParagraph(this.pdfGen, pdfDoc, cursor, parseInlineBold(line.slice(2)), {
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

      renderParagraphWithBreaks(this.pdfGen, pdfDoc, cursor, line, {
        size: BODY_SIZE,
        forceBold: false,
        regularFont,
        boldFont,
        color: textColor,
        leftX: pageMargin,
        rightEdge,
      })
    }

    // ---- Dual signature block (AC8) ----------------------------------------
    // Bilingual bodies (pipe-table contracts) use UA/EN labels.
    // Single-column bodies (seed templates) use the original Russian labels
    // byte-for-byte to preserve MED-1 determinism.
    ensureSpace(pdfDoc, cursor, 160)
    cursor.y -= 12
    cursor.y = this.pdfGen.drawSeparator(
      cursor.page,
      pageMargin,
      rightEdge,
      cursor.y,
      separatorColor,
    )
    cursor.y -= 4

    const sigHeading = bilingual ? 'Підписи сторін / Signatures' : 'Підписи сторін'
    this.pdfGen.drawText(cursor.page, sigHeading, {
      x: pageMargin,
      y: cursor.y,
      font: boldFont,
      size: 12,
      color: textColor,
    })
    cursor.y -= SIG_LINE_HEIGHT + 4

    const midX = pageMargin + contentWidth / 2 - 10

    if (bilingual) {
      // ── Style A: clean electronic signature; brand mark on the company side ──
      // role label · name on a signature rule · "✓ Підписано електронно" + date.
      const colWidth = contentWidth / 2 - 30
      const blockTopY = cursor.y

      const drawSignatory = (
        x: number,
        roleLabel: string,
        name: string,
        withBrandMark: boolean,
      ): number => {
        let y = blockTopY
        this.pdfGen.drawText(cursor.page, roleLabel, {
          x,
          y,
          font: boldFont,
          size: BODY_SIZE,
          color: textColor,
        })
        y -= SIG_LINE_HEIGHT + 10
        let nameX = x
        if (withBrandMark) {
          const markSz = 11
          this.pdfGen.drawBrandMark(cursor.page, x, y - 1, markSz, brandColor)
          nameX = x + markSz + 6
        }
        this.pdfGen.drawText(cursor.page, name, {
          x: nameX,
          y,
          font: regularFont,
          size: BODY_SIZE,
          color: textColor,
        })
        y -= 6
        this.pdfGen.drawSeparator(cursor.page, x, x + colWidth, y, separatorColor)
        y -= SIG_LINE_HEIGHT
        if (isSigned) {
          this.pdfGen.drawText(cursor.page, '✓ Підписано електронно / Signed electronically', {
            x,
            y,
            font: regularFont,
            size: 8,
            color: brandColor,
          })
          y -= SIG_LINE_HEIGHT - 2
          this.pdfGen.drawText(cursor.page, params.signedAt ? formatDateRu(params.signedAt) : '', {
            x,
            y,
            font: regularFont,
            size: 8,
            color: mutedColor,
          })
          y -= SIG_LINE_HEIGHT
        } else {
          this.pdfGen.drawText(cursor.page, 'Очікує підпису / Awaiting signature', {
            x,
            y,
            font: regularFont,
            size: 8,
            color: mutedColor,
          })
          y -= SIG_LINE_HEIGHT
        }
        return y
      }

      const participantEndY = drawSignatory(
        pageMargin,
        'Учасник / Signatory',
        isSigned ? params.signedTypedName : '',
        false,
      )
      const companyEndY = drawSignatory(midX, 'Компанія / Company', PDF_BRAND.companyName, true)
      cursor.y = Math.min(participantEndY, companyEndY)
    } else {
      // ── Single-column (Ukrainian) path — MED-1 determinism preserved ──
      const participantLabel = '1. Учасник'
      this.pdfGen.drawText(cursor.page, participantLabel, {
        x: pageMargin,
        y: cursor.y,
        font: boldFont,
        size: BODY_SIZE,
        color: textColor,
      })
      const dualSigStartY = cursor.y

      if (isSigned) {
        cursor.y -= SIG_LINE_HEIGHT
        this.pdfGen.drawText(cursor.page, params.signedTypedName, {
          x: pageMargin,
          y: cursor.y,
          font: regularFont,
          size: BODY_SIZE,
          color: textColor,
        })
        cursor.y -= SIG_LINE_HEIGHT
        const signedAtDisplay = params.signedAt ? formatDateRu(params.signedAt) : ''
        this.pdfGen.drawText(cursor.page, signedAtDisplay, {
          x: pageMargin,
          y: cursor.y,
          font: regularFont,
          size: 9,
          color: mutedColor,
        })
        cursor.y -= SIG_LINE_HEIGHT
      } else {
        cursor.y -= SIG_LINE_HEIGHT
        this.pdfGen.drawText(cursor.page, 'Потрібен підпис учасника', {
          x: pageMargin,
          y: cursor.y,
          font: regularFont,
          size: BODY_SIZE,
          color: mutedColor,
        })
        cursor.y -= SIG_LINE_HEIGHT
      }

      const companyLabel = '2. Від CheekyCheeseIT'
      let companyY = dualSigStartY
      this.pdfGen.drawText(cursor.page, companyLabel, {
        x: midX,
        y: companyY,
        font: boldFont,
        size: BODY_SIZE,
        color: textColor,
      })
      companyY -= SIG_LINE_HEIGHT
      this.pdfGen.drawText(cursor.page, PDF_BRAND.companyName, {
        x: midX,
        y: companyY,
        font: regularFont,
        size: BODY_SIZE,
        color: textColor,
      })
      companyY -= SIG_LINE_HEIGHT
      const companyDateStr = params.signedAt ? formatDateRu(params.signedAt) : 'Підписано'
      this.pdfGen.drawText(cursor.page, companyDateStr, {
        x: midX,
        y: companyY,
        font: regularFont,
        size: 9,
        color: mutedColor,
      })
      companyY -= SIG_LINE_HEIGHT

      if (companyY < cursor.y) {
        cursor.y = companyY
      }
    }

    // ---- QR + footer ---------------------------------------------------
    if (isSigned && params.verifyUrl) {
      const qrImage = await this.pdfGen.embedQrPng(pdfDoc, params.verifyUrl)
      const finalPage = cursor.page
      finalPage.drawImage(qrImage, {
        x: rightEdge - PDF_LAYOUT.qrSize,
        y: pageMargin,
        width: PDF_LAYOUT.qrSize,
        height: PDF_LAYOUT.qrSize,
      })
      this.pdfGen.drawText(finalPage, `Перевірка: ${params.verifyUrl}`, {
        x: pageMargin,
        y: pageMargin + 8,
        font: regularFont,
        size: 8,
        color: footerColor,
      })
    }

    // ---- Deterministic save --------------------------------------------
    this.pdfGen.applyDeterministicMetadata(pdfDoc, params.signedAt ?? new Date(0))
    const bytes = await pdfDoc.save({ useObjectStreams: false })
    const buffer = Buffer.from(bytes)

    return { pdfBuffer: buffer, sha256Hash: sha256Hex(buffer) }
  }
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
