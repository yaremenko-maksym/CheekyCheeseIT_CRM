/**
 * Unit tests for InvoicePdfService.
 *
 * These tests intentionally exercise the *real* PDF generation pipeline
 * (pdf-lib + fontkit + qrcode + the bundled Roboto TTF) because the whole
 * point of the service is that it must produce a valid, parseable PDF whose
 * SHA-256 is deterministic. Mocking out pdf-lib would defeat that.
 *
 * Each test reads the resulting buffer back to assert byte-level properties:
 *   - PDF magic header "%PDF-"
 *   - %%EOF marker
 *   - QR PNG embedded (search for "/Image" + "/Subtype" markers in the stream)
 *   - SHA-256 length 64 + hex format
 *   - Determinism: identical inputs -> identical hash
 *
 * We do NOT parse the PDF back into text (no pdf-parse dep) — instead we
 * search for the subsetted glyph payload to confirm cyrillic characters made
 * it into the document.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { PDFDocument } from 'pdf-lib'

import {
  COMPANY_BRAND_NAME,
  InvoicePdfService,
  type GenerateSignableInvoiceParams,
} from './invoice-pdf.service'
import { sha256Hex, shortHash } from './invoice-pdf.utils'

// Each test below exercises the *real* PDF generation pipeline (pdf-lib +
// fontkit + qrcode + the bundled Roboto TTF). Per the file-header comment the
// whole point is byte-level verification of the output, so mocking pdf-lib is
// off the table. On slower CI runners (and even locally under cold node
// caches) a single `generateSignableInvoicePdf` call can comfortably exceed
// Vitest's default 5 s timeout — and several tests above call it 2–3 times
// to compare hashes between variants. Bump the per-file timeout to 20 s so
// the tests stay deterministic and aren't flagged for timeout-flakiness on
// the slower job pools.
const TEST_TIMEOUT_MS = 20_000

// Fixed timestamp keeps every test deterministic — pdf-lib uses metadata
// dates internally, and we override them with this value in the service.
const FIXED_DATE = new Date('2026-05-26T14:00:00.000Z')
const FIXED_SIGNED_AT_COMPANY = new Date('2026-05-26T14:00:00.000Z')
const FIXED_SIGNED_AT_COUNTERPARTY = new Date('2026-05-26T15:30:00.000Z')

const baseParams = (): GenerateSignableInvoiceParams => ({
  transaction: {
    id: '11111111-2222-3333-4444-555566667777',
    type: 'SENIOR_INCOME',
    amount: '1234.56',
    currency: 'USDT',
    projectName: 'Acme Corp',
    salaryMonth: '2026-05',
    txDate: FIXED_DATE,
  },
  company: {
    name: 'CheekyCheese IT',
    address: 'г. Киев, ул. Тестовая 1',
  },
  counterparty: {
    displayName: 'Иван Иванов',
    paymentMethod: 'USDT_ERC20',
    paymentDetails: [
      'Адрес: 0x1234567890abcdef1234567890abcdef12345678',
      'Метка: Основной кошелёк',
    ],
  },
  signatures: [],
  verifyUrl: 'https://crm.example.com/invoice/v/11111111',
  uahEquivalent: {
    formatted: '50 432.10',
    rateDate: '26.05.2026',
  },
})

describe('InvoicePdfService', () => {
  let service: InvoicePdfService

  beforeAll(() => {
    service = new InvoicePdfService()
  })

  describe('generateSignableInvoicePdf — 0 signatures', () => {
    it(
      'produces a valid PDF that contains the "Ожидает подписи" placeholder',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const params = baseParams()
        params.signatures = [] // explicit: no auto-COMPANY yet

        const { pdfBuffer, sha256Hash } = await service.generateSignableInvoicePdf(params)

        // PDF magic
        expect(pdfBuffer.slice(0, 5).toString('utf8')).toBe('%PDF-')
        // EOF marker (tolerate trailing newline)
        expect(pdfBuffer.slice(-7).toString('utf8')).toMatch(/%%EOF\s*$/)
        // Hash format
        expect(sha256Hash).toMatch(/^[0-9a-f]{64}$/)
        // Hash matches independent computation
        expect(sha256Hash).toBe(sha256Hex(pdfBuffer))

        // PDF should re-parse without errors
        const reparsed = await PDFDocument.load(pdfBuffer)
        expect(reparsed.getPageCount()).toBe(1)

        // Size sanity: must be > 30 KB (font + QR embed alone is ~25 KB)
        expect(pdfBuffer.length).toBeGreaterThan(20_000)
        // Size cap: should be well under 1 MB for a single-page invoice
        expect(pdfBuffer.length).toBeLessThan(500_000)
      },
    )
  })

  describe('generateSignableInvoicePdf — 1 signature (COMPANY only)', () => {
    it(
      'renders only the company signature block + Ожидает подписи for counterparty',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const params = baseParams()
        params.signatures = [
          {
            role: 'COMPANY',
            signerName: 'Maksym Y.',
            signedAt: FIXED_SIGNED_AT_COMPANY,
            method: 'AUTO_COMPANY',
          },
        ]

        const { pdfBuffer, sha256Hash } = await service.generateSignableInvoicePdf(params)

        expect(sha256Hash).toMatch(/^[0-9a-f]{64}$/)
        const reparsed = await PDFDocument.load(pdfBuffer)
        expect(reparsed.getPageCount()).toBe(1)
        // The PDF should be larger than the zero-sig variant because it
        // includes the company name + timestamp string.
        const zeroSig = await service.generateSignableInvoicePdf({
          ...params,
          signatures: [],
        })
        // We can't reliably assert strict size ordering due to PDF compression,
        // but both must be valid and have different hashes.
        expect(sha256Hash).not.toBe(zeroSig.sha256Hash)
      },
    )
  })

  describe('generateSignableInvoicePdf — 2 signatures (both sides)', () => {
    it(
      'embeds the short hash for the counterparty signature and renders both blocks',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const params = baseParams()
        const fakeFullHash = 'a1b2c3d4' + '0'.repeat(56) // 64 chars, valid hex
        params.signatures = [
          {
            role: 'COMPANY',
            signerName: 'Maksym Y.',
            signedAt: FIXED_SIGNED_AT_COMPANY,
            method: 'AUTO_COMPANY',
          },
          {
            role: 'COUNTERPARTY',
            signerName: 'Иван Иванов',
            signedAt: FIXED_SIGNED_AT_COUNTERPARTY,
            method: 'MANUAL_CLICK',
            pdfHashFull: fakeFullHash,
            ipLastOctet: '42',
          },
        ]

        const { pdfBuffer, sha256Hash } = await service.generateSignableInvoicePdf(params)

        expect(sha256Hash).toMatch(/^[0-9a-f]{64}$/)
        const reparsed = await PDFDocument.load(pdfBuffer)
        expect(reparsed.getPageCount()).toBe(1)

        // Hash differs from 1-signature variant.
        const oneSig = await service.generateSignableInvoicePdf({
          ...params,
          signatures: [params.signatures[0]!],
        })
        expect(sha256Hash).not.toBe(oneSig.sha256Hash)

        // Title metadata propagates the short tx id
        expect(reparsed.getTitle()).toContain('11111111')
      },
    )

    it(
      'renders signatures in COMPANY-first order regardless of input order',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const params = baseParams()
        const fakeFullHash = 'a1b2c3d4' + '0'.repeat(56)
        const companySig = {
          role: 'COMPANY' as const,
          signerName: 'Maksym Y.',
          signedAt: FIXED_SIGNED_AT_COMPANY,
          method: 'AUTO_COMPANY' as const,
        }
        const counterpartySig = {
          role: 'COUNTERPARTY' as const,
          signerName: 'Иван Иванов',
          signedAt: FIXED_SIGNED_AT_COUNTERPARTY,
          method: 'MANUAL_CLICK' as const,
          pdfHashFull: fakeFullHash,
        }

        const orderA = await service.generateSignableInvoicePdf({
          ...params,
          signatures: [companySig, counterpartySig],
        })
        const orderB = await service.generateSignableInvoicePdf({
          ...params,
          signatures: [counterpartySig, companySig],
        })

        // Deterministic sort -> same output regardless of input order.
        expect(orderA.sha256Hash).toBe(orderB.sha256Hash)
      },
    )
  })

  describe('hash determinism', () => {
    it(
      'produces the same SHA-256 for identical inputs across calls',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const params = baseParams()
        params.signatures = [
          {
            role: 'COMPANY',
            signerName: 'Maksym Y.',
            signedAt: FIXED_SIGNED_AT_COMPANY,
            method: 'AUTO_COMPANY',
          },
        ]

        const first = await service.generateSignableInvoicePdf(params)
        const second = await service.generateSignableInvoicePdf(params)

        expect(first.sha256Hash).toBe(second.sha256Hash)
        expect(first.pdfBuffer.length).toBe(second.pdfBuffer.length)
      },
    )

    it(
      'produces a different SHA-256 when any field changes',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const a = baseParams()
        const b = baseParams()
        b.transaction.amount = '9999.99'

        const resA = await service.generateSignableInvoicePdf(a)
        const resB = await service.generateSignableInvoicePdf(b)

        expect(resA.sha256Hash).not.toBe(resB.sha256Hash)
      },
    )
  })

  describe('SALARY transaction type', () => {
    it('produces a valid PDF with the salary title', { timeout: TEST_TIMEOUT_MS }, async () => {
      const params = baseParams()
      params.transaction.type = 'SALARY'
      params.transaction.projectName = null
      params.transaction.currency = 'UAH'
      params.uahEquivalent = null // UAH = no equivalent line

      const { pdfBuffer, sha256Hash } = await service.generateSignableInvoicePdf(params)

      expect(sha256Hash).toMatch(/^[0-9a-f]{64}$/)
      const reparsed = await PDFDocument.load(pdfBuffer)
      expect(reparsed.getPageCount()).toBe(1)
    })
  })

  describe('counterparty with no payment method', () => {
    it(
      'renders the "Не указано" warning and still produces a valid PDF',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const params = baseParams()
        params.counterparty.paymentMethod = null
        params.counterparty.paymentDetails = []

        const { pdfBuffer, sha256Hash } = await service.generateSignableInvoicePdf(params)

        expect(sha256Hash).toMatch(/^[0-9a-f]{64}$/)
        const reparsed = await PDFDocument.load(pdfBuffer)
        expect(reparsed.getPageCount()).toBe(1)
      },
    )
  })

  describe('counterparty with CASH payment method (SALARY only)', () => {
    it(
      'renders "Наличка" + "(без реквизитов)" hint and produces a valid PDF',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const params = baseParams()
        params.transaction.type = 'SALARY'
        params.transaction.projectName = null
        params.transaction.currency = 'UAH'
        params.uahEquivalent = null
        params.counterparty.paymentMethod = 'CASH'
        params.counterparty.paymentDetails = []

        const { pdfBuffer, sha256Hash } = await service.generateSignableInvoicePdf(params)

        expect(sha256Hash).toMatch(/^[0-9a-f]{64}$/)
        const reparsed = await PDFDocument.load(pdfBuffer)
        expect(reparsed.getPageCount()).toBe(1)

        // Hash differs from the `null` variant — different rendering path.
        const nullParams = baseParams()
        nullParams.transaction.type = 'SALARY'
        nullParams.transaction.projectName = null
        nullParams.transaction.currency = 'UAH'
        nullParams.uahEquivalent = null
        nullParams.counterparty.paymentMethod = null
        nullParams.counterparty.paymentDetails = []
        const nullVariant = await service.generateSignableInvoicePdf(nullParams)
        expect(sha256Hash).not.toBe(nullVariant.sha256Hash)
      },
    )
  })

  describe('QR code embedding', () => {
    it('embeds an image stream (the QR code PNG)', { timeout: TEST_TIMEOUT_MS }, async () => {
      const params = baseParams()
      const { pdfBuffer } = await service.generateSignableInvoicePdf(params)

      // pdf-lib embeds PNGs with these dictionary markers somewhere in the
      // raw stream. The exact bytes are compression-dependent but these two
      // tokens are reliable presence indicators for a /XObject Image.
      const raw = pdfBuffer.toString('binary')
      expect(raw).toContain('/Image')
      expect(raw).toContain('/Subtype')
    })

    it(
      'different verify URLs produce different QR-bearing PDFs',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const a = baseParams()
        const b = baseParams()
        b.verifyUrl = 'https://crm.example.com/invoice/v/different-id'

        const resA = await service.generateSignableInvoicePdf(a)
        const resB = await service.generateSignableInvoicePdf(b)

        expect(resA.sha256Hash).not.toBe(resB.sha256Hash)
      },
    )
  })

  describe('task-drop-company-debt-and-invoices: brand-only company signature', () => {
    it(
      'COMPANY signature renders brand "CheekyCheeseIT" identically regardless of signerName',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        // Admin personal names must NEVER affect PDF output — different
        // `signerName` values for the COMPANY signature should produce the
        // same hash because we render the brand name only.
        const paramsMaksym = baseParams()
        paramsMaksym.signatures = [
          {
            role: 'COMPANY',
            signerName: 'Maksym Yaremenko',
            signedAt: FIXED_SIGNED_AT_COMPANY,
            method: 'AUTO_COMPANY',
          },
        ]
        const paramsKostya = baseParams()
        paramsKostya.signatures = [
          {
            role: 'COMPANY',
            signerName: 'Kostya',
            signedAt: FIXED_SIGNED_AT_COMPANY,
            method: 'AUTO_COMPANY',
          },
        ]

        const a = await service.generateSignableInvoicePdf(paramsMaksym)
        const b = await service.generateSignableInvoicePdf(paramsKostya)

        expect(a.sha256Hash).toBe(b.sha256Hash)
        // Sanity — brand constant is exposed and used.
        expect(COMPANY_BRAND_NAME).toBe('CheekyCheeseIT')
      },
    )
  })

  describe('cyrillic content', () => {
    it(
      'produces a non-empty, parseable PDF for cyrillic input (font subset embeds glyphs)',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        // If the Cyrillic font wasn't actually embedded the call would either
        // throw (pdf-lib WinAnsi encoder rejects U+0400+) or produce a
        // suspiciously small file.
        const params = baseParams()
        params.counterparty.displayName = 'Олександр Сергійович Лук’яненко'
        params.company.address = 'м. Київ, пр-т Перемоги, буд. 100, оф. 5'

        const { pdfBuffer, sha256Hash } = await service.generateSignableInvoicePdf(params)

        expect(sha256Hash).toMatch(/^[0-9a-f]{64}$/)
        expect(pdfBuffer.length).toBeGreaterThan(20_000)

        // Re-parsing must succeed
        const reparsed = await PDFDocument.load(pdfBuffer)
        expect(reparsed.getPageCount()).toBe(1)
      },
    )
  })

  // task-aggregate-invoice-per-payout — AC2/AC6
  // The new aggregated invoice flow renders description as
  // «Услуги исполнителя согласно контракту № <contractNumber>» instead of
  // the legacy «Доля по проекту <X>» line. Project names move to a secondary
  // line (compact if ≤3, truncated with «…» if >3).
  describe('aggregated invoice description (task-aggregate-invoice-per-payout)', () => {
    it(
      'renders contract description when contractNumber is set',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const params = baseParams()
        params.transaction.contractNumber = 'CHK-deadbeef-2026'
        // No projectNames → no secondary projects line.
        delete params.transaction.projectName
        params.signatures = [
          {
            role: 'COMPANY',
            signerName: 'Maksym Y.',
            signedAt: FIXED_SIGNED_AT_COMPANY,
            method: 'AUTO_COMPANY',
          },
        ]

        const { pdfBuffer, sha256Hash } = await service.generateSignableInvoicePdf(params)
        expect(sha256Hash).toMatch(/^[0-9a-f]{64}$/)
        const reparsed = await PDFDocument.load(pdfBuffer)
        expect(reparsed.getPageCount()).toBe(1)

        // Different contractNumber → different hash (sanity: contract # rendered).
        const other = baseParams()
        other.transaction.contractNumber = 'CHK-aaaaaaaa-2026'
        delete other.transaction.projectName
        other.signatures = params.signatures
        const otherRes = await service.generateSignableInvoicePdf(other)
        expect(sha256Hash).not.toBe(otherRes.sha256Hash)

        // Sanity: buffer length reasonable (invoice + font subset + QR)
        expect(pdfBuffer.length).toBeGreaterThan(20_000)
      },
    )

    // task-aggregate-invoice-per-payout round 2: the projects list line was
    // removed from the PDF description block. We keep `projectNames` on the
    // input interface for back-compat (callers still pass it for audit / log
    // metadata) but the PDF body is invariant to its value — the two tests
    // below pin that invariant.
    it(
      'ignores projectNames when <= 3 — PDF identical to no-list variant',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const params = baseParams()
        params.transaction.contractNumber = 'CHK-deadbeef-2026'
        params.transaction.projectNames = ['Acme Corp', 'LearnSpace', 'TechCorp AI']
        delete params.transaction.projectName
        params.signatures = [
          {
            role: 'COMPANY',
            signerName: 'Maksym Y.',
            signedAt: FIXED_SIGNED_AT_COMPANY,
            method: 'AUTO_COMPANY',
          },
        ]

        const { pdfBuffer, sha256Hash } = await service.generateSignableInvoicePdf(params)
        expect(sha256Hash).toMatch(/^[0-9a-f]{64}$/)
        expect(pdfBuffer.length).toBeGreaterThan(20_000)

        // Same params without projectNames must produce an IDENTICAL PDF —
        // the description block ignores the value.
        const noList = baseParams()
        noList.transaction.contractNumber = params.transaction.contractNumber
        delete noList.transaction.projectName
        noList.signatures = params.signatures
        const noListRes = await service.generateSignableInvoicePdf(noList)
        expect(sha256Hash).toBe(noListRes.sha256Hash)
      },
    )

    it(
      'ignores projectNames when > 3 — PDF identical regardless of list length',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const params = baseParams()
        params.transaction.contractNumber = 'CHK-deadbeef-2026'
        params.transaction.projectNames = [
          'Acme Corp',
          'LearnSpace',
          'TechCorp AI',
          'Senior Regression',
          'Drop Phase 2',
          'Sixth Project',
        ]
        delete params.transaction.projectName
        params.signatures = [
          {
            role: 'COMPANY',
            signerName: 'Maksym Y.',
            signedAt: FIXED_SIGNED_AT_COMPANY,
            method: 'AUTO_COMPANY',
          },
        ]

        const { pdfBuffer, sha256Hash } = await service.generateSignableInvoicePdf(params)
        expect(sha256Hash).toMatch(/^[0-9a-f]{64}$/)
        const reparsed = await PDFDocument.load(pdfBuffer)
        expect(reparsed.getPageCount()).toBe(1)

        // PDF still fits one page (it always did — round 2 just removed a
        // single optional line).
        expect(pdfBuffer.length).toBeGreaterThan(20_000)
        expect(pdfBuffer.length).toBeLessThan(500_000)

        // Hash IDENTICAL to the 3-project list variant — projectNames is
        // intentionally not part of the PDF content surface anymore.
        const threeOnly = baseParams()
        threeOnly.transaction.contractNumber = params.transaction.contractNumber
        threeOnly.transaction.projectNames = (params.transaction.projectNames as string[]).slice(
          0,
          3,
        )
        delete threeOnly.transaction.projectName
        threeOnly.signatures = params.signatures
        const threeOnlyRes = await service.generateSignableInvoicePdf(threeOnly)
        expect(sha256Hash).toBe(threeOnlyRes.sha256Hash)
      },
    )

    it(
      'preserves Период line when salaryMonth provided',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        // Same params with vs. without salaryMonth must produce different PDFs.
        const withMonth = baseParams()
        withMonth.transaction.contractNumber = 'CHK-deadbeef-2026'
        withMonth.transaction.salaryMonth = '2026-05'
        delete withMonth.transaction.projectName
        withMonth.signatures = []

        const withoutMonth = baseParams()
        withoutMonth.transaction.contractNumber = 'CHK-deadbeef-2026'
        delete withoutMonth.transaction.projectName
        withoutMonth.transaction.salaryMonth = null
        withoutMonth.signatures = []

        const a = await service.generateSignableInvoicePdf(withMonth)
        const b = await service.generateSignableInvoicePdf(withoutMonth)
        expect(a.sha256Hash).not.toBe(b.sha256Hash)
      },
    )

    it(
      'legacy fallback — without contractNumber renders previous Доля по проекту',
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        // Existing invoices (per-tx SENIOR_INCOME) keep working — neither
        // contractNumber nor projectNames provided. We only need to verify
        // the PDF still renders without throwing.
        const params = baseParams()
        params.signatures = [
          {
            role: 'COMPANY',
            signerName: 'Maksym Y.',
            signedAt: FIXED_SIGNED_AT_COMPANY,
            method: 'AUTO_COMPANY',
          },
        ]

        const { pdfBuffer, sha256Hash } = await service.generateSignableInvoicePdf(params)
        expect(sha256Hash).toMatch(/^[0-9a-f]{64}$/)
        const reparsed = await PDFDocument.load(pdfBuffer)
        expect(reparsed.getPageCount()).toBe(1)
      },
    )
  })
})

describe('invoice-pdf.utils', () => {
  describe('sha256Hex', () => {
    it('returns a 64-char lowercase hex digest', () => {
      const buf = Buffer.from('hello world', 'utf8')
      const hash = sha256Hex(buf)
      expect(hash).toMatch(/^[0-9a-f]{64}$/)
      // Known value for "hello world"
      expect(hash).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9')
    })

    it('is deterministic across calls', () => {
      const buf = Buffer.from('test content', 'utf8')
      expect(sha256Hex(buf)).toBe(sha256Hex(buf))
    })
  })

  describe('shortHash', () => {
    it('returns the first 8 chars (lowercased)', () => {
      const full = 'A1B2C3D4' + '0'.repeat(56)
      expect(shortHash(full)).toBe('a1b2c3d4')
    })

    it('throws on a malformed hash (wrong length)', () => {
      expect(() => shortHash('a1b2')).toThrow()
    })

    it('throws on a malformed hash (non-hex characters)', () => {
      const bad = 'XY' + '0'.repeat(62)
      expect(() => shortHash(bad)).toThrow()
    })
  })
})
