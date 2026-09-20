import { describe, expect, it } from 'vitest'
import { resolveRequestLocale } from './request-locale'

describe('resolveRequestLocale', () => {
  it('prefers the authenticated user locale', () => {
    expect(
      resolveRequestLocale({
        user: { locale: 'en' },
        cookies: { pref_locale: 'uk' },
        headers: { 'accept-language': 'uk' },
      }),
    ).toBe('en')
  })
  it('then the pref_locale cookie', () => {
    expect(
      resolveRequestLocale({
        cookies: { pref_locale: 'en' },
        headers: { 'accept-language': 'uk-UA,uk;q=0.9' },
      }),
    ).toBe('en')
  })
  it('then Accept-Language, ignoring unsupported languages', () => {
    expect(
      resolveRequestLocale({ headers: { 'accept-language': 'de-DE,de;q=0.9,en-US;q=0.8' } }),
    ).toBe('en')
  })
  it('defaults to uk', () => {
    expect(resolveRequestLocale({ headers: {} })).toBe('uk')
  })
  // task-i18n-stage2 (Task 4) — plan's own contingency: `@fastify/cookie` IS
  // registered in this repo (verified: `apps/api/src/main.ts` registers it
  // globally), so `request.cookies` is always populated in production. This
  // case pins the defensive branch anyway — `req.cookies` being absent
  // entirely (e.g. a caller that built a bare `{ headers }` object, same
  // shape as the two cases above) must fall through to Accept-Language /
  // default instead of throwing.
  it('falls through to Accept-Language when cookies is absent entirely', () => {
    expect(resolveRequestLocale({ headers: { 'accept-language': 'en-US,en;q=0.9' } })).toBe('en')
  })
  it('ignores an unsupported user locale and falls through to the cookie', () => {
    expect(
      resolveRequestLocale({
        user: { locale: 'ru' },
        cookies: { pref_locale: 'en' },
        headers: {},
      }),
    ).toBe('en')
  })
  it('ignores a null user locale', () => {
    expect(
      resolveRequestLocale({
        user: { locale: null },
        cookies: { pref_locale: 'en' },
        headers: {},
      }),
    ).toBe('en')
  })
})
