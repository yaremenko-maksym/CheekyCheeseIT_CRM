/**
 * Unit tests for the pure render helpers extracted from InvoicePdfService.
 *
 * Seam: the free-function interface. Draw helpers are driven through a
 * recording PdfDrawer fake, so the exact draw-call sequence (text, x, y, font,
 * size, color) and the returned cursor are asserted against hand-counted
 * literals — independent of pdf-lib. `t` is a deterministic stub that renders
 * `<id>` or `<id>(k=v,...)`, so expectations don't depend on the catalog text.
 */
import { describe, it, expect, vi } from 'vitest'
import type { Color, PDFDocument, PDFFont, PDFPage } from 'pdf-lib'

import {
  COMPANY_BRAND_NAME,
  buildDescription,
  drawCompanySignature,
  drawCounterpartySignature,
  drawLine,
  drawSectionHeader,
  drawVerifyBlock,
  formatAmount,
  formatDate,
  formatDateTime,
  formatPeriod,
  signatureMethodLine,
  type PdfDrawer,
  type Translate,
} from './invoice-pdf-render.util'
import type { InvoiceSignatureInfo, InvoiceTransactionInfo } from './invoice-pdf.service'
import { PDF_LAYOUT } from '../common/pdf/pdf.constants'

const t: Translate = (d, values) =>
  values
    ? `${d.id}(${Object.entries(values)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(',')})`
    : (d.id as string)

const color = (name: string): Color => ({ name }) as unknown as Color
const font = (name: string): PDFFont => ({ name }) as unknown as PDFFont

const TEXT = color('text')
const MUTED = color('muted')
const WARNING = color('warning')
const ACCENT = color('accent')
const BOLD = font('bold')
const REG = font('regular')

const layout = {
  margin: 50,
  lineHeight: 14,
  colors: { text: TEXT, muted: MUTED, warning: WARNING, accent: ACCENT },
}

interface Call {
  text: string
  x: number
  y: number
  font: PDFFont
  size: number
  color: Color
}

function recorder() {
  const calls: Call[] = []
  const image = { image: true }
  const drawer = {
    drawText: (_page: PDFPage, text: string, o: Omit<Call, 'text'>) => {
      calls.push({ text, ...o })
    },
    embedQrPng: vi.fn(async () => image),
  } as unknown as PdfDrawer
  return { calls, drawer, image }
}

const page = { drawImage: vi.fn() } as unknown as PDFPage

describe('formatAmount', () => {
  it.each([
    ['1234.56', '1 234.56'],
    ['1234.5', '1 234.50'],
    ['1234', '1 234.00'],
    ['0', '0.00'],
    ['999', '999.00'],
    ['1000', '1 000.00'],
    ['1000000.123456', '1 000 000.123456'],
    ['12345678.9', '12 345 678.90'],
    ['1234.000001', '1 234.000001'],
    ['1.100001', '1.100001'],
    ['1.05', '1.05'],
    ['0.000001', '0.000001'],
    ['-1234.5', '-1 234.50'],
    // significant decimals are preserved (never truncated); only trailing zeros are trimmed
    ['1234.567000', '1 234.567'],
    ['1234.565', '1 234.565'],
    ['-1234.567', '-1 234.567'],
    ['1.12345', '1.12345'],
    ['1.120000', '1.12'],
    ['1.500000', '1.50'],
    ['1.000000', '1.00'],
    ['2.100000', '2.10'],
    // exponent form (>= 1e21): toFixed gives no '.', so no decimals are appended
    ['1e21', '1e+21'],
  ])('formats %s as %s', (input, expected) => {
    expect(formatAmount(input)).toBe(expected)
  })

  it.each(['abc', 'NaN', 'Infinity'])('returns non-finite input %s unchanged', (input) => {
    expect(formatAmount(input)).toBe(input)
  })
})

describe('formatDate / formatDateTime', () => {
  it('formats DD.MM.YYYY from UTC parts, zero-padded', () => {
    expect(formatDate(new Date('2026-05-06T00:00:00.000Z'))).toBe('06.05.2026')
    expect(formatDate(new Date('2026-12-31T23:59:59.000Z'))).toBe('31.12.2026')
  })

  it('uses UTC fields, not host-timezone fields', () => {
    const d = new Date('2026-05-26T14:07:09.000Z')
    const local = vi.spyOn(d, 'getDate').mockReturnValue(1)
    const localH = vi.spyOn(d, 'getHours').mockReturnValue(1)
    const localM = vi.spyOn(d, 'getMonth').mockReturnValue(0)
    expect(formatDate(d)).toBe('26.05.2026')
    expect(formatDateTime(d)).toBe('26.05.2026 14:07:09 UTC')
    local.mockRestore()
    localH.mockRestore()
    localM.mockRestore()
  })

  it('zero-pads time parts', () => {
    expect(formatDateTime(new Date('2026-01-02T03:04:05.000Z'))).toBe('02.01.2026 03:04:05 UTC')
  })

  it('formats two-digit time parts', () => {
    expect(formatDateTime(new Date('2026-05-26T23:59:58.000Z'))).toBe('26.05.2026 23:59:58 UTC')
  })
})

describe('signatureMethodLine', () => {
  it('nests the auto method label for AUTO_COMPANY', () => {
    expect(signatureMethodLine('AUTO_COMPANY', t)).toBe(
      'invoicePdf.method.line(method=invoicePdf.signature.methodAuto)',
    )
  })

  it('nests the click method label for any other method', () => {
    expect(signatureMethodLine('CLICK_COUNTERPARTY', t)).toBe(
      'invoicePdf.method.line(method=invoicePdf.signature.methodClick)',
    )
  })
})

describe('formatPeriod', () => {
  it('renders month name + year through the period message', () => {
    expect(formatPeriod('2026-05', t)).toBe(
      'invoicePdf.period(month=invoicePdf.month.05,year=2026)',
    )
    expect(formatPeriod('2025-12', t)).toBe(
      'invoicePdf.period(month=invoicePdf.month.12,year=2025)',
    )
  })

  it.each([
    '2026-13',
    '2026-00',
    '2026-5',
    '26-05',
    '2026-05-01',
    ' 2026-05',
    '2026-05 ',
    'abc',
    '',
  ])('falls back to the raw string for %j', (raw) => {
    expect(formatPeriod(raw, t)).toBe(raw)
  })
})

describe('buildDescription', () => {
  const base = (over: Partial<InvoiceTransactionInfo>): InvoiceTransactionInfo => ({
    id: 'x',
    type: 'SENIOR_INCOME',
    amount: '1',
    currency: 'USD',
    txDate: new Date(0),
    ...over,
  })
  const PERIOD = 'invoicePdf.period(month=invoicePdf.month.05,year=2026)'

  it('SENIOR_INCOME with contract number: contract line, no project line', () => {
    expect(buildDescription(base({ contractNumber: 'CHK-1', projectName: 'Acme' }), t)).toEqual([
      'invoicePdf.description.contract(contractNumber=CHK-1)',
    ])
  })

  it('SENIOR_INCOME with contract + month appends the period line', () => {
    expect(buildDescription(base({ contractNumber: 'CHK-1', salaryMonth: '2026-05' }), t)).toEqual([
      'invoicePdf.description.contract(contractNumber=CHK-1)',
      `invoicePdf.description.period(period=${PERIOD})`,
    ])
  })

  it('SENIOR_INCOME legacy project phrasing when no contract number', () => {
    expect(buildDescription(base({ projectName: 'Acme' }), t)).toEqual([
      'invoicePdf.description.project(projectName=Acme)',
    ])
  })

  it('SENIOR_INCOME with neither renders an em-dash contract line', () => {
    expect(buildDescription(base({ contractNumber: null, projectName: null }), t)).toEqual([
      'invoicePdf.description.contract(contractNumber=—)',
    ])
  })

  it('SENIOR_INCOME never renders projectNames', () => {
    expect(buildDescription(base({ contractNumber: 'C', projectNames: ['A', 'B'] }), t)).toEqual([
      'invoicePdf.description.contract(contractNumber=C)',
    ])
  })

  it('SALARY with month uses the for-period message', () => {
    expect(buildDescription(base({ type: 'SALARY', salaryMonth: '2026-05' }), t)).toEqual([
      `invoicePdf.description.salaryForPeriod(period=${PERIOD})`,
    ])
  })

  it('SALARY without month uses the plain salary message', () => {
    expect(buildDescription(base({ type: 'SALARY' }), t)).toEqual(['invoicePdf.description.salary'])
    expect(buildDescription(base({ type: 'SALARY', salaryMonth: null }), t)).toEqual([
      'invoicePdf.description.salary',
    ])
  })
})

describe('drawSectionHeader', () => {
  it('draws 9pt muted bold header at the margin and advances lineHeight + 2', () => {
    const { calls, drawer } = recorder()
    const y = drawSectionHeader(drawer, page, 'HDR', 700, layout, BOLD)
    expect(calls).toEqual([{ text: 'HDR', x: 50, y: 700, font: BOLD, size: 9, color: MUTED }])
    expect(y).toBe(684)
  })
})

describe('drawLine', () => {
  it('draws 11pt text in the default text colour and advances lineHeight', () => {
    const { calls, drawer } = recorder()
    const y = drawLine(drawer, page, 'row', 600, layout, REG)
    expect(calls).toEqual([{ text: 'row', x: 50, y: 600, font: REG, size: 11, color: TEXT }])
    expect(y).toBe(586)
  })

  it('honours an explicit colour override', () => {
    const { calls, drawer } = recorder()
    drawLine(drawer, page, 'row', 600, layout, REG, WARNING)
    expect(calls[0]?.color).toBe(WARNING)
  })
})

describe('drawCompanySignature', () => {
  const sig: InvoiceSignatureInfo = {
    role: 'COMPANY',
    signerName: 'Secret Admin Name',
    signedAt: new Date('2026-05-26T14:00:00.000Z'),
    method: 'AUTO_COMPANY',
    pdfHashFull: 'a'.repeat(64),
    ipLastOctet: '42',
  }

  it('without a signature: title + pending placeholder, cursor 2 lines + 2 down', () => {
    const { calls, drawer } = recorder()
    const y = drawCompanySignature(drawer, page, 500, layout, BOLD, REG, undefined, t)
    expect(calls).toEqual([
      { text: 'invoicePdf.signature.contractor', x: 50, y: 500, font: BOLD, size: 11, color: TEXT },
      {
        text: '   invoicePdf.signature.pendingAuto',
        x: 50,
        y: 484,
        font: REG,
        size: 11,
        color: MUTED,
      },
    ])
    expect(y).toBe(470)
  })

  it('with a signature: brand only (never signerName), timestamp, method; cursor after 3 rows', () => {
    const { calls, drawer } = recorder()
    const y = drawCompanySignature(drawer, page, 500, layout, BOLD, REG, sig, t)
    expect(calls).toEqual([
      { text: 'invoicePdf.signature.contractor', x: 50, y: 500, font: BOLD, size: 11, color: TEXT },
      { text: `   ${COMPANY_BRAND_NAME}`, x: 50, y: 484, font: REG, size: 11, color: TEXT },
      { text: '   26.05.2026 14:00:00 UTC', x: 50, y: 470, font: REG, size: 10, color: MUTED },
      {
        text: '   invoicePdf.method.line(method=invoicePdf.signature.methodAuto)',
        x: 50,
        y: 456,
        font: REG,
        size: 10,
        color: MUTED,
      },
    ])
    expect(calls.some((c) => c.text.includes('Secret Admin Name'))).toBe(false)
    expect(y).toBe(442)
  })
})

describe('drawCounterpartySignature', () => {
  const sig: InvoiceSignatureInfo = {
    role: 'COUNTERPARTY',
    signerName: 'Jane Doe',
    signedAt: new Date('2026-05-26T15:30:00.000Z'),
    method: 'CLICK_COUNTERPARTY',
    pdfHashFull: 'abcdef0123456789'.repeat(4),
    ipLastOctet: '42',
  }

  it('without a signature: title, warning placeholder, fallback name; cursor 2 extra lines', () => {
    const { calls, drawer } = recorder()
    const y = drawCounterpartySignature(
      drawer,
      page,
      500,
      layout,
      BOLD,
      REG,
      undefined,
      'Jane D',
      t,
    )
    expect(calls).toEqual([
      { text: 'invoicePdf.signature.client', x: 50, y: 500, font: BOLD, size: 11, color: TEXT },
      {
        text: '   invoicePdf.signature.pending',
        x: 50,
        y: 484,
        font: REG,
        size: 11,
        color: WARNING,
      },
      { text: '   (Jane D)', x: 50, y: 470, font: REG, size: 10, color: MUTED },
    ])
    expect(y).toBe(456)
  })

  it('with a full signature: name, timestamp, short hash, method; no IP; cursor after 4 rows', () => {
    const { calls, drawer } = recorder()
    const y = drawCounterpartySignature(drawer, page, 500, layout, BOLD, REG, sig, 'ignored', t)
    expect(calls).toEqual([
      { text: 'invoicePdf.signature.client', x: 50, y: 500, font: BOLD, size: 11, color: TEXT },
      { text: '   Jane Doe', x: 50, y: 484, font: REG, size: 11, color: TEXT },
      { text: '   26.05.2026 15:30:00 UTC', x: 50, y: 470, font: REG, size: 10, color: MUTED },
      { text: '   Hash: abcdef01', x: 50, y: 456, font: REG, size: 10, color: MUTED },
      {
        text: '   invoicePdf.method.line(method=invoicePdf.signature.methodClick)',
        x: 50,
        y: 442,
        font: REG,
        size: 10,
        color: MUTED,
      },
    ])
    expect(calls.some((c) => c.text.includes('IP') || c.text.includes('42'))).toBe(false)
    expect(y).toBe(428)
  })

  it('without a hash: skips the hash row and does not advance for it', () => {
    const { calls, drawer } = recorder()
    const y = drawCounterpartySignature(
      drawer,
      page,
      500,
      layout,
      BOLD,
      REG,
      { ...sig, pdfHashFull: undefined },
      'x',
      t,
    )
    expect(calls.map((c) => c.text)).toEqual([
      'invoicePdf.signature.client',
      '   Jane Doe',
      '   26.05.2026 15:30:00 UTC',
      '   invoicePdf.method.line(method=invoicePdf.signature.methodClick)',
    ])
    expect(calls[3]?.y).toBe(456)
    expect(y).toBe(442)
  })
})

describe('drawVerifyBlock', () => {
  it('embeds the QR for the verify URL and lays out the image + label + url', async () => {
    const drawImage = vi.fn()
    const p = { drawImage } as unknown as PDFPage
    const doc = { doc: true } as unknown as PDFDocument
    const { calls, drawer, image } = recorder()
    await drawVerifyBlock(drawer, p, doc, 300, layout, REG, 'https://x.test/v/1', t)

    expect(drawer.embedQrPng).toHaveBeenCalledWith(doc, 'https://x.test/v/1')
    const qr = PDF_LAYOUT.qrSize
    expect(drawImage).toHaveBeenCalledTimes(1)
    expect(drawImage).toHaveBeenCalledWith(image, { x: 50, y: 300 - qr, width: qr, height: qr })
    const textX = 50 + qr + 14
    expect(calls).toEqual([
      { text: 'invoicePdf.verify', x: textX, y: 284, font: REG, size: 10, color: MUTED },
      { text: 'https://x.test/v/1', x: textX, y: 270, font: REG, size: 9, color: ACCENT },
    ])
  })
})
