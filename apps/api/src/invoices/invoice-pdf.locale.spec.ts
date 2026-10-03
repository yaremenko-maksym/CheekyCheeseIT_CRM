/**
 * i18n stage 5 — the signable invoice PDF renders in the RECIPIENT's locale.
 *
 * Text seam: the PDF has no text-extraction dependency and its fonts are
 * subsetted (text is glyph ids in the stream), so the only place the words are
 * observable is the single drawing primitive `PdfGenerationService.drawText`.
 * The spy CALLS THROUGH to the real implementation — the PDF is genuinely
 * rendered; we only record the strings handed to the drawing layer, in order.
 * Expected values below are hand-written literals (never derived from the
 * catalog), so a wrong/missing message cannot make a test pass by construction.
 *
 * Glyph seam: fontkit is asked, for the very strings the service drew and for
 * the Ukrainian-specific letters, whether the bundled Roboto files carry a real
 * glyph (id !== 0, i.e. not `.notdef` — the "box" a missing glyph renders as).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import fontkit from '@pdf-lib/fontkit'

import {
  InvoicePdfService,
  type GenerateSignableInvoiceParams,
  type InvoiceSignatureInfo,
} from './invoice-pdf.service'
import { PdfGenerationService } from '../common/pdf/pdf-generation.service'
import { loadFontBuffer } from '../common/pdf/pdf.utils'

const TEST_TIMEOUT_MS = 20_000
const FIXED_DATE = new Date('2026-05-26T14:00:00.000Z')
const HASH = 'a1b2c3d4' + '0'.repeat(56)

const companySig: InvoiceSignatureInfo = {
  role: 'COMPANY',
  signerName: 'Admin Personal Name',
  signedAt: FIXED_DATE,
  method: 'AUTO_COMPANY',
}
const counterpartySig: InvoiceSignatureInfo = {
  role: 'COUNTERPARTY',
  signerName: 'Olena Koval',
  signedAt: new Date('2026-05-26T15:30:00.000Z'),
  method: 'MANUAL_CLICK',
  pdfHashFull: HASH,
}

// ASCII-only user data: any Cyrillic in an `en` render can then only come from
// the catalog — which is exactly what must not happen.
const params = (locale: 'uk' | 'en'): GenerateSignableInvoiceParams => ({
  transaction: {
    id: '11111111-2222-3333-4444-555566667777',
    type: 'SENIOR_INCOME',
    amount: '1234.56',
    currency: 'USDT',
    contractNumber: 'CHK-deadbeef-2026',
    salaryMonth: '2026-05',
    txDate: FIXED_DATE,
  },
  company: { name: 'Company', address: 'Address' },
  counterparty: {
    displayName: 'Olena Koval',
    locale,
    paymentMethod: 'USDT_ERC20',
    paymentDetails: ['USDT (ERC-20): 0xabc', 'Main wallet'],
  },
  signatures: [companySig, counterpartySig],
  verifyUrl: 'https://crm.example.com/invoice/v/11111111',
  uahEquivalent: { formatted: '50 432.10', rateDate: '26.05.2026' },
})

describe('InvoicePdfService — recipient locale', () => {
  let pdfGen: PdfGenerationService
  let service: InvoicePdfService
  let drawn: string[]

  beforeAll(() => {
    pdfGen = new PdfGenerationService()
    service = new InvoicePdfService(pdfGen)
  })

  const render = async (p: GenerateSignableInvoiceParams) => {
    drawn = []
    // Un-spy first: a second render in one test would otherwise bind the
    // PREVIOUS spy as the "real" implementation and recurse forever.
    vi.restoreAllMocks()
    const real = pdfGen.drawText.bind(pdfGen)
    vi.spyOn(pdfGen, 'drawText').mockImplementation((page, text, opts) => {
      drawn.push(text)
      return real(page, text, opts)
    })
    return service.generateSignableInvoicePdf(p)
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it(
    'uk: SENIOR_INCOME act, both signatures — every label in Ukrainian, data untouched',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      await render(params('uk'))
      expect(drawn).toEqual([
        'CheekyCheeseIT',
        'АКТ ВИКОНАНИХ РОБІТ',
        '№ 11111111',
        'Дата: 26.05.2026',
        'ВИКОНАВЕЦЬ',
        'CheekyCheeseIT',
        'ЗАМОВНИК',
        'Olena Koval',
        'Метод: USDT ERC-20',
        'USDT (ERC-20): 0xabc',
        'Main wallet',
        'ОПИС ПОСЛУГИ',
        'Послуги виконавця згідно з контрактом № CHK-deadbeef-2026',
        'Період: травень 2026',
        'СУМА ДО СПЛАТИ',
        '1 234.56 USDT',
        '≈ 50 432.10 UAH (курс НБУ 26.05.2026)',
        'ПІДПИСИ',
        '1. Від ВИКОНАВЦЯ',
        '   CheekyCheeseIT',
        '   26.05.2026 14:00:00 UTC',
        '   Метод: Автоматичний електронний',
        '2. Від ЗАМОВНИКА',
        '   Olena Koval',
        '   26.05.2026 15:30:00 UTC',
        '   Hash: a1b2c3d4',
        '   Метод: Електронний click-підпис',
        'Перевірити документ',
        'https://crm.example.com/invoice/v/11111111',
        '© 2026 CheekyCheeseIT',
        'crm.example.com/invoice/v/11111111',
      ])
    },
  )

  it(
    'en: the same act in English as a second original; no Cyrillic leaks from the catalog',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      await render(params('en'))
      expect(drawn).toEqual([
        'CheekyCheeseIT',
        'ACT OF SERVICES RENDERED',
        'No. 11111111',
        'Date: 26.05.2026',
        'CONTRACTOR',
        'CheekyCheeseIT',
        'CLIENT',
        'Olena Koval',
        'Method: USDT ERC-20',
        'USDT (ERC-20): 0xabc',
        'Main wallet',
        'SERVICE DESCRIPTION',
        'Services rendered by the contractor under contract No. CHK-deadbeef-2026',
        'Period: May 2026',
        'AMOUNT DUE',
        '1 234.56 USDT',
        '≈ 50 432.10 UAH (NBU rate 26.05.2026)',
        'SIGNATURES',
        '1. From the CONTRACTOR',
        '   CheekyCheeseIT',
        '   26.05.2026 14:00:00 UTC',
        '   Method: Automatic electronic',
        '2. From the CLIENT',
        '   Olena Koval',
        '   26.05.2026 15:30:00 UTC',
        '   Hash: a1b2c3d4',
        '   Method: Electronic click signature',
        'Verify document',
        'https://crm.example.com/invoice/v/11111111',
        '© 2026 CheekyCheeseIT',
        'crm.example.com/invoice/v/11111111',
      ])
      expect(drawn.join('\n')).not.toMatch(/[Ѐ-ӿ]/)
    },
  )

  it(
    'uk vs en change only words: the bytes (hash) differ, amounts / ids / URL lines are identical',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const uk = await render(params('uk'))
      const ukDrawn = [...drawn]
      const en = await render(params('en'))
      expect(uk.sha256Hash).not.toBe(en.sha256Hash)
      const shared = [
        '1 234.56 USDT',
        'https://crm.example.com/invoice/v/11111111',
        '   Hash: a1b2c3d4',
      ]
      for (const line of shared) {
        expect(ukDrawn).toContain(line)
        expect(drawn).toContain(line)
      }
    },
  )

  it(
    'same locale + same input stays byte-identical (hash determinism survives the catalog)',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const a = await render(params('en'))
      const b = await render(params('en'))
      expect(a.sha256Hash).toBe(b.sha256Hash)
    },
  )

  it(
    'uk: SALARY in cash, signatures pending — salary title, cash method with currency, placeholders',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const p = params('uk')
      p.transaction.type = 'SALARY'
      p.transaction.currency = 'UAH'
      p.transaction.salaryMonth = '2026-12'
      p.counterparty.paymentMethod = 'CASH'
      p.counterparty.paymentDetails = []
      p.signatures = []
      p.uahEquivalent = null
      await render(p)
      expect(drawn).toEqual([
        'CheekyCheeseIT',
        'ВИПЛАТА ЗАРПЛАТИ',
        '№ 11111111',
        'Дата: 26.05.2026',
        'ВИКОНАВЕЦЬ',
        'CheekyCheeseIT',
        'ЗАМОВНИК',
        'Olena Koval',
        'Метод: готівка (UAH)',
        'ОПИС ПОСЛУГИ',
        'Заробітна плата працівника за грудень 2026',
        'СУМА ДО СПЛАТИ',
        '1 234.56 UAH',
        'ПІДПИСИ',
        '1. Від ВИКОНАВЦЯ',
        '   Очікує автопідпису',
        '2. Від ЗАМОВНИКА',
        '   Очікує підпису',
        '   (Olena Koval)',
        'Перевірити документ',
        'https://crm.example.com/invoice/v/11111111',
        '© 2026 CheekyCheeseIT',
        'crm.example.com/invoice/v/11111111',
      ])
    },
  )

  it(
    'en: SALARY with no month, no payment method, pending signatures',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const p = params('en')
      p.transaction.type = 'SALARY'
      p.transaction.currency = 'UAH'
      p.transaction.salaryMonth = null
      p.counterparty.paymentMethod = null
      p.counterparty.paymentDetails = []
      p.signatures = []
      p.uahEquivalent = null
      await render(p)
      expect(drawn).toEqual([
        'CheekyCheeseIT',
        'SALARY PAYMENT',
        'No. 11111111',
        'Date: 26.05.2026',
        'CONTRACTOR',
        'CheekyCheeseIT',
        'CLIENT',
        'Olena Koval',
        'Payment details: not provided, please contact the administrator',
        'SERVICE DESCRIPTION',
        'Employee salary',
        'AMOUNT DUE',
        '1 234.56 UAH',
        'SIGNATURES',
        '1. From the CONTRACTOR',
        '   Awaiting auto-signature',
        '2. From the CLIENT',
        '   Awaiting signature',
        '   (Olena Koval)',
        'Verify document',
        'https://crm.example.com/invoice/v/11111111',
        '© 2026 CheekyCheeseIT',
        'crm.example.com/invoice/v/11111111',
      ])
    },
  )

  it(
    'en: SALARY with a month renders the whole sentence from one message',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const p = params('en')
      p.transaction.type = 'SALARY'
      p.transaction.currency = 'UAH'
      p.transaction.salaryMonth = '2026-01'
      p.uahEquivalent = null
      await render(p)
      expect(drawn).toContain('Employee salary for January 2026')
    },
  )

  it(
    'legacy per-project description and the no-contract dash, in both locales',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const legacy = (locale: 'uk' | 'en') => {
        const p = params(locale)
        delete p.transaction.contractNumber
        p.transaction.projectName = 'Acme Corp'
        p.transaction.salaryMonth = null
        return p
      }
      await render(legacy('uk'))
      expect(drawn).toContain('Частка за проєктом «Acme Corp»')
      await render(legacy('en'))
      expect(drawn).toContain('Share of project “Acme Corp”')

      const dash = (locale: 'uk' | 'en') => {
        const p = params(locale)
        p.transaction.contractNumber = null
        p.transaction.salaryMonth = null
        return p
      }
      await render(dash('uk'))
      expect(drawn).toContain('Послуги виконавця згідно з контрактом № —')
      await render(dash('en'))
      expect(drawn).toContain('Services rendered by the contractor under contract No. —')
    },
  )

  it(
    'a malformed or out-of-range month falls back to the raw value (never throws, never "undefined")',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      for (const bad of ['2026-13', '2026-00', 'May 2026']) {
        const p = params('en')
        p.transaction.salaryMonth = bad
        await render(p)
        expect(drawn).toContain(`Period: ${bad}`)
      }
    },
  )

  it('every month of the year renders in both locales', { timeout: TEST_TIMEOUT_MS }, async () => {
    const uk = [
      'січень',
      'лютий',
      'березень',
      'квітень',
      'травень',
      'червень',
      'липень',
      'серпень',
      'вересень',
      'жовтень',
      'листопад',
      'грудень',
    ]
    const en = [
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ]
    for (let i = 0; i < 12; i++) {
      const mm = String(i + 1).padStart(2, '0')
      const pu = params('uk')
      pu.transaction.salaryMonth = `2026-${mm}`
      await render(pu)
      expect(drawn).toContain(`Період: ${uk[i]} 2026`)
      const pe = params('en')
      pe.transaction.salaryMonth = `2026-${mm}`
      await render(pe)
      expect(drawn).toContain(`Period: ${en[i]} 2026`)
    }
  })

  it(
    'the COMPANY signature never shows the signer name, in either locale',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      for (const locale of ['uk', 'en'] as const) {
        await render(params(locale))
        expect(drawn.join('\n')).not.toContain('Admin Personal Name')
      }
    },
  )
})

describe('invoice PDF fonts — real glyphs, not boxes', () => {
  const load = (file: string) => fontkit.create(loadFontBuffer(file))
  const hasRealGlyphs = (font: ReturnType<typeof load>, text: string): boolean => {
    // `fontkit.create` returns a Font for a single-face TTF; `layout` runs the
    // same cmap + shaping pdf-lib's embedder uses. glyph id 0 is `.notdef`.
    const f = font as unknown as { layout(s: string): { glyphs: { id: number }[] } }
    return f.layout(text).glyphs.every((g) => g.id !== 0)
  }

  it.each(['Roboto-Regular.ttf', 'Roboto-Bold.ttf'])(
    '%s carries the Ukrainian-specific letters і ї є ґ (both cases) plus apostrophes',
    (file) => {
      const font = load(file)
      for (const ch of [
        'і',
        'ї',
        'є',
        'ґ',
        'І',
        'Ї',
        'Є',
        'Ґ',
        '’',
        '№',
        '≈',
        '«',
        '»',
        '“',
        '”',
      ]) {
        expect(hasRealGlyphs(font, ch), `${file} lacks ${ch}`).toBe(true)
      }
    },
  )

  it.each(['Roboto-Regular.ttf', 'Roboto-Bold.ttf'])(
    '%s carries the full uk alphabet and the Latin alphabet',
    (file) => {
      const font = load(file)
      const uk = 'абвгґдеєжзиіїйклмнопрстуфхцчшщьюя'
      expect(hasRealGlyphs(font, uk + uk.toUpperCase())).toBe(true)
      const latin = 'abcdefghijklmnopqrstuvwxyz0123456789 .,:;()/-—'
      expect(hasRealGlyphs(font, latin + latin.toUpperCase())).toBe(true)
    },
  )

  it(
    'every line the service actually draws (uk and en, headings bold, body regular) has a real glyph',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const pdfGen = new PdfGenerationService()
      const service = new InvoicePdfService(pdfGen)
      const real = pdfGen.drawText.bind(pdfGen)
      const lines: string[] = []
      vi.spyOn(pdfGen, 'drawText').mockImplementation((page, text, opts) => {
        lines.push(text)
        return real(page, text, opts)
      })
      for (const locale of ['uk', 'en'] as const) {
        const p = params(locale)
        // Hit every Ukrainian-specific letter through catalog text AND user data.
        p.counterparty.displayName = 'Їжак Ґудзик Єва Іванова'
        await service.generateSignableInvoicePdf(p)
      }
      vi.restoreAllMocks()
      const regular = load('Roboto-Regular.ttf')
      const bold = load('Roboto-Bold.ttf')
      expect(lines.length).toBeGreaterThan(50)
      for (const line of lines) {
        expect(hasRealGlyphs(regular, line), `regular: ${line}`).toBe(true)
        expect(hasRealGlyphs(bold, line), `bold: ${line}`).toBe(true)
      }
      // The Ukrainian-only letters really are exercised by the uk render.
      const uk = lines.join('')
      for (const ch of ['і', 'ї', 'є', 'ґ']) expect(uk.toLowerCase()).toContain(ch)
    },
  )
})
