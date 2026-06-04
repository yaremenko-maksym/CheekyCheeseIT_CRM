/**
 * PdfGenerationService — shared helpers for PDF document creation.
 *
 * Extracted from `invoices/invoice-pdf.service.ts` (Phase 1 refactor) so that
 * future PDF features (ContractPdfService — Phase 2) can reuse the same font
 * loading, metadata pinning, QR embedding and drawing primitives without
 * duplication.
 *
 * This service owns ONLY the cross-cutting infrastructure:
 *   - `createDocument()` — bootstrap a PDFDocument with embedded Roboto fonts
 *   - `applyDeterministicMetadata()` — pin CreationDate/ModDate for byte-stability
 *   - `embedQrPng()` — generate and embed a QR code PNG
 *   - `drawText()` / `drawSeparator()` — thin wrappers over pdf-lib primitives
 *
 * Invoice-specific rendering (header, signature blocks, ЗАКАЗЧИК block, etc.)
 * stays in `InvoicePdfService`.
 *
 * Determinism contract: same inputs → byte-identical output → same SHA-256.
 * Achieved via (1) overriding pdf-lib's CreationDate/ModDate, (2) callers
 * passing `useObjectStreams: false` in `doc.save()`, and (3) consistent
 * Roboto font subset embedding.
 */
import { Injectable, Logger } from '@nestjs/common'
import { PDFDocument, PDFFont, PDFImage, PDFPage, type Color } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import QRCode from 'qrcode'

import { loadFontBuffer } from './pdf.utils'
import { PDF_BRAND } from './pdf.constants'

// ---------------------------------------------------------------------------
// Draw-text options type
// ---------------------------------------------------------------------------

/** Options for the `drawText` helper. Mirrors pdf-lib's drawText signature. */
export interface DrawTextOptions {
  x: number
  y: number
  font: PDFFont
  size: number
  color: Color
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class PdfGenerationService {
  private readonly logger = new Logger(PdfGenerationService.name)

  // ---------------------------------------------------------------------------
  // Document bootstrap
  // ---------------------------------------------------------------------------

  /**
   * Create a new PDFDocument with Roboto Regular and Bold fonts embedded.
   *
   * Both fonts are loaded via `loadFontBuffer()` which caches the TTF bytes
   * in-process so subsequent calls are essentially free.
   *
   * The caller is responsible for adding pages and calling `doc.save()`.
   */
  async createDocument(): Promise<{
    pdfDoc: PDFDocument
    regularFont: PDFFont
    boldFont: PDFFont
  }> {
    const pdfDoc = await PDFDocument.create()
    pdfDoc.registerFontkit(fontkit)

    const regularBytes = loadFontBuffer('Roboto-Regular.ttf')
    const boldBytes = loadFontBuffer('Roboto-Bold.ttf')

    // `subset: true` keeps only the glyphs that are actually used in the
    // document — critical for Cyrillic: without subsetting pdf-lib's WinAnsi
    // fallback renders Cyrillic codepoints as boxes.
    const regularFont = await pdfDoc.embedFont(regularBytes, { subset: true })
    const boldFont = await pdfDoc.embedFont(boldBytes, { subset: true })

    this.logger.debug('PDFDocument created with Roboto Regular + Bold fonts')

    return { pdfDoc, regularFont, boldFont }
  }

  // ---------------------------------------------------------------------------
  // Deterministic metadata
  // ---------------------------------------------------------------------------

  /**
   * Override pdf-lib's auto-generated CreationDate and ModDate with a
   * caller-supplied fixed date.
   *
   * pdf-lib uses `new Date()` by default which makes every `doc.save()` call
   * produce a different byte stream — breaking the hash-equality contract
   * relied on by the invoice verify path. Pinning both dates to the
   * transaction timestamp makes the output byte-identical for the same input.
   *
   * Also sets Producer / Creator to the brand string so metadata is
   * consistent across document types.
   */
  applyDeterministicMetadata(pdfDoc: PDFDocument, fixedDate: Date): void {
    pdfDoc.setCreationDate(fixedDate)
    pdfDoc.setModificationDate(fixedDate)
    pdfDoc.setProducer(PDF_BRAND.producerString)
    pdfDoc.setCreator(PDF_BRAND.producerString)
  }

  // ---------------------------------------------------------------------------
  // QR code
  // ---------------------------------------------------------------------------

  /**
   * Generate a QR PNG for `text` and embed it in `pdfDoc`.
   *
   * Uses medium error correction (M) — more redundancy than L but survives
   * photo-of-screen scenarios that printed QRs frequently encounter.
   * Width 220px gives enough resolution for a 80pt rendered size on A4.
   */
  async embedQrPng(pdfDoc: PDFDocument, text: string): Promise<PDFImage> {
    const qrPngBuffer = await QRCode.toBuffer(text, {
      errorCorrectionLevel: 'M',
      type: 'png',
      width: 220,
      margin: 1,
      color: { dark: '#141414', light: '#ffffff' },
    })

    return pdfDoc.embedPng(qrPngBuffer)
  }

  // ---------------------------------------------------------------------------
  // Drawing helpers
  // ---------------------------------------------------------------------------

  /**
   * Thin wrapper over `page.drawText` with named options.
   *
   * Centralises the call site so future changes (e.g. adding link annotations)
   * only require a change here rather than at every draw site.
   */
  drawText(page: PDFPage, text: string, opts: DrawTextOptions): void {
    page.drawText(text, {
      x: opts.x,
      y: opts.y,
      size: opts.size,
      font: opts.font,
      color: opts.color,
    })
  }

  /**
   * Draw a thin horizontal separator line and return the new Y cursor
   * (advanced by 14pt below the line).
   *
   * @param page - Target PDF page.
   * @param x1 - Start X coordinate (typically the left margin).
   * @param x2 - End X coordinate (typically margin + contentWidth).
   * @param y - Y coordinate where the line is drawn.
   * @param color - Line color (uses separator color from PDF_COLORS by default).
   * @returns New Y cursor: `y - 14`.
   */
  drawSeparator(page: PDFPage, x1: number, x2: number, y: number, color: Color): number {
    page.drawLine({
      start: { x: x1, y },
      end: { x: x2, y },
      thickness: 0.5,
      color,
    })
    return y - 14
  }
}
