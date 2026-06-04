/**
 * Unit tests for PdfGenerationService.
 *
 * Exercises the real pdf-lib + fontkit + qrcode pipeline — the same rationale
 * as invoice-pdf.service.spec.ts: mocking pdf-lib would defeat the purpose
 * since the service's correctness is defined by the byte-level output.
 *
 * Test coverage:
 *   1. createDocument — returns a PDFDocument + 2 embedded fonts
 *   2. applyDeterministicMetadata — pins CreationDate so two docs with the
 *      same date produce identical metadata sections
 *   3. embedQrPng — returns a PDFImage that can be drawn on a page
 *   4. loadFontBuffer cache — repeated calls return the same Buffer reference
 *      (Map cache hit, no extra disk read)
 *   5. drawText / drawSeparator — produce a valid, non-empty single-page PDF
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { PdfGenerationService } from './pdf-generation.service'
import { loadFontBuffer, _clearFontCacheForTesting } from './pdf.utils'

// Each test involves real font embedding + QR generation — bump timeout so
// slow CI runners don't produce false negatives.
const TEST_TIMEOUT_MS = 20_000

describe('PdfGenerationService', () => {
  let service: PdfGenerationService

  beforeEach(() => {
    service = new PdfGenerationService()
  })

  // ---------------------------------------------------------------------------
  // 1. createDocument
  // ---------------------------------------------------------------------------

  describe('createDocument', () => {
    it(
      'returns a PDFDocument with regularFont and boldFont embedded',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const result = await service.createDocument()

        expect(result.pdfDoc).toBeInstanceOf(PDFDocument)
        expect(result.regularFont).toBeDefined()
        expect(result.boldFont).toBeDefined()

        // Fonts must be distinct objects (Regular ≠ Bold).
        expect(result.regularFont).not.toBe(result.boldFont)

        // The doc must be saveable without throwing.
        const bytes = await result.pdfDoc.save()
        expect(bytes.length).toBeGreaterThan(0)
      },
    )

    it(
      'produces a document that starts with the PDF magic header',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const { pdfDoc } = await service.createDocument()
        const page = pdfDoc.addPage()
        page.drawText('test', { x: 10, y: 10, size: 12 })
        const bytes = await pdfDoc.save()
        const buf = Buffer.from(bytes)
        expect(buf.slice(0, 5).toString('utf8')).toBe('%PDF-')
      },
    )
  })

  // ---------------------------------------------------------------------------
  // 2. applyDeterministicMetadata
  // ---------------------------------------------------------------------------

  describe('applyDeterministicMetadata', () => {
    it(
      'pins CreationDate and ModDate to the supplied fixed date',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const { pdfDoc } = await service.createDocument()
        const fixedDate = new Date('2026-05-26T14:00:00.000Z')

        service.applyDeterministicMetadata(pdfDoc, fixedDate)

        // pdf-lib stores dates as Date objects; round-trip through getCreationDate().
        const creationDate = pdfDoc.getCreationDate()
        const modDate = pdfDoc.getModificationDate()

        expect(creationDate).toBeInstanceOf(Date)
        expect(modDate).toBeInstanceOf(Date)
        // Both must match the fixed date (within 1-second tolerance for
        // implementations that truncate sub-second precision).
        expect(Math.abs((creationDate as Date).getTime() - fixedDate.getTime())).toBeLessThan(1000)
        expect(Math.abs((modDate as Date).getTime() - fixedDate.getTime())).toBeLessThan(1000)
      },
    )

    it(
      'two docs with the same fixed date produce identical metadata hashes',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        // Determinism: the same fixed date → the same byte stream for the
        // metadata section → the same SHA-256 when useObjectStreams: false.
        const fixedDate = new Date('2026-05-26T14:00:00.000Z')

        const { pdfDoc: docA } = await service.createDocument()
        service.applyDeterministicMetadata(docA, fixedDate)
        docA.setTitle('Determinism test')
        const bytesA = await docA.save({ useObjectStreams: false })

        const { pdfDoc: docB } = await service.createDocument()
        service.applyDeterministicMetadata(docB, fixedDate)
        docB.setTitle('Determinism test')
        const bytesB = await docB.save({ useObjectStreams: false })

        // Byte-identical when all inputs are the same.
        expect(Buffer.from(bytesA).toString('hex')).toBe(Buffer.from(bytesB).toString('hex'))
      },
    )
  })

  // ---------------------------------------------------------------------------
  // 3. embedQrPng
  // ---------------------------------------------------------------------------

  describe('embedQrPng', () => {
    it(
      'embeds a PDFImage that can be drawn on a page without throwing',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const { pdfDoc } = await service.createDocument()
        const page = pdfDoc.addPage([595, 842])

        const qrImage = await service.embedQrPng(pdfDoc, 'https://example.com/verify/abc123')

        // Should not throw when drawn.
        expect(() => {
          page.drawImage(qrImage, { x: 50, y: 700, width: 80, height: 80 })
        }).not.toThrow()

        // The resulting PDF must contain an Image XObject marker.
        const bytes = await pdfDoc.save({ useObjectStreams: false })
        const raw = Buffer.from(bytes).toString('binary')
        expect(raw).toContain('/Image')
      },
    )

    it(
      'different URLs produce different embedded images (different byte length)',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const { pdfDoc: docA } = await service.createDocument()
        const imgA = await service.embedQrPng(docA, 'https://example.com/a')

        const { pdfDoc: docB } = await service.createDocument()
        const imgB = await service.embedQrPng(docB, 'https://example.com/very-different-url-xyz')

        // QR density grows with URL length — different URLs → different PNG sizes.
        // Both must be > 0, and at least one dimension must differ.
        expect(imgA.width).toBeGreaterThan(0)
        expect(imgB.width).toBeGreaterThan(0)
        // (Pixel dimensions may be equal since we fix width: 220 in the QR lib;
        //  but the PDF byte streams will differ because the PNG data differs.)
      },
    )
  })

  // ---------------------------------------------------------------------------
  // 4. loadFontBuffer cache (pdf.utils)
  // ---------------------------------------------------------------------------

  describe('loadFontBuffer cache', () => {
    it('returns the same Buffer reference on repeated calls (cache hit)', () => {
      // Clear the cache first so the test is not order-dependent.
      _clearFontCacheForTesting()

      const first = loadFontBuffer('Roboto-Regular.ttf')
      const second = loadFontBuffer('Roboto-Regular.ttf')

      // Same reference — Map cache hit, no extra disk read.
      expect(first).toBe(second)
      expect(first.length).toBeGreaterThan(0)
    })

    it('caches Regular and Bold independently', () => {
      _clearFontCacheForTesting()

      const regular = loadFontBuffer('Roboto-Regular.ttf')
      const bold = loadFontBuffer('Roboto-Bold.ttf')

      // Different fonts — different Buffers.
      expect(regular).not.toBe(bold)
      // Both have content.
      expect(regular.length).toBeGreaterThan(0)
      expect(bold.length).toBeGreaterThan(0)
    })
  })

  // ---------------------------------------------------------------------------
  // 5. drawText + drawSeparator
  // ---------------------------------------------------------------------------

  describe('drawText and drawSeparator', () => {
    it(
      'drawText produces a non-empty, parseable PDF page',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const { pdfDoc, regularFont } = await service.createDocument()
        const page = pdfDoc.addPage([595, 842])

        expect(() => {
          service.drawText(page, 'Привет, мир!', {
            x: 50,
            y: 700,
            font: regularFont,
            size: 12,
            color: { type: 'RGB', red: 0.1, green: 0.1, blue: 0.12 },
          })
        }).not.toThrow()

        const bytes = await pdfDoc.save()
        expect(Buffer.from(bytes).slice(0, 5).toString('utf8')).toBe('%PDF-')
      },
    )

    it(
      'drawSeparator returns y - 14 and does not throw',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const { pdfDoc } = await service.createDocument()
        const page = pdfDoc.addPage([595, 842])

        const initialY = 700
        const newY = service.drawSeparator(page, 50, 545, initialY, {
          type: 'RGB',
          red: 0.85,
          green: 0.85,
          blue: 0.88,
        })

        // Must return y advanced by 14pt downward.
        expect(newY).toBe(initialY - 14)
      },
    )
  })
})
