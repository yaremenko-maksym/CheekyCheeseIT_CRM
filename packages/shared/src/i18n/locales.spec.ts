import { describe, expect, it } from 'vitest'
import { DEFAULT_LOCALE, LOCALE_COOKIE_NAME, localeSchema, resolveLocale } from './locales'

describe('locale constants', () => {
  // Pinned directly against the literal, not via resolveLocale's fallback
  // (which would compare the constant against itself post-mutation and
  // never actually notice a change — see the "assertion compares a value
  // against the very constant it should be pinning" incident this repo's
  // mutation gate exists to catch).
  it('DEFAULT_LOCALE is uk', () => {
    expect(DEFAULT_LOCALE).toBe('uk')
  })
  it('LOCALE_COOKIE_NAME is pref_locale', () => {
    expect(LOCALE_COOKIE_NAME).toBe('pref_locale')
  })
})

describe('resolveLocale', () => {
  it('takes the first supported candidate by language prefix', () => {
    expect(resolveLocale(['fr-FR', 'en-US', 'uk'])).toBe('en')
  })
  it('falls back to uk when nothing matches', () => {
    expect(resolveLocale([undefined, null, 'de'])).toBe(DEFAULT_LOCALE)
  })
  it('localeSchema rejects ru', () => {
    expect(localeSchema.safeParse('ru').success).toBe(false)
  })
  it('trims surrounding whitespace before matching the prefix', () => {
    expect(resolveLocale([' en-US '])).toBe('en')
  })
})
