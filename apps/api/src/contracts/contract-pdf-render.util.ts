/**
 * Pure PDF-layout primitives for ContractPdfService (free functions).
 *
 * Extracted verbatim from ContractPdfService (behavior-preserving size
 * refactor). Everything operates on an explicit PDFDocument + Cursor; the only
 * collaborator is a `drawText` port passed in by the caller, so there is no DI
 * edge and no hidden state.
 */
import type { PDFDocument, PDFFont, PDFPage, Color } from 'pdf-lib'

import type { PdfGenerationService } from '../common/pdf/pdf-generation.service'
import { PDF_LAYOUT } from '../common/pdf/pdf.constants'

/** The single PdfGenerationService capability the layout primitives need. */
export type TextDrawer = Pick<PdfGenerationService, 'drawText'>

/** Mutable rendering cursor — tracks the active page and Y baseline. */
export interface Cursor {
  page: PDFPage
  y: number
}

/** A styled text run (one font weight) produced by inline-bold parsing. */
export interface Run {
  text: string
  bold: boolean
}

export const BODY_SIZE = 11
/** Y below which we break to a new page (leaves room for the footer + QR). */
const BOTTOM_LIMIT = PDF_LAYOUT.pageMargin + 70

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

/**
 * Split a line into alternating regular / bold runs on `**` markers,
 * stripping any inline backtick code spans (`` ` ``).
 *
 * Backtick handling: backtick characters are removed from the text.
 * `` `[ВПИШИ: X]` `` renders as `[ВПИШИ: X]` — no literal backtick visible.
 * This is intentional: contract templates use backticks only for visual
 * emphasis in the source markdown; the PDF has no monospace rendering.
 */
export function parseInlineBold(line: string): Run[] {
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
export function renderTableBlock(
  pdfGen: TextDrawer,
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
      renderParagraph(pdfGen, pdfDoc, cursor, parseInlineBold(text), {
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
    const leftLines = wrapCellLines(cells[0]!, isHeader, COL_WIDTH, regularFont, boldFont)
    const rightLines = wrapCellLines(cells[1]!, isHeader, COL_WIDTH, regularFont, boldFont)

    const totalRowLines = Math.max(leftLines.length, rightLines.length)
    const rowHeight = totalRowLines * lineHeight

    // Available space on the current page.
    const availableSpace = cursor.y - BOTTOM_LIMIT

    if (rowHeight <= availableSpace) {
      // Entire row fits on the current page.
      drawTwoColRow(pdfGen, pdfDoc, cursor, leftLines, rightLines, isHeader, opts)
    } else if (rowHeight > PDF_LAYOUT.pageHeight - PDF_LAYOUT.pageMargin * 2 - 70) {
      // Row is taller than a full page — draw line-by-line, paginating as needed.
      const maxIdx = Math.max(leftLines.length, rightLines.length)
      for (let i = 0; i < maxIdx; i++) {
        ensureSpace(pdfDoc, cursor, lineHeight)
        const lLine = leftLines[i] ?? null
        const rLine = rightLines[i] ?? null
        if (lLine) {
          drawCellLine(pdfGen, cursor, lLine, LEFT_COL_X, isHeader, opts)
        }
        if (rLine) {
          drawCellLine(pdfGen, cursor, rLine, RIGHT_COL_X, isHeader, opts)
        }
        cursor.y -= lineHeight
      }
    } else {
      // Row doesn't fit — start a new page, then draw.
      cursor.page = pdfDoc.addPage([PDF_LAYOUT.pageWidth, PDF_LAYOUT.pageHeight])
      cursor.y = PDF_LAYOUT.pageHeight - PDF_LAYOUT.pageMargin
      drawTwoColRow(pdfGen, pdfDoc, cursor, leftLines, rightLines, isHeader, opts)
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
export function drawTwoColRow(
  pdfGen: TextDrawer,
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
    drawCellLine(pdfGen, { page: cursor.page, y: lineY }, leftLines[i]!, LEFT_COL_X, isHeader, opts)
  }

  // Draw right column lines.
  for (let i = 0; i < rightLines.length; i++) {
    const lineY = topY - i * lineHeight
    drawCellLine(
      pdfGen,
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
export function drawCellLine(
  pdfGen: TextDrawer,
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
    pdfGen.drawText(at.page, run.text, {
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
export function wrapCellLines(
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
export function renderParagraph(
  pdfGen: TextDrawer,
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
  ensureSpace(pdfDoc, cursor, lineHeight)
  let x = startX

  for (const run of runs) {
    const font = opts.forceBold || run.bold ? opts.boldFont : opts.regularFont
    const tokens = run.text.split(/(\s+)/).filter((t) => t.length > 0)
    for (const token of tokens) {
      const tokenWidth = font.widthOfTextAtSize(token, opts.size)
      if (x + tokenWidth > maxRight && x > startX) {
        cursor.y -= lineHeight
        ensureSpace(pdfDoc, cursor, lineHeight)
        x = startX
        if (/^\s+$/.test(token)) continue
      }
      pdfGen.drawText(cursor.page, token, {
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
export function renderParagraphWithBreaks(
  pdfGen: TextDrawer,
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
    renderParagraph(pdfGen, pdfDoc, cursor, parseInlineBold(seg), {
      ...opts,
      indent: 0,
    })
  }
}

/**
 * Ensure at least `needed` vertical points remain before BOTTOM_LIMIT;
 * otherwise start a new page and reset the cursor to the top margin.
 */
export function ensureSpace(pdfDoc: PDFDocument, cursor: Cursor, needed: number): void {
  if (cursor.y - needed < BOTTOM_LIMIT) {
    cursor.page = pdfDoc.addPage([PDF_LAYOUT.pageWidth, PDF_LAYOUT.pageHeight])
    cursor.y = PDF_LAYOUT.pageHeight - PDF_LAYOUT.pageMargin
  }
}
