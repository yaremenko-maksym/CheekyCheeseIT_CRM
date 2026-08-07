/**
 * ResumePdfService — renders a senior's canonical resume onto our own PDF
 * template (task-resume-base §3, AC8).
 *
 * Built ENTIRELY on the shared `PdfGenerationService`: it owns the embedded
 * Roboto Regular/Bold fonts, and those are the reason Cyrillic renders at all.
 * pdf-lib's standard fonts are WinAnsi-only and turn Cyrillic into boxes, so a
 * fresh `PDFDocument` here would silently regress every Russian resume — hence
 * the task's instruction to reuse the service instead of newing up a document
 * (same contract InvoicePdfService / ContractPdfService / TosPdfService follow).
 *
 * SECURITY: resume content is untrusted (user file -> external model -> here).
 * Nothing in it is INTERPRETED: every string is drawn as literal text with
 * `drawText`, there is no markdown/HTML pass, and links are drawn as plain text
 * (no PDF link annotations) — so `javascript:` or markup inside a resume is at
 * worst ugly, never active. Wrapping is width-measured so long unbroken input
 * cannot overflow the page or wedge the layout.
 */
import { Injectable } from '@nestjs/common'
import { rgb, type PDFFont, type PDFPage, type PDFDocument } from 'pdf-lib'
import type { ResumeContent } from '@crm/shared'
import { PdfGenerationService } from '../common/pdf/pdf-generation.service'
import { PDF_BRAND, PDF_COLORS, PDF_LAYOUT } from '../common/pdf/pdf.constants'

const FONT_SIZE = {
  name: 20,
  sectionTitle: 12,
  itemTitle: 11,
  body: 10,
  meta: 9,
} as const

const BOTTOM_MARGIN = 60

interface RenderCursor {
  page: PDFPage
  y: number
}

export interface GenerateResumePdfParams {
  /** Display name of the senior the resume belongs to. */
  displayName: string
  content: ResumeContent
  /** Pinned for deterministic metadata (byte-stable output for a given input). */
  generatedAt: Date
}

@Injectable()
export class ResumePdfService {
  constructor(private readonly pdf: PdfGenerationService) {}

  async generateResumePdf({
    displayName,
    content,
    generatedAt,
  }: GenerateResumePdfParams): Promise<Buffer> {
    const { pdfDoc, regularFont, boldFont } = await this.pdf.createDocument()
    this.pdf.applyDeterministicMetadata(pdfDoc, generatedAt)
    pdfDoc.setTitle(`Резюме — ${displayName}`)

    const cursor: RenderCursor = {
      page: pdfDoc.addPage([PDF_LAYOUT.pageWidth, PDF_LAYOUT.pageHeight]),
      y: PDF_LAYOUT.pageHeight - PDF_LAYOUT.pageMargin,
    }

    // ---- Header: brand mark + name -----------------------------------------
    this.pdf.drawBrandMark(
      cursor.page,
      PDF_LAYOUT.pageMargin,
      cursor.y - PDF_LAYOUT.brandMarkSize,
      PDF_LAYOUT.brandMarkSize,
      rgb(PDF_COLORS.brand.r, PDF_COLORS.brand.g, PDF_COLORS.brand.b),
    )
    this.pdf.drawText(cursor.page, displayName, {
      x: PDF_LAYOUT.pageMargin + PDF_LAYOUT.brandMarkSize + 14,
      y: cursor.y - FONT_SIZE.name - 2,
      font: boldFont,
      size: FONT_SIZE.name,
      color: rgb(PDF_COLORS.text.r, PDF_COLORS.text.g, PDF_COLORS.text.b),
    })
    cursor.y -= PDF_LAYOUT.brandMarkSize + 10
    cursor.y = this.pdf.drawSeparator(
      cursor.page,
      PDF_LAYOUT.pageMargin,
      PDF_LAYOUT.pageMargin + PDF_LAYOUT.contentWidth,
      cursor.y,
      rgb(PDF_COLORS.separator.r, PDF_COLORS.separator.g, PDF_COLORS.separator.b),
    )

    // ---- Sections -----------------------------------------------------------
    if (content.summary.trim() !== '') {
      this.section(pdfDoc, cursor, 'О себе', boldFont)
      this.paragraph(pdfDoc, cursor, content.summary, regularFont, FONT_SIZE.body)
    }

    if (content.skills.length > 0) {
      this.section(pdfDoc, cursor, 'Навыки', boldFont)
      this.paragraph(pdfDoc, cursor, content.skills.join(' · '), regularFont, FONT_SIZE.body)
    }

    if (content.experience.length > 0) {
      this.section(pdfDoc, cursor, 'Опыт работы', boldFont)
      for (const item of content.experience) {
        const heading = [item.role, item.company].filter((s) => s.trim() !== '').join(' — ')
        if (heading !== '') {
          this.paragraph(pdfDoc, cursor, heading, boldFont, FONT_SIZE.itemTitle)
        }
        if (item.period.trim() !== '') {
          this.paragraph(pdfDoc, cursor, item.period, regularFont, FONT_SIZE.meta, PDF_COLORS.muted)
        }
        for (const bullet of item.bullets) {
          if (bullet.trim() === '') continue
          this.paragraph(pdfDoc, cursor, `• ${bullet}`, regularFont, FONT_SIZE.body, undefined, 12)
        }
        cursor.y -= 6
      }
    }

    if (content.education.length > 0) {
      this.section(pdfDoc, cursor, 'Образование', boldFont)
      for (const item of content.education) {
        const heading = [item.degree, item.institution].filter((s) => s.trim() !== '').join(' — ')
        if (heading !== '') {
          this.paragraph(pdfDoc, cursor, heading, regularFont, FONT_SIZE.body)
        }
        if (item.period.trim() !== '') {
          this.paragraph(pdfDoc, cursor, item.period, regularFont, FONT_SIZE.meta, PDF_COLORS.muted)
        }
      }
    }

    if (content.languages.length > 0) {
      this.section(pdfDoc, cursor, 'Языки', boldFont)
      const line = content.languages
        .map((l) => [l.name, l.level].filter((s) => s.trim() !== '').join(' — '))
        .filter((s) => s !== '')
        .join(' · ')
      if (line !== '') this.paragraph(pdfDoc, cursor, line, regularFont, FONT_SIZE.body)
    }

    if (content.links.length > 0) {
      this.section(pdfDoc, cursor, 'Ссылки', boldFont)
      for (const link of content.links) {
        // Drawn as inert text, never as a PDF link annotation — see the class
        // doc: nothing from a resume is ever made clickable.
        const line = link.label.trim() === '' ? link.url : `${link.label}: ${link.url}`
        this.paragraph(pdfDoc, cursor, line, regularFont, FONT_SIZE.body)
      }
    }

    // ---- Footer -------------------------------------------------------------
    this.pdf.drawText(cursor.page, PDF_BRAND.producerString, {
      x: PDF_LAYOUT.pageMargin,
      y: 32,
      font: regularFont,
      size: FONT_SIZE.meta,
      color: rgb(PDF_COLORS.footer.r, PDF_COLORS.footer.g, PDF_COLORS.footer.b),
    })

    const bytes = await pdfDoc.save({ useObjectStreams: false })
    return Buffer.from(bytes)
  }

  // -------------------------------------------------------------------------
  // Layout primitives
  // -------------------------------------------------------------------------

  private section(doc: PDFDocument, cursor: RenderCursor, title: string, font: PDFFont): void {
    cursor.y -= 10
    this.ensureSpace(doc, cursor, FONT_SIZE.sectionTitle + PDF_LAYOUT.lineHeight)
    this.pdf.drawText(cursor.page, title.toUpperCase(), {
      x: PDF_LAYOUT.pageMargin,
      y: cursor.y - FONT_SIZE.sectionTitle,
      font,
      size: FONT_SIZE.sectionTitle,
      color: rgb(PDF_COLORS.accent.r, PDF_COLORS.accent.g, PDF_COLORS.accent.b),
    })
    cursor.y -= FONT_SIZE.sectionTitle + 8
  }

  private paragraph(
    doc: PDFDocument,
    cursor: RenderCursor,
    text: string,
    font: PDFFont,
    size: number,
    color: { r: number; g: number; b: number } = PDF_COLORS.text,
    indent = 0,
  ): void {
    const maxWidth = PDF_LAYOUT.contentWidth - indent
    for (const line of wrapText(text, font, size, maxWidth)) {
      this.ensureSpace(doc, cursor, size + 4)
      this.pdf.drawText(cursor.page, line, {
        x: PDF_LAYOUT.pageMargin + indent,
        y: cursor.y - size,
        font,
        size,
        color: rgb(color.r, color.g, color.b),
      })
      cursor.y -= size + 4
    }
  }

  /** Start a new page when the next line would fall below the bottom margin. */
  private ensureSpace(doc: PDFDocument, cursor: RenderCursor, needed: number): void {
    if (cursor.y - needed >= BOTTOM_MARGIN) return
    cursor.page = doc.addPage([PDF_LAYOUT.pageWidth, PDF_LAYOUT.pageHeight])
    cursor.y = PDF_LAYOUT.pageHeight - PDF_LAYOUT.pageMargin
  }
}

/**
 * Greedy word wrap measured against the REAL embedded font, so Cyrillic (wider
 * glyphs than the Latin equivalent) wraps correctly instead of running off the
 * page. A single word longer than the line — e.g. a pasted 400-char URL — is
 * hard-split by character so untrusted input can never produce an overflowing,
 * unreadable line.
 */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = []
  for (const rawLine of text.split('\n')) {
    let current = ''
    for (const word of rawLine.split(' ')) {
      const candidate = current === '' ? word : `${current} ${word}`
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate
        continue
      }
      if (current !== '') lines.push(current)
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        current = word
        continue
      }
      // Word alone is wider than the line — split it by character.
      let chunk = ''
      for (const ch of word) {
        if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth && chunk !== '') {
          lines.push(chunk)
          chunk = ch
        } else {
          chunk += ch
        }
      }
      current = chunk
    }
    lines.push(current)
  }
  return lines
}
