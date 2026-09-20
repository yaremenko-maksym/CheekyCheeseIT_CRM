// task-i18n-stage2 (Task 6) — runtime locale activation for the browser.
// Companion to `i18n-smoke.test.tsx` (proves lingui macros compile under
// vitest); this file proves OUR wrapper around the shared `@lingui/core`
// singleton — cookie/navigator fallback order and the side effects
// `activateLocale` performs (`i18n.locale`, `<html lang>`, `pref_locale`
// cookie) — matches the plan's contract (docs/superpowers/plans/
// 2026-09-19-crm-i18n-stage2-foundation.md, Task 6, Step 1).
import { describe, expect, it, beforeEach } from 'vitest'
import { activateLocale, i18n, readPreLoginLocale } from '../i18n'

describe('i18n runtime', () => {
  beforeEach(() => {
    document.cookie = 'pref_locale=; Max-Age=0'
  })

  it('readPreLoginLocale prefers the cookie, then navigator.language, then uk', () => {
    document.cookie = 'pref_locale=en'
    expect(readPreLoginLocale()).toBe('en')

    document.cookie = 'pref_locale=; Max-Age=0'
    Object.defineProperty(navigator, 'language', { value: 'de-DE', configurable: true })
    expect(readPreLoginLocale()).toBe('uk')
  })

  it('readPreLoginLocale falls back to navigator.language when it IS supported', () => {
    document.cookie = 'pref_locale=; Max-Age=0'
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
    expect(readPreLoginLocale()).toBe('en')
  })

  it('activateLocale switches the active locale, <html lang> and the cookie', async () => {
    await activateLocale('en')
    expect(i18n.locale).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(document.cookie).toContain('pref_locale=en')

    await activateLocale('uk')
    expect(i18n.locale).toBe('uk')
    expect(document.documentElement.lang).toBe('uk')
    expect(document.cookie).toContain('pref_locale=uk')
  })
})
