import { describe, expect, it, vi } from 'vitest'
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

  // SPEC-H-1 (spec-review круг 1, PR #714): `@lingui/core`'s `I18n` constructor
  // only self-registers `compileMessage` as the message compiler when
  // `process.env.NODE_ENV !== 'production'` (same defect class as SR-M-1,
  // `api-error.ts`'s `interpolate()`, #704 fix-round 1). Without the explicit
  // `setMessagesCompiler(compileMessage)` call in `createI18n`, an id missing
  // from the compiled catalog (or a caller passing only the inline `{ message
  // }` fallback) would render the raw ICU template VERBATIM under
  // `NODE_ENV=production` and log a `console.warn` on every call. Red without
  // the registration — verified by commenting out `i18n.setMessagesCompiler(
  // compileMessage)` in `catalog.ts` locally and re-running this test, which
  // then fails on both assertions. `NODE_ENV` restored in `finally`.
  it('registers the message compiler even under NODE_ENV=production (SPEC-H-1)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const originalNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const i18n = createI18n('uk')
      // An id that is NOT in the compiled catalog forces the inline `message`
      // fallback path — the exact path `compileMessage` has to handle.
      const out = i18n._(
        'smoke.paramSample.doesNotExist',
        { value: 42 },
        { message: 'Значення: {value}' },
      )
      expect(out).toBe('Значення: 42')
      expect(out).not.toMatch(/[{}]/)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      process.env.NODE_ENV = originalNodeEnv
      warnSpy.mockRestore()
    }
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
