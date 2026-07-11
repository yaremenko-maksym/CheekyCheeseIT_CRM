import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'

import { TosPdfService } from './tos-pdf.service'
import { PdfGenerationService } from '../common/pdf/pdf-generation.service'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect every string passed to pdfGen.drawText during one generateTosPdf call.
 * pdf-lib embeds font glyphs into content streams — not readable as plain text
 * in the output buffer. Spying on drawText is the correct approach.
 */
async function drawnTexts(service: TosPdfService, pdfGen: PdfGenerationService, markdown: string) {
  const spy = vi.spyOn(pdfGen, 'drawText')
  await service.generateTosPdf(markdown)
  const texts = spy.mock.calls
    .map((call) => call[1])
    .filter((t): t is string => typeof t === 'string')
  spy.mockRestore()
  return texts
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('TosPdfService', () => {
  let service: TosPdfService
  let pdfGen: PdfGenerationService

  beforeEach(() => {
    pdfGen = new PdfGenerationService()
    service = new TosPdfService(pdfGen)
  })

  // ── Core output ───────────────────────────────────────────────────────────

  it('produces a non-empty PDF buffer starting with %PDF-', async () => {
    const buf = await service.generateTosPdf('# ToS\n\nSome content.')
    expect(buf.length).toBeGreaterThan(1000)
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('is byte-deterministic — identical input yields identical bytes twice', async () => {
    const md = '# Terms of Service\n\nContent paragraph.\n\n- Point 1\n- Point 2'
    const first = await service.generateTosPdf(md)
    const second = await service.generateTosPdf(md)
    expect(first.equals(second)).toBe(true)
  })

  it('different markdown yields different bytes', async () => {
    const a = await service.generateTosPdf('# Version 1\n\nContent A.')
    const b = await service.generateTosPdf('# Version 2\n\nContent B.')
    expect(a.equals(b)).toBe(false)
  })

  // ── Heading rendering ─────────────────────────────────────────────────────

  it('renders H1 heading text', async () => {
    const texts = await drawnTexts(service, pdfGen, '# Terms of Service\n\nBody.')
    expect(
      texts.some((t) => t.includes('Terms') || t.includes('of') || t.includes('Service')),
    ).toBe(true)
  })

  it('renders H2 heading text', async () => {
    const texts = await drawnTexts(service, pdfGen, '## Section 2\n\nBody.')
    expect(texts.some((t) => t.includes('Section'))).toBe(true)
  })

  it('renders H3 heading text', async () => {
    const texts = await drawnTexts(service, pdfGen, '### Sub-section\n\nBody.')
    expect(texts.some((t) => t.includes('Sub-section'))).toBe(true)
  })

  // ── Body content ──────────────────────────────────────────────────────────

  it('renders body paragraph text', async () => {
    const texts = await drawnTexts(service, pdfGen, '# ToS\n\nAgreeableContent paragraph.')
    expect(texts.some((t) => t.includes('AgreeableContent'))).toBe(true)
  })

  it('renders bullet list items (without the "- " prefix)', async () => {
    const texts = await drawnTexts(service, pdfGen, '- UniqueItem one\n- UniqueItem two')
    expect(texts.some((t) => t.includes('UniqueItem'))).toBe(true)
    expect(texts).toContain('•')
  })

  it('renders numbered list items', async () => {
    const texts = await drawnTexts(service, pdfGen, '1. FirstItem\n2. SecondItem')
    expect(texts.some((t) => t.includes('FirstItem') || t.includes('SecondItem'))).toBe(true)
  })

  it('renders blockquote content without the ">" character', async () => {
    const texts = await drawnTexts(service, pdfGen, '> ImportantDisclaimer text.')
    expect(texts.some((t) => t.includes('ImportantDisclaimer'))).toBe(true)
    expect(texts.every((t) => !t.startsWith('>'))).toBe(true)
  })

  it('renders Cyrillic body text without throwing', async () => {
    await expect(
      service.generateTosPdf(
        '# Умови надання послуг\n\nЦі умови регулюють використання платформи.',
      ),
    ).resolves.toBeDefined()
  })

  // ── No contract chrome ────────────────────────────────────────────────────
  // AC3: ToS PDF must NOT contain contract-specific chrome.

  it('AC3: does NOT draw "Контракт №" text', async () => {
    const texts = await drawnTexts(service, pdfGen, '# ToS\n\nBody.')
    expect(texts.every((t) => !t.includes('Контракт') && !t.includes('Contract №'))).toBe(true)
  })

  it('AC3: does NOT draw any signature block heading', async () => {
    const texts = await drawnTexts(service, pdfGen, '# ToS\n\nBody.')
    // Contract PDF draws "Підписи сторін" and "Від CheekyCheeseIT" — ToS must not
    expect(texts.every((t) => t !== 'Підписи сторін' && t !== 'Підписи сторін / Signatures')).toBe(
      true,
    )
    expect(texts.every((t) => !t.includes('Від CheekyCheeseIT'))).toBe(true)
  })

  it('AC3: does NOT draw any QR/verify footer text', async () => {
    const texts = await drawnTexts(service, pdfGen, '# ToS\n\nBody.')
    expect(texts.every((t) => !t.includes('Перевірка:') && !t.includes('verify'))).toBe(true)
  })

  it('AC3: does NOT draw "Потрібен підпис учасника" (unsigned preview text from contract)', async () => {
    const texts = await drawnTexts(service, pdfGen, '# ToS\n\nBody.')
    expect(texts.every((t) => !t.includes('Потрібен підпис'))).toBe(true)
  })

  // ── Horizontal rule ───────────────────────────────────────────────────────

  it('horizontal rule (---) is NOT drawn as literal text', async () => {
    const texts = await drawnTexts(service, pdfGen, 'Section one\n\n---\n\nSection two')
    expect(texts.every((t) => t.trim() !== '---')).toBe(true)
  })

  // ── Pagination ────────────────────────────────────────────────────────────

  it('paginates long content onto multiple pages', async () => {
    const longBody = Array.from(
      { length: 200 },
      (_, i) => `Paragraph ${i + 1}: This is a detailed clause about terms of service usage.`,
    ).join('\n\n')
    const buf = await service.generateTosPdf(longBody)
    const doc = await PDFDocument.load(buf)
    expect(doc.getPageCount()).toBeGreaterThan(1)
  })
})
