import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createI18n } from '../i18n/catalog'
import {
  AMOUNT_DECIMAL_PLACES,
  MIN_TRANSACTION_AMOUNT,
  SALARY_AMOUNT_DECIMAL_PLACES,
  MIN_SALARY_AMOUNT,
} from './money'
import { MAX_TRANSACTION_AMOUNT, COMPANY_REQUISITES_MAX } from './finance'
import {
  ZOD_ERROR_CODES,
  ZOD_ERROR_FALLBACK_EN,
  ZOD_ERROR_MESSAGES,
  zodErrorFallbackText,
} from './zod-errors'

const EN_CATALOG_PATH = join(__dirname, '..', 'i18n', 'locales', 'en', 'messages.po')

describe('ZOD_ERROR_MESSAGES', () => {
  it('RNOKPP_FORMAT has a uk message descriptor', () => {
    const i18n = createI18n('uk')
    const message = ZOD_ERROR_MESSAGES.RNOKPP_FORMAT.message
    expect(
      i18n._(
        ZOD_ERROR_MESSAGES.RNOKPP_FORMAT.id,
        undefined,
        message !== undefined ? { message } : undefined,
      ),
    ).toBe('Введіть 10 цифр РНОКПП')
  })

  it('every code has a message descriptor with an explicit id matching the code', () => {
    for (const code of ZOD_ERROR_CODES) {
      expect(ZOD_ERROR_MESSAGES[code].id).toBe(`zod-error.${code}`)
      expect(ZOD_ERROR_MESSAGES[code].message?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('every code has a non-empty English fallback', () => {
    for (const code of ZOD_ERROR_CODES) {
      expect(ZOD_ERROR_FALLBACK_EN[code].length).toBeGreaterThan(0)
    }
  })

  it('ZOD_ERROR_FALLBACK_EN equals the en catalog string exactly, for every code', () => {
    const poText = readFileSync(EN_CATALOG_PATH, 'utf-8')
    for (const code of ZOD_ERROR_CODES) {
      const enCatalogMatch = poText.match(
        new RegExp(`msgid "zod-error\\.${code}"\\nmsgstr "((?:[^"\\\\]|\\\\.)*)"`),
      )
      expect(enCatalogMatch, `${code}: entry not found in en/messages.po`).not.toBeNull()
      expect(ZOD_ERROR_FALLBACK_EN[code], `${code}: fallback vs en catalog`).toBe(
        enCatalogMatch?.[1] ?? '',
      )
    }
  })

  it('every code resolves to non-empty text through createI18n for both locales', () => {
    for (const locale of ['uk', 'en'] as const) {
      const i18n = createI18n(locale)
      for (const code of ZOD_ERROR_CODES) {
        const descriptor = ZOD_ERROR_MESSAGES[code]
        const options =
          descriptor.message !== undefined ? { message: descriptor.message } : undefined
        const text = i18n._(descriptor.id, undefined, options)
        expect(text.length, `${code} (${locale})`).toBeGreaterThan(0)
      }
    }
  })
})

/**
 * fix-round 1, SPEC-M-1: the module doc-comment on `zod-errors.ts` claims a
 * baked-in number in a message text is pinned against its live constant "so
 * a future change to either drifts loudly (a failing test)" — this describes
 * were the tests below, which did not exist until this round. Every literal
 * digit sequence baked into a message is derived from the SAME constant here
 * (`.toLocaleString('en-US')`, comma thousands separator for en, the same
 * string with commas swapped for spaces for uk — matches both locales'
 * existing formatting in the registry text without depending on Node's ICU
 * data for a `uk-UA` Intl locale).
 */
describe('numbers baked into ZOD_ERROR_MESSAGES/ZOD_ERROR_FALLBACK_EN pin the live constant', () => {
  it('TRANSACTION_AMOUNT_TOO_SMALL pins MIN_TRANSACTION_AMOUNT', () => {
    const digits = MIN_TRANSACTION_AMOUNT.toFixed(AMOUNT_DECIMAL_PLACES)
    expect(ZOD_ERROR_MESSAGES.TRANSACTION_AMOUNT_TOO_SMALL.message).toContain(digits)
    expect(ZOD_ERROR_FALLBACK_EN.TRANSACTION_AMOUNT_TOO_SMALL).toContain(digits)
  })

  it('TRANSACTION_AMOUNT_TOO_MANY_DECIMALS pins AMOUNT_DECIMAL_PLACES', () => {
    const digits = String(AMOUNT_DECIMAL_PLACES)
    expect(ZOD_ERROR_MESSAGES.TRANSACTION_AMOUNT_TOO_MANY_DECIMALS.message).toContain(digits)
    expect(ZOD_ERROR_FALLBACK_EN.TRANSACTION_AMOUNT_TOO_MANY_DECIMALS).toContain(digits)
  })

  it('SALARY_AMOUNT_TOO_SMALL pins MIN_SALARY_AMOUNT', () => {
    const digits = MIN_SALARY_AMOUNT.toFixed(SALARY_AMOUNT_DECIMAL_PLACES)
    expect(ZOD_ERROR_MESSAGES.SALARY_AMOUNT_TOO_SMALL.message).toContain(digits)
    expect(ZOD_ERROR_FALLBACK_EN.SALARY_AMOUNT_TOO_SMALL).toContain(digits)
  })

  it('SALARY_AMOUNT_TOO_MANY_DECIMALS pins SALARY_AMOUNT_DECIMAL_PLACES', () => {
    const digits = String(SALARY_AMOUNT_DECIMAL_PLACES)
    expect(ZOD_ERROR_MESSAGES.SALARY_AMOUNT_TOO_MANY_DECIMALS.message).toContain(digits)
    expect(ZOD_ERROR_FALLBACK_EN.SALARY_AMOUNT_TOO_MANY_DECIMALS).toContain(digits)
  })

  it('TRANSACTION_AMOUNT_EXCEEDS_MAX pins MAX_TRANSACTION_AMOUNT', () => {
    const en = MAX_TRANSACTION_AMOUNT.toLocaleString('en-US')
    const uk = en.replace(/,/g, ' ')
    expect(ZOD_ERROR_MESSAGES.TRANSACTION_AMOUNT_EXCEEDS_MAX.message).toContain(uk)
    expect(ZOD_ERROR_FALLBACK_EN.TRANSACTION_AMOUNT_EXCEEDS_MAX).toContain(en)
  })

  it('REQUISITES_TOO_LONG pins COMPANY_REQUISITES_MAX', () => {
    const en = COMPANY_REQUISITES_MAX.toLocaleString('en-US')
    const uk = en.replace(/,/g, ' ')
    expect(ZOD_ERROR_MESSAGES.REQUISITES_TOO_LONG.message).toContain(uk)
    expect(ZOD_ERROR_FALLBACK_EN.REQUISITES_TOO_LONG).toContain(en)
  })
})

describe('zodErrorFallbackText', () => {
  it('translates a coded zod.<CODE> message to its English fallback', () => {
    expect(zodErrorFallbackText('zod.RECEIPT_REQUIRED')).toBe(
      ZOD_ERROR_FALLBACK_EN.RECEIPT_REQUIRED,
    )
  })

  it('passes a non-coded message through unchanged', () => {
    expect(zodErrorFallbackText('Cannot transfer to yourself')).toBe('Cannot transfer to yourself')
  })

  it('passes an unknown zod.<CODE>-shaped message through unchanged', () => {
    expect(zodErrorFallbackText('zod.NOT_A_REAL_CODE')).toBe('zod.NOT_A_REAL_CODE')
  })
})
