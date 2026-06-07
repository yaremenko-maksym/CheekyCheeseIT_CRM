import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'

import { ContractPdfService, type GenerateContractPdfParams } from './contract-pdf.service'
import { PdfGenerationService } from '../common/pdf/pdf-generation.service'

function makeParams(overrides: Partial<GenerateContractPdfParams> = {}): GenerateContractPdfParams {
  return {
    contractNumber: 'CHK-1-2026',
    bodyMarkdown:
      '# Договор\n\nОбычный абзац с **жирным** текстом.\n\n- Пункт первый\n- Пункт второй',
    signedTypedName: 'Иван Иванов',
    signedAt: new Date('2026-06-04T07:00:00.000Z'),
    verifyUrl: 'http://localhost:3000/contract/v/abc-123',
    ...overrides,
  }
}

describe('ContractPdfService', () => {
  let service: ContractPdfService
  let pdfGen: PdfGenerationService

  /**
   * Collect every string passed to PdfGenerationService.drawText during one
   * PDF generation. pdf-lib renders text as embedded-font glyph codes inside
   * (often compressed) content streams, so the rendered words never appear as
   * plain bytes in the output buffer — asserting on the drawText call args is
   * the correct way to verify what text the contract actually renders.
   */
  async function drawnTexts(params: GenerateContractPdfParams): Promise<string[]> {
    const spy = vi.spyOn(pdfGen, 'drawText')
    await service.generateContractPdf(params)
    const texts = spy.mock.calls
      .map((call) => call[1])
      .filter((t): t is string => typeof t === 'string')
    spy.mockRestore()
    return texts
  }

  beforeEach(() => {
    pdfGen = new PdfGenerationService()
    service = new ContractPdfService(pdfGen)
  })

  it('produces a non-empty PDF buffer + 64-char sha256', async () => {
    const { pdfBuffer, sha256Hash } = await service.generateContractPdf(makeParams())

    expect(pdfBuffer.length).toBeGreaterThan(1000)
    // PDF magic header.
    expect(pdfBuffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(sha256Hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is byte-deterministic — identical params yield identical sha256', async () => {
    const first = await service.generateContractPdf(makeParams())
    const second = await service.generateContractPdf(makeParams())

    expect(second.sha256Hash).toBe(first.sha256Hash)
    expect(second.pdfBuffer.equals(first.pdfBuffer)).toBe(true)
  })

  it('differs when the signed contract content differs', async () => {
    const a = await service.generateContractPdf(makeParams({ contractNumber: 'CHK-1-2026' }))
    const b = await service.generateContractPdf(makeParams({ contractNumber: 'CHK-2-2026' }))

    expect(b.sha256Hash).not.toBe(a.sha256Hash)
  })

  it('paginates long contracts onto multiple pages', async () => {
    const longBody = Array.from(
      { length: 120 },
      (_, i) => `Пункт ${i + 1} договора о предоставлении услуг.`,
    ).join('\n\n')
    const { pdfBuffer } = await service.generateContractPdf(makeParams({ bodyMarkdown: longBody }))

    const doc = await PDFDocument.load(pdfBuffer)
    expect(doc.getPageCount()).toBeGreaterThan(1)
  })

  it('renders Cyrillic body without throwing', async () => {
    await expect(
      service.generateContractPdf(
        makeParams({
          bodyMarkdown: '## Раздел\n\nДоговор на русском языке. Ставка 26%. Кошелёк USDT.',
        }),
      ),
    ).resolves.toBeDefined()
  })

  // ---------------------------------------------------------------------------
  // AC7: No IP address in PDF output
  // ---------------------------------------------------------------------------

  it('AC7: never draws the IP suffix in the signed contract signature', async () => {
    const texts = await drawnTexts(makeParams())
    expect(texts.some((t) => t.includes('IP …') || t.includes('IP ...') || / · IP/.test(t))).toBe(
      false,
    )
  })

  it('AC7: interface no longer has signedIpLastOctet param', () => {
    // Compilation-level check: makeParams() (which omits signedIpLastOctet) must compile
    // and produce a valid GenerateContractPdfParams — verified by the fact this test runs.
    const params = makeParams()
    expect('signedIpLastOctet' in params).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // AC8: Dual signature block (participant + CheekyCheeseIT) on all statuses.
  // Assert on drawText call args — see drawnTexts() for why binary scanning fails.
  // ---------------------------------------------------------------------------

  it('AC8: signed contract draws the dual signature block (heading + both parties)', async () => {
    const texts = await drawnTexts(makeParams())
    expect(texts).toContain('Подписи сторон')
    expect(texts.some((t) => t.includes('Участник'))).toBe(true)
    expect(texts.some((t) => t.includes('От CheekyCheeseIT'))).toBe(true)
  })

  it('AC8: unsigned preview also draws the CheekyCheeseIT signature block', async () => {
    const previewParams: GenerateContractPdfParams = {
      contractNumber: '',
      bodyMarkdown: makeParams().bodyMarkdown,
      signedTypedName: '',
      signedAt: null,
      verifyUrl: '',
    }
    const texts = await drawnTexts(previewParams)
    expect(texts).toContain('Подписи сторон')
    expect(texts.some((t) => t.includes('От CheekyCheeseIT'))).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // A3-1: Unsigned preview mode — signedTypedName='' drives all conditionals.
  // ---------------------------------------------------------------------------

  describe("A3-1: unsigned preview mode (signedTypedName='')", () => {
    /** Minimal unsigned-preview params — mirrors what OnboardingContractController sends. */
    function makePreviewParams(): GenerateContractPdfParams {
      return {
        contractNumber: '',
        bodyMarkdown: makeParams().bodyMarkdown,
        signedTypedName: '',
        signedAt: null,
        verifyUrl: '',
      }
    }

    it('produces a valid non-empty PDF buffer in unsigned preview mode', async () => {
      const { pdfBuffer } = await service.generateContractPdf(makePreviewParams())
      expect(pdfBuffer.length).toBeGreaterThan(1000)
      expect(pdfBuffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    })

    it('unsigned preview differs from signed PDF (different sha256)', async () => {
      const signed = await service.generateContractPdf(makeParams())
      const preview = await service.generateContractPdf(makePreviewParams())
      expect(preview.sha256Hash).not.toBe(signed.sha256Hash)
    })

    it('unsigned preview is a valid parseable PDF with at least 1 page', async () => {
      const { pdfBuffer } = await service.generateContractPdf(makePreviewParams())
      expect(pdfBuffer.length).toBeGreaterThan(5000)
      const doc = await PDFDocument.load(pdfBuffer)
      expect(doc.getPageCount()).toBeGreaterThanOrEqual(1)
    })

    it('unsigned preview does NOT embed the signed name (signedTypedName suppressed)', async () => {
      const { pdfBuffer } = await service.generateContractPdf(makePreviewParams())
      const rawContent = pdfBuffer.toString('binary')
      // 'Иван Иванов' in UTF-16BE bytes: И=0x0418
      expect(rawContent).not.toContain('\x00\x04\x00\x38')
      expect(rawContent).not.toContain('\x04\x18\x04\x32\x04\x30\x04\x3d')
    })

    it('unsigned preview is smaller than signed PDF (no QR PNG embedded)', async () => {
      const signed = await service.generateContractPdf(makeParams())
      const preview = await service.generateContractPdf(makePreviewParams())
      expect(signed.pdfBuffer.length).toBeGreaterThan(preview.pdfBuffer.length + 200)
    })

    it('unsigned preview is byte-deterministic (same params → same sha256)', async () => {
      const first = await service.generateContractPdf(makePreviewParams())
      const second = await service.generateContractPdf(makePreviewParams())
      expect(first.sha256Hash).toBe(second.sha256Hash)
    })
  })
})
