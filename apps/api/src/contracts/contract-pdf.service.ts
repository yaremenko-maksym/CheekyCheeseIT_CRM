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
import { rgb, type PDFDocument, type PDFFont, type PDFPage, type Color } from 'pdf-lib'

import { PdfGenerationService } from '../common/pdf/pdf-generation.service'
import { PDF_COLORS, PDF_LAYOUT, PDF_BRAND, CONTRACT_COMPANY } from '../common/pdf/pdf.constants'
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
/** Line height for signature block text */
const SIG_LINE_HEIGHT = 14

// ---------------------------------------------------------------------------
// Two-column table geometry
// ---------------------------------------------------------------------------
/** Gutter between the two table columns in points. */
const TABLE_GUTTER = 16
/** Width of each column = (contentWidth - gutter) / 2 */
const COL_WIDTH = (PDF_LAYOUT.contentWidth - TABLE_GUTTER) / 2
/** X of the left table column — starts at page margin, no indent. */
const LEFT_COL_X = PDF_LAYOUT.pageMargin
/** X of the right table column. */
const RIGHT_COL_X = PDF_LAYOUT.pageMargin + COL_WIDTH + TABLE_GUTTER

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

/**
 * Returns true when every non-empty cell in a pipe-table row is a separator
 * (`---`, `:---`, `---:`, `:---:`).
 */
function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c.trim()))
}

/**
 * Split a pipe-table row into trimmed cell strings.
 * Handles escaped pipes `\|` by treating them as a literal `|` in cell text.
 * Outer empty strings from leading/trailing `|` are discarded.
 */
function parseCells(line: string): string[] {
  // Replace escaped pipes with a placeholder, split, restore.
  const PIPE_PLACEHOLDER = '\x00PIPE\x00'
  const escaped = line.replace(/\\\|/g, PIPE_PLACEHOLDER)
  return escaped
    .split('|')
    .map((cell) => cell.replace(new RegExp(PIPE_PLACEHOLDER, 'g'), '|').trim())
    .filter((cell, idx, arr) => {
      // Discard empty strings that come from leading/trailing `|`
      if (idx === 0 || idx === arr.length - 1) return cell.length > 0
      return true
    })
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
        this.renderTableBlock(pdfDoc, cursor, chunk.rows, {
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
          this.renderParagraph(pdfDoc, cursor, parseInlineBold(content), {
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
        this.renderParagraphWithBreaks(pdfDoc, cursor, line.slice(3), {
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
        this.renderParagraphWithBreaks(pdfDoc, cursor, line.slice(2), {
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

      this.renderParagraphWithBreaks(pdfDoc, cursor, line, {
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
    this.ensureSpace(pdfDoc, cursor, 160)
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

  // ---------------------------------------------------------------------------
  // Two-column table renderer (ADDITIVE — only called for pipe-table blocks)
  // ---------------------------------------------------------------------------

  /**
   * Render a block of consecutive pipe-table rows in two-column layout.
   *
   * Geometry:
   *   gutter = TABLE_GUTTER (16pt)
   *   colWidth = (contentWidth - gutter) / 2
   *   left col x  = pageMargin
   *   right col x = pageMargin + colWidth + gutter
   *
   * Each data row: compute the wrap-height of both cells, rowHeight = max of
   * the two, draw both cells top-aligned from the same Y, advance cursor by
   * rowHeight. Handles pagination: if row doesn't fit → new page first.
   * If a single row is taller than the full page, splits line-by-line across
   * pages.
   *
   * Header row (first row, typically "| Українська | English |"): bold.
   * Separator rows (all cells matching /^:?-{3,}:?$/): skipped entirely.
   * Non-2-column rows: graceful fallback — rendered as single-column text.
   *
   * Token-level hard-break: tokens wider than the column are split
   * character-by-character so long IBAN/wallet/URL strings never overflow.
   *
   * Determinism: all metrics are derived from PDFFont.widthOfTextAtSize
   * (synchronous, font-dependent, no Date.now/random). Same input → same
   * character positions → same output bytes.
   */
  private renderTableBlock(
    pdfDoc: PDFDocument,
    cursor: Cursor,
    rows: string[],
    opts: {
      regularFont: PDFFont
      boldFont: PDFFont
      textColor: Color
      mutedColor: Color
    },
  ): void {
    const { regularFont, boldFont, textColor } = opts
    const lineHeight = BODY_SIZE * 1.3

    // Track which row is the header (first non-separator row).
    let headerDone = false

    for (const rawRow of rows) {
      const cells = parseCells(rawRow)

      // Skip separator rows.
      if (isSeparatorRow(cells)) continue

      // Non-2-column fallback: render as plain paragraph.
      if (cells.length !== 2) {
        const text = cells.join(' | ')
        this.renderParagraph(pdfDoc, cursor, parseInlineBold(text), {
          size: BODY_SIZE,
          forceBold: !headerDone,
          indent: 0,
          regularFont,
          boldFont,
          color: textColor,
          leftX: PDF_LAYOUT.pageMargin,
          rightEdge: PDF_LAYOUT.pageMargin + PDF_LAYOUT.contentWidth,
        })
        headerDone = true
        continue
      }

      const isHeader = !headerDone
      headerDone = true

      // Compute the wrapped lines for each cell to determine row height.
      // cells.length === 2 is guaranteed by the guard above — non-null asserts are safe.
      const leftLines = this.wrapCellLines(cells[0]!, isHeader, COL_WIDTH, regularFont, boldFont)
      const rightLines = this.wrapCellLines(cells[1]!, isHeader, COL_WIDTH, regularFont, boldFont)

      const totalRowLines = Math.max(leftLines.length, rightLines.length)
      const rowHeight = totalRowLines * lineHeight

      // Available space on the current page.
      const availableSpace = cursor.y - BOTTOM_LIMIT

      if (rowHeight <= availableSpace) {
        // Entire row fits on the current page.
        this.drawTwoColRow(pdfDoc, cursor, leftLines, rightLines, isHeader, opts)
      } else if (rowHeight > PDF_LAYOUT.pageHeight - PDF_LAYOUT.pageMargin * 2 - 70) {
        // Row is taller than a full page — draw line-by-line, paginating as needed.
        const maxIdx = Math.max(leftLines.length, rightLines.length)
        for (let i = 0; i < maxIdx; i++) {
          this.ensureSpace(pdfDoc, cursor, lineHeight)
          const lLine = leftLines[i] ?? null
          const rLine = rightLines[i] ?? null
          if (lLine) {
            this.drawCellLine(cursor, lLine, LEFT_COL_X, isHeader, opts)
          }
          if (rLine) {
            this.drawCellLine(cursor, rLine, RIGHT_COL_X, isHeader, opts)
          }
          cursor.y -= lineHeight
        }
      } else {
        // Row doesn't fit — start a new page, then draw.
        cursor.page = pdfDoc.addPage([PDF_LAYOUT.pageWidth, PDF_LAYOUT.pageHeight])
        cursor.y = PDF_LAYOUT.pageHeight - PDF_LAYOUT.pageMargin
        this.drawTwoColRow(pdfDoc, cursor, leftLines, rightLines, isHeader, opts)
      }
    }
  }

  /**
   * Draw a two-column row that is known to fit on the current page.
   * Both columns start at `cursor.y`; cursor advances by rowHeight afterwards.
   *
   * MED-2 fix: `ensureSpace` is called by the caller (`renderTableBlock`)
   * before invoking `drawTwoColRow`, so we must NOT call it again here.
   * The previous double-call could push the cursor to a new page and then
   * leave the old page, producing a spurious empty page between table rows.
   */
  private drawTwoColRow(
    _pdfDoc: PDFDocument,
    cursor: Cursor,
    leftLines: Array<{ text: string; bold: boolean }[]>,
    rightLines: Array<{ text: string; bold: boolean }[]>,
    isHeader: boolean,
    opts: {
      regularFont: PDFFont
      boldFont: PDFFont
      textColor: Color
      mutedColor: Color
    },
  ): void {
    const lineHeight = BODY_SIZE * 1.3
    const totalLines = Math.max(leftLines.length, rightLines.length)
    const rowHeight = totalLines * lineHeight

    // NOTE: ensureSpace was already called by renderTableBlock before this
    // method is invoked — do NOT call it here (MED-2 fix).

    const topY = cursor.y

    // Draw left column lines.
    for (let i = 0; i < leftLines.length; i++) {
      const lineY = topY - i * lineHeight
      // i < leftLines.length guarantees element exists — non-null assert is safe.
      this.drawCellLine({ page: cursor.page, y: lineY }, leftLines[i]!, LEFT_COL_X, isHeader, opts)
    }

    // Draw right column lines.
    for (let i = 0; i < rightLines.length; i++) {
      const lineY = topY - i * lineHeight
      this.drawCellLine(
        { page: cursor.page, y: lineY },
        rightLines[i]!,
        RIGHT_COL_X,
        isHeader,
        opts,
      )
    }

    cursor.y -= rowHeight
  }

  /**
   * Draw a single rendered line (array of runs) at the given column x and y.
   */
  private drawCellLine(
    at: { page: PDFPage; y: number },
    runs: { text: string; bold: boolean }[],
    colX: number,
    isHeader: boolean,
    opts: {
      regularFont: PDFFont
      boldFont: PDFFont
      textColor: Color
      mutedColor: Color
    },
  ): void {
    const { regularFont, boldFont, textColor } = opts
    let x = colX
    for (const run of runs) {
      if (run.text.length === 0) continue
      const font = isHeader || run.bold ? boldFont : regularFont
      this.pdfGen.drawText(at.page, run.text, {
        x,
        y: at.y,
        font,
        size: BODY_SIZE,
        color: textColor,
      })
      x += font.widthOfTextAtSize(run.text, BODY_SIZE)
    }
  }

  /**
   * Wrap the text of a single table cell into lines that fit within `colWidth`.
   *
   * Returns an array of lines, each line being an array of styled runs.
   *
   * Word-level wrap: tries to fit whole tokens. When a single token is wider
   * than `colWidth`, it is broken character-by-character so long wallet
   * addresses, IBANs, and URLs never overflow the column.
   */
  private wrapCellLines(
    cellText: string,
    isHeader: boolean,
    colWidth: number,
    regularFont: PDFFont,
    boldFont: PDFFont,
  ): Array<{ text: string; bold: boolean }[]> {
    const parsedRuns = parseInlineBold(cellText)
    const lines: Array<{ text: string; bold: boolean }[]> = []
    let currentLine: { text: string; bold: boolean }[] = []
    let lineWidth = 0

    const pushCurrentLine = () => {
      if (currentLine.length > 0) {
        lines.push(currentLine)
        currentLine = []
        lineWidth = 0
      }
    }

    for (const run of parsedRuns) {
      const font = isHeader || run.bold ? boldFont : regularFont
      // Split on whitespace, preserving the whitespace tokens for width calc.
      const tokens = run.text.split(/(\s+)/).filter((t) => t.length > 0)

      for (const token of tokens) {
        const tokenWidth = font.widthOfTextAtSize(token, BODY_SIZE)

        // Skip leading whitespace when at the start of a new line.
        if (lineWidth === 0 && /^\s+$/.test(token)) continue

        if (tokenWidth <= colWidth) {
          // Token fits as-is — check if it fits on the current line.
          if (lineWidth + tokenWidth > colWidth && lineWidth > 0) {
            pushCurrentLine()
            if (/^\s+$/.test(token)) continue
          }
          currentLine.push({ text: token, bold: run.bold })
          lineWidth += tokenWidth
        } else {
          // Token is wider than the column — break it character by character.
          // This handles long Ethereum addresses, IBANs, URLs.
          if (lineWidth > 0) pushCurrentLine()

          let charBuf = ''
          let charBufWidth = 0

          for (const ch of token) {
            const chWidth = font.widthOfTextAtSize(ch, BODY_SIZE)
            if (charBufWidth + chWidth > colWidth && charBuf.length > 0) {
              lines.push([{ text: charBuf, bold: run.bold }])
              charBuf = ''
              charBufWidth = 0
            }
            charBuf += ch
            charBufWidth += chWidth
          }

          if (charBuf.length > 0) {
            currentLine.push({ text: charBuf, bold: run.bold })
            lineWidth = charBufWidth
          }
        }
      }
    }

    pushCurrentLine()

    // An empty cell produces no lines — represent it as one empty line so
    // the row still participates in height calculation.
    if (lines.length === 0) {
      lines.push([{ text: '', bold: false }])
    }

    return lines
  }

  // ---------------------------------------------------------------------------
  // Single-column helpers (unchanged from original — preserves byte identity)
  // ---------------------------------------------------------------------------

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
      const tokens = run.text.split(/(\s+)/).filter((t) => t.length > 0)
      for (const token of tokens) {
        const tokenWidth = font.widthOfTextAtSize(token, opts.size)
        if (x + tokenWidth > maxRight && x > startX) {
          cursor.y -= lineHeight
          this.ensureSpace(pdfDoc, cursor, lineHeight)
          x = startX
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
   * Render a line that may contain `<br>` or `<br/>` inline break markers.
   *
   * Splits the raw text on `<br>` / `<br/>` (case-insensitive) and renders
   * each segment as its own call to `renderParagraph`, advancing the cursor
   * between segments. A line without any `<br>` delegates directly to
   * `renderParagraph` — zero overhead on the common case.
   *
   * Used for headings and body paragraphs in both column paths. Bullets are
   * not expected to contain `<br>` in practice and are unchanged.
   */
  private renderParagraphWithBreaks(
    pdfDoc: PDFDocument,
    cursor: Cursor,
    rawLine: string,
    opts: {
      size: number
      forceBold: boolean
      regularFont: PDFFont
      boldFont: PDFFont
      color: Color
      leftX: number
      rightEdge: number
    },
  ): void {
    const segments = rawLine.split(/<br\s*\/?>/i)
    for (const seg of segments) {
      this.renderParagraph(pdfDoc, cursor, parseInlineBold(seg), {
        ...opts,
        indent: 0,
      })
    }
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

/**
 * Split a line into alternating regular / bold runs on `**` markers,
 * stripping any inline backtick code spans (`` ` ``).
 *
 * Backtick handling: backtick characters are removed from the text.
 * `` `[ВПИШИ: X]` `` renders as `[ВПИШИ: X]` — no literal backtick visible.
 * This is intentional: contract templates use backticks only for visual
 * emphasis in the source markdown; the PDF has no monospace rendering.
 */
function parseInlineBold(line: string): Run[] {
  // Strip backticks (inline code markers) before processing bold markers.
  const stripped = line.replace(/`/g, '')
  const segments = stripped.split('**')
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
