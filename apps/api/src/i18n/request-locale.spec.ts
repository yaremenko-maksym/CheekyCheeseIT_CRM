import { describe, expect, it } from 'vitest'
import { acceptLanguageCandidates, resolveRequestLocale } from './request-locale'

// Direct assertions on the parser itself — see its own doc for why this
// cannot be pinned by observing `resolveRequestLocale`'s tolerant output.
describe('acceptLanguageCandidates', () => {
  it('returns an empty array for an undefined header', () => {
    expect(acceptLanguageCandidates(undefined)).toEqual([])
  })
  it('splits on comma', () => {
    expect(acceptLanguageCandidates('uk,en')).toEqual(['uk', 'en'])
  })
  it('strips the ;q=… weight suffix', () => {
    expect(acceptLanguageCandidates('uk-UA;q=0.9')).toEqual(['uk-UA'])
  })
  it('trims surrounding whitespace', () => {
    expect(acceptLanguageCandidates('uk , en')).toEqual(['uk', 'en'])
  })
  it('drops empty entries (e.g. a trailing comma)', () => {
    expect(acceptLanguageCandidates('uk,')).toEqual(['uk'])
  })
})

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
