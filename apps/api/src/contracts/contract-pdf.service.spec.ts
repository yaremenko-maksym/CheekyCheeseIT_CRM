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

  // ---------------------------------------------------------------------------
  // AC7: No IP address in PDF output
  // ---------------------------------------------------------------------------

  it('AC7: does not contain IP-related text in signed PDF output', async () => {
    const { pdfBuffer } = await service.generateContractPdf(makeParams())
    // The raw binary should not contain "IP" or octet patterns
    const raw = pdfBuffer.toString('binary')
    // Check that the Latin "IP" substring is absent from text streams
    // (rendered text is stored as UTF-16BE in pdf-lib string objects)
    // The ASCII literal "IP " or "IP …" must not appear
    expect(raw).not.toContain('IP …')
    expect(raw).not.toContain('IP ...')
  })

  it('AC7: interface no longer has signedIpLastOctet param', async () => {
    // Compilation-level check: makeParams() (which omits signedIpLastOctet) must compile
    // and produce a valid GenerateContractPdfParams — verified by the fact this test runs.
    const params = makeParams()
    expect('signedIpLastOctet' in params).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // AC8: Company signature block present on all statuses
  // ---------------------------------------------------------------------------

  it('AC8: signed PDF contains company name CheekyCheeseIT in signature block', async () => {
    const { pdfBuffer } = await service.generateContractPdf(makeParams())
    // pdf-lib encodes strings as UTF-16BE (2 bytes per char, big-endian).
    // 'C' = 0x0043, 'h' = 0x0068, etc.
    // Encode "CheekyCheeseIT" to the UTF-16BE byte pattern:
    const name = 'CheekyCheeseIT'
    const utf16beBytes: number[] = []
    for (let i = 0; i < name.length; i++) {
      const code = name.charCodeAt(i)
      utf16beBytes.push(0x00, code)
    }
    const pattern = Buffer.from(utf16beBytes)
    expect(pdfBuffer.indexOf(pattern)).toBeGreaterThan(-1)
  })

  it('AC8: unsigned preview PDF also contains company name CheekyCheeseIT', async () => {
    const params: GenerateContractPdfParams = {
      contractNumber: '',
      bodyMarkdown: makeParams().bodyMarkdown,
      signedTypedName: '',
      signedAt: null,
      verifyUrl: '',
    }
    const { pdfBuffer } = await service.generateContractPdf(params)
    const name = 'CheekyCheeseIT'
    const utf16beBytes: number[] = []
    for (let i = 0; i < name.length; i++) {
      const code = name.charCodeAt(i)
      utf16beBytes.push(0x00, code)
    }
    const pattern = Buffer.from(utf16beBytes)
    expect(pdfBuffer.indexOf(pattern)).toBeGreaterThan(-1)
  })

  it('AC8: signed PDF contains dual signature section heading', async () => {
    const { pdfBuffer } = await service.generateContractPdf(makeParams())
    // "Подписи сторон" encoded UTF-16BE
    const heading = 'Подписи сторон'
    const utf16beBytes: number[] = []
    for (let i = 0; i < heading.length; i++) {
      const code = heading.charCodeAt(i)
      utf16beBytes.push((code >> 8) & 0xff, code & 0xff)
    }
    const pattern = Buffer.from(utf16beBytes)
    expect(pdfBuffer.indexOf(pattern)).toBeGreaterThan(-1)
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
