import { describe, expect, it } from 'vitest'
import { createI18n } from './catalog'
import type { Locale } from './locales'

describe('createI18n', () => {
  it('returns independent instances with their own locale', () => {
    const uk = createI18n('uk')
    const en = createI18n('en')
    expect(uk.locale).toBe('uk')
    expect(en.locale).toBe('en')
    expect(uk._(/* i18n */ { id: 'smoke.hello', message: 'Привіт' })).toBe('Привіт')
  })

  it('propagates a genuinely missing catalog instead of returning an empty instance', () => {
    // `loadMessages` has a two-path fallback (bare require, then an explicit
    // `.ts` extension — see the doc comment on `loadMessages` in catalog.ts)
    // that only ever runs for the two REAL locales, where one of the two
    // paths always resolves. A locale with no compiled catalog at all fails
    // BOTH paths and must propagate that failure rather than silently
    // produce a usable, empty `I18n` instance — the distinction that matters
    // for a caller: "no catalog" is a bug to surface, not a state to render.
    expect(() => createI18n('fr' as Locale)).toThrow()
  })
})
