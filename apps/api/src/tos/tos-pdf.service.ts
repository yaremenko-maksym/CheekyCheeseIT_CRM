/**
 * ToS PDF rendering service.
 *
 * Generates a clean, document-quality PDF for a Terms of Service body.
 * Deliberately NO contract chrome (no «Контракт №», no signature block,
 * no QR / verify footer) — the output is a pure formatted document.
 *
 * Reuses:
 *   - `PdfGenerationService` (createDocument, drawText, drawSeparator,
 *     drawBrandMark, applyDeterministicMetadata)
 *   - `PDF_COLORS`, `PDF_LAYOUT`, `PDF_BRAND` constants from common/pdf
 *
 * The markdown-to-PDF rendering mirrors `ContractPdfService.generateContractPdf`
 * for the body section only — letterhead + body, that's it.
 */
import { Injectable } from '@nestjs/common'
import { rgb, type PDFDocument, type PDFFont, type PDFPage, type Color } from 'pdf-lib'

import { PdfGenerationService } from '../common/pdf/pdf-generation.service'
import { PDF_COLORS, PDF_LAYOUT, PDF_BRAND } from '../common/pdf/pdf.constants'

// ---------------------------------------------------------------------------
// Text sizing
// ---------------------------------------------------------------------------

const BODY_SIZE = 11
const H1_SIZE = 16
const H2_SIZE = 13
const H3_SIZE = 12
const BULLET_INDENT = 14
const BOTTOM_LIMIT = PDF_LAYOUT.pageMargin + 40

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Mutable rendering cursor — tracks the active page and Y baseline. */
interface Cursor {
  page: PDFPage
  y: number
}

/** A styled text run produced by inline-bold parsing. */
interface Run {
  text: string
  bold: boolean
}

// ---------------------------------------------------------------------------
// Helpers (module-level, mirroring contract-pdf.service.ts)
// ---------------------------------------------------------------------------

/** Split a line into alternating regular / bold runs on `**` markers. */
function parseInlineBold(line: string): Run[] {
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
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class TosPdfService {
  constructor(private readonly pdfGen: PdfGenerationService) {}

  /**
   * Render a clean ToS PDF from raw markdown.
   *
   * @param bodyMarkdown - Raw markdown content (ToS body).
   * @returns Buffer containing the PDF bytes.
   */
  async generateTosPdf(bodyMarkdown: string): Promise<Buffer> {
    const { pdfDoc, regularFont, boldFont } = await this.pdfGen.createDocument()

    const textColor = rgb(PDF_COLORS.text.r, PDF_COLORS.text.g, PDF_COLORS.text.b)
    const mutedColor = rgb(PDF_COLORS.muted.r, PDF_COLORS.muted.g, PDF_COLORS.muted.b)
    const brandColor = rgb(PDF_COLORS.brand.r, PDF_COLORS.brand.g, PDF_COLORS.brand.b)
    const separatorColor = rgb(
      PDF_COLORS.separator.r,
      PDF_COLORS.separator.g,
      PDF_COLORS.separator.b,
    )

    const { pageWidth, pageHeight, pageMargin, contentWidth } = PDF_LAYOUT
    const rightEdge = pageMargin + contentWidth

    const cursor: Cursor = {
      page: pdfDoc.addPage([pageWidth, pageHeight]),
      y: pageHeight - pageMargin,
    }

    // ---- Letterhead: brand mark + company name --------------------------------
    const markSize = PDF_LAYOUT.brandMarkSize
    const markX = pageMargin
    const markY = cursor.y - markSize
    this.pdfGen.drawBrandMark(cursor.page, markX, markY, markSize, brandColor)

    const wordmarkFontSize = 16
    const wordmarkX = markX + markSize + 10
    this.pdfGen.drawText(cursor.page, PDF_BRAND.companyName, {
      x: wordmarkX,
      y: markY + (markSize - wordmarkFontSize) / 2 + wordmarkFontSize * 0.25,
      font: boldFont,
      size: wordmarkFontSize,
      color: textColor,
    })

    cursor.y -= markSize + 10

    // Separator under letterhead
    cursor.y = this.pdfGen.drawSeparator(
      cursor.page,
      pageMargin,
      rightEdge,
      cursor.y,
      separatorColor,
    )
    cursor.y -= 8

    // ---- Body (markdown) -------------------------------------------------------
    const lines = bodyMarkdown.split('\n')

    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/, '')

      // Blank line → paragraph gap
      if (line.trim() === '') {
        cursor.y -= BODY_SIZE * 0.6
        continue
      }

      // Horizontal rule → thin separator
      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
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

      // Blockquote
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

      // H1
      if (line.startsWith('# ')) {
        this.ensureSpace(pdfDoc, cursor, H1_SIZE * 2)
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

      // H2
      if (line.startsWith('## ')) {
        this.ensureSpace(pdfDoc, cursor, H2_SIZE * 2)
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

      // H3
      if (line.startsWith('### ')) {
        this.ensureSpace(pdfDoc, cursor, H3_SIZE * 2)
        this.renderParagraphWithBreaks(pdfDoc, cursor, line.slice(4), {
          size: H3_SIZE,
          forceBold: true,
          regularFont,
          boldFont,
          color: textColor,
          leftX: pageMargin,
          rightEdge,
        })
        continue
      }

      // Bullet list
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

      // Numbered list (1. 2. etc.)
      const numberedMatch = /^(\d+\.\s+)(.*)$/.exec(line)
      if (numberedMatch) {
        const prefix = numberedMatch[1] ?? ''
        const rest = numberedMatch[2] ?? ''
        this.ensureSpace(pdfDoc, cursor, PDF_LAYOUT.lineHeight)
        this.pdfGen.drawText(cursor.page, prefix.trim(), {
          x: pageMargin,
          y: cursor.y,
          font: regularFont,
          size: BODY_SIZE,
          color: textColor,
        })
        this.renderParagraph(pdfDoc, cursor, parseInlineBold(rest), {
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

      // Regular paragraph
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

    // ---- Deterministic metadata + save ----------------------------------------
    this.pdfGen.applyDeterministicMetadata(pdfDoc, new Date(0))
    const bytes = await pdfDoc.save({ useObjectStreams: false })
    return Buffer.from(bytes)
  }

  // ---------------------------------------------------------------------------
  // Private rendering helpers (mirrors contract-pdf.service.ts helpers)
  // ---------------------------------------------------------------------------

  /**
   * Render a paragraph with optional `<br>` splits.
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
   * Render a single styled paragraph (array of runs) with word-wrapping.
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
    const { size, forceBold, indent, regularFont, boldFont, color, leftX, rightEdge } = opts
    const availableWidth = rightEdge - leftX - indent

    // Flatten all runs into word-level tokens preserving run boundaries
    type Token = { word: string; bold: boolean }
    const tokens: Token[] = []
    for (const run of runs) {
      const words = run.text.split(/\s+/)
      for (const word of words) {
        if (word.length > 0) tokens.push({ word, bold: forceBold || run.bold })
      }
    }

    let lineX = leftX + indent
    let lineTokens: Token[] = []

    const flushLine = (isLast: boolean) => {
      if (lineTokens.length === 0) return
      this.ensureSpace(pdfDoc, cursor, size + 2)
      let x = leftX + indent

      for (let i = 0; i < lineTokens.length; i++) {
        const token = lineTokens[i]
        if (!token) continue
        const { word, bold } = token
        const font = bold ? boldFont : regularFont
        this.pdfGen.drawText(cursor.page, word, { x, y: cursor.y, font, size, color })
        const wordWidth = font.widthOfTextAtSize(word, size)
        const spaceWidth = regularFont.widthOfTextAtSize(' ', size)
        x += wordWidth + (i < lineTokens.length - 1 ? spaceWidth : 0)
      }

      cursor.y -= size + (isLast ? size * 0.3 : size * 0.2)
      lineTokens = []
      lineX = leftX + indent
    }

    for (const token of tokens) {
      const font = forceBold || token.bold ? boldFont : regularFont
      const wordWidth = font.widthOfTextAtSize(token.word, size)
      const spaceWidth = regularFont.widthOfTextAtSize(' ', size)
      const neededWidth =
        lineTokens.length === 0 ? wordWidth : lineX - (leftX + indent) + spaceWidth + wordWidth

      // Word too long for even a fresh line — draw char-by-char
      if (lineTokens.length === 0 && wordWidth > availableWidth) {
        let charBuf = ''
        let charX = leftX + indent
        for (const ch of token.word) {
          const cw = font.widthOfTextAtSize(ch, size)
          if (charX + cw > rightEdge) {
            if (charBuf) {
              this.ensureSpace(pdfDoc, cursor, size + 2)
              this.pdfGen.drawText(cursor.page, charBuf, {
                x: leftX + indent,
                y: cursor.y,
                font,
                size,
                color,
              })
              cursor.y -= size + size * 0.2
            }
            charBuf = ch
            charX = leftX + indent + cw
          } else {
            charBuf += ch
            charX += cw
          }
        }
        if (charBuf) {
          lineTokens.push({ word: charBuf, bold: token.bold })
          lineX = leftX + indent + font.widthOfTextAtSize(charBuf, size)
        }
        continue
      }

      if (neededWidth > availableWidth && lineTokens.length > 0) {
        flushLine(false)
      }

      const currentFont = forceBold || token.bold ? boldFont : regularFont
      const currentWidth = currentFont.widthOfTextAtSize(token.word, size)
      const sp = regularFont.widthOfTextAtSize(' ', size)
      lineX += (lineTokens.length === 0 ? 0 : sp) + currentWidth
      lineTokens.push(token)
    }

    flushLine(true)
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
