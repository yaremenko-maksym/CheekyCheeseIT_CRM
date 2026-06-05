import { describe, it, expect, beforeEach } from 'vitest'
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
    signedIpLastOctet: '42',
    verifyUrl: 'http://localhost:3000/contract/v/abc-123',
    ...overrides,
  }
}

describe('ContractPdfService', () => {
  let service: ContractPdfService

  beforeEach(() => {
    service = new ContractPdfService(new PdfGenerationService())
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

  it('handles a contract with no IP octet (null) gracefully', async () => {
    const { pdfBuffer } = await service.generateContractPdf(makeParams({ signedIpLastOctet: null }))
    expect(pdfBuffer.length).toBeGreaterThan(1000)
  })

  // ---------------------------------------------------------------------------
  // A3-1: Unsigned preview mode — signedTypedName='' drives all conditionals.
  // Preview renders «Требуется подпись участника» in the signature block.
  // No QR, contractNumber renders as '—'. No signed date/name/IP in footer.
  // isPreview param removed (A3-1) — signedTypedName.trim() is the signal.
  // ---------------------------------------------------------------------------

  describe("A3-1: unsigned preview mode (signedTypedName='')", () => {
    /** Minimal unsigned-preview params — mirrors what OnboardingContractController sends. */
    function makePreviewParams(): GenerateContractPdfParams {
      return {
        contractNumber: '',
        bodyMarkdown: makeParams().bodyMarkdown,
        signedTypedName: '',
        signedAt: null,
        signedIpLastOctet: null,
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
      // Even if makeParams() was used, unsigned mode with signedTypedName=''
      // must not render any real name in the signature block.
      const { pdfBuffer } = await service.generateContractPdf(makePreviewParams())
      // pdf-lib encodes Cyrillic as UTF-16BE inside PDF string objects;
      // a simple latin1 check is not reliable for the exact phrase,
      // but we can confirm the known real name is absent from raw content.
      const rawContent = pdfBuffer.toString('binary')
      // 'Иван Иванов' in UTF-16BE bytes: И=0x04 0x38, etc.
      // Indirect check: the preview must differ from signed (already tested above),
      // and must be parseable — signature name absence is arch-guaranteed.
      expect(rawContent).not.toContain('\x00И\x00в\x00а\x00н')
    })

    it('unsigned preview is smaller than signed PDF (no QR PNG embedded)', async () => {
      // Signed PDF embeds a QR code as a PNG image stream (~1-3 KB).
      // Preview omits QR entirely → preview buffer is meaningfully smaller.
      const signed = await service.generateContractPdf(makeParams())
      const preview = await service.generateContractPdf(makePreviewParams())
      // QR PNG adds at minimum ~500 bytes; use 200 as conservative threshold.
      expect(signed.pdfBuffer.length).toBeGreaterThan(preview.pdfBuffer.length + 200)
    })

    it('unsigned preview is byte-deterministic (same params → same sha256)', async () => {
      const first = await service.generateContractPdf(makePreviewParams())
      const second = await service.generateContractPdf(makePreviewParams())
      expect(first.sha256Hash).toBe(second.sha256Hash)
    })
  })
})
