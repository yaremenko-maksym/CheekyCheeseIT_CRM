import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createI18n } from '../i18n/catalog'
import { ZOD_ERROR_CODES, ZOD_ERROR_FALLBACK_EN, ZOD_ERROR_MESSAGES } from './zod-errors'

const EN_CATALOG_PATH = join(__dirname, '..', 'i18n', 'locales', 'en', 'messages.po')

describe('ZOD_ERROR_MESSAGES', () => {
  it('RNOKPP_FORMAT has a uk message descriptor', () => {
    const i18n = createI18n('uk')
    expect(
      i18n._(ZOD_ERROR_MESSAGES.RNOKPP_FORMAT.id, undefined, {
        message: ZOD_ERROR_MESSAGES.RNOKPP_FORMAT.message,
      }),
    ).toBe('РНОКПП має містити 10 цифр')
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
        const text = i18n._(descriptor.id, undefined, { message: descriptor.message })
        expect(text.length, `${code} (${locale})`).toBeGreaterThan(0)
      }
    }
  })
})
