import { describe, expect, it } from 'vitest'
import { createI18n } from './catalog'

describe('createI18n', () => {
  it('returns independent instances with their own locale', () => {
    const uk = createI18n('uk')
    const en = createI18n('en')
    expect(uk.locale).toBe('uk')
    expect(en.locale).toBe('en')
    expect(uk._(/* i18n */ { id: 'smoke.hello', message: 'Привіт' })).toBe('Привіт')
  })
})
