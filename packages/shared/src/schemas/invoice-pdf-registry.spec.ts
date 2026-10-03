import { describe, expect, it } from 'vitest'
import { createI18n } from '../i18n'
import { INVOICE_PDF_MESSAGES, INVOICE_PDF_MONTH_MESSAGES } from './invoice-pdf-registry'
import { renderMessage } from './notification-registry'

const UK = createI18n('uk')
const EN = createI18n('en')

// One value per placeholder any invoice message uses; extra keys are ignored by ICU.
const values = {
  number: 'ab12cd34',
  date: '26.05.2026',
  method: 'METHOD',
  currency: 'UAH',
  value: 'VALUE',
  contractNumber: 'CHK-1-2026',
  projectName: 'Acme',
  period: 'PERIOD',
  month: 'MONTH',
  year: '2026',
  amount: '1 000.00',
  rateDate: '25.05.2026',
}

const all = [...Object.values(INVOICE_PDF_MESSAGES), ...Object.values(INVOICE_PDF_MONTH_MESSAGES)]

describe('INVOICE_PDF_MESSAGES / INVOICE_PDF_MONTH_MESSAGES', () => {
  it('has unique, namespaced ids', () => {
    const ids = all.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^invoicePdf\./)
  })

  it('every descriptor carries a non-empty uk source message (the fallback the catalog extracts)', () => {
    for (const d of all) expect((d.message ?? '').length).toBeGreaterThan(0)
  })

  it('carries one entry per calendar month, keyed 01..12', () => {
    // sorted: JS orders canonical-integer keys ('10'..'12') before '01'..'09'.
    expect(Object.keys(INVOICE_PDF_MONTH_MESSAGES).sort()).toEqual([
      '01',
      '02',
      '03',
      '04',
      '05',
      '06',
      '07',
      '08',
      '09',
      '10',
      '11',
      '12',
    ])
  })

  it('every message renders fully in both locales (no leftover placeholder or raw id)', () => {
    for (const d of all) {
      for (const i18n of [UK, EN]) {
        const out = renderMessage(i18n, d, values)
        expect(out.length).toBeGreaterThan(0)
        expect(out).not.toMatch(/[{}]/)
        expect(out).not.toBe(d.id)
      }
    }
  })

  it('en is a second original: never Cyrillic, never the uk text', () => {
    for (const d of all) {
      const en = renderMessage(EN, d, values)
      expect(en).not.toMatch(/[Ѐ-ӿ]/)
    }
    expect(renderMessage(EN, INVOICE_PDF_MESSAGES.titleAct)).toBe('ACT OF SERVICES RENDERED')
    expect(renderMessage(UK, INVOICE_PDF_MESSAGES.titleAct)).toBe('АКТ ВИКОНАНИХ РОБІТ')
  })

  it('substitutes params untouched, in the order each locale writes them', () => {
    expect(renderMessage(UK, INVOICE_PDF_MESSAGES.period, { month: 'травень', year: '2026' })).toBe(
      'травень 2026',
    )
    expect(renderMessage(EN, INVOICE_PDF_MESSAGES.period, { month: 'May', year: '2026' })).toBe(
      'May 2026',
    )
    expect(
      renderMessage(UK, INVOICE_PDF_MESSAGES.uahEquivalent, {
        amount: '50 432.10',
        rateDate: '26.05.2026',
      }),
    ).toBe('≈ 50 432.10 UAH (курс НБУ 26.05.2026)')
  })
})
