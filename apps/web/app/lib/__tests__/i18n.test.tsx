// task-i18n-stage2 (Task 6) — runtime locale activation for the browser.
// Companion to `i18n-smoke.test.tsx` (proves lingui macros compile under
// vitest); this file proves OUR wrapper around the shared `@lingui/core`
// singleton — cookie/navigator fallback order and the side effects
// `activateLocale` performs (`i18n.locale`, `<html lang>`, `pref_locale`
// cookie) — matches the plan's contract (docs/superpowers/plans/
// 2026-09-19-crm-i18n-stage2-foundation.md, Task 6, Step 1).
//
// fix-round 1 (PR #695, SPEC-H-1b gate: mutation-gate `survived 0`) —
// several cases below exist ONLY to kill specific mutants the original
// assertions let through. Each one says which mutant and why the original
// test missed it, so a future edit doesn't delete it as "redundant":
//
//  - The happy-dom test environment's default `navigator.language` already
//    resolves to the SAME locale ('en') the cookie-priority test's first
//    assertion expected, via `resolveLocale`'s navigator.language fallback
//    (packages/shared/src/i18n/locales.ts). That masked EVERY mutation to
//    `readCookie` (StringLiteral/OptionalChaining/MethodExpression/
//    BlockStatement, all reported at apps/web/app/lib/i18n.ts:18-22): break
//    `readCookie` entirely and the assertion still passed, because the
//    fallback path produced the same expected value by coincidence, not
//    because the cookie was actually read. Forcing `navigator.language` to
//    an UNSUPPORTED value before asserting on the cookie's value removes
//    that coincidence — a broken `readCookie` now falls through to
//    `DEFAULT_LOCALE` ('uk'), which disagrees with the cookie's real value.
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { activateLocale, i18n, readPreLoginLocale } from '../i18n'
import type { Locale } from '@crm/shared'

describe('i18n runtime', () => {
  beforeEach(() => {
    document.cookie = 'pref_locale=; Max-Age=0'
    // Unsupported by `resolveLocale` (packages/shared/src/i18n/locales.ts
    // only recognizes 'uk'/'en' prefixes) so the navigator.language
    // fallback can never coincidentally produce the SAME locale a test is
    // asserting the COOKIE produced — see the file-level comment above.
    Object.defineProperty(navigator, 'language', { value: 'de-DE', configurable: true })
  })

  it('readPreLoginLocale reads the cookie even with an unsupported navigator.language fallback', () => {
    // A second, unrelated cookie ahead of `pref_locale` in the jar: if the
    // `'; '` separator (i18n.ts:20) were mutated away, `.split('; ')` would
    // never split the two cookies apart and `.find` would never match
    // `pref_locale=` as a PREFIX of the single combined string.
    document.cookie = 'other_cookie=xyz'
    document.cookie = 'pref_locale=en'
    expect(readPreLoginLocale()).toBe('en')
  })

  it('readPreLoginLocale does not match a cookie whose value merely CONTAINS the target name', () => {
    // `startsWith` (i18n.ts:21), not a substring test: a cookie named
    // `xpref_locale` must NOT satisfy `c.startsWith('pref_locale=')` —
    // kills the MethodExpression mutant that swaps `startsWith`→`endsWith`
    // (which this string would satisfy) and the StringLiteral mutant that
    // empties the matched prefix (which ANY cookie would satisfy).
    document.cookie = 'xpref_locale=fr'
    expect(readPreLoginLocale()).toBe('uk')
  })

  it('readPreLoginLocale falls back to uk when no cookie matches, without throwing', () => {
    // No `pref_locale` cookie exists here (cleared in beforeEach, navigator
    // unsupported) — `readCookie`'s `.find(...)` legitimately returns
    // `undefined`, and `?.split('=')[1]` (i18n.ts:22) must short-circuit
    // rather than throw `Cannot read properties of undefined`. Kills the
    // OptionalChaining mutant (`?.` → `.`), which would make this call
    // throw instead of returning `uk`.
    expect(readPreLoginLocale()).toBe('uk')
  })

  it('readPreLoginLocale prefers the cookie over a SUPPORTED navigator.language', () => {
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
    document.cookie = 'pref_locale=uk'
    expect(readPreLoginLocale()).toBe('uk')
  })

  it('readPreLoginLocale falls back to navigator.language when it IS supported', () => {
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

  it('activateLocale writes a one-year Max-Age on the pref_locale cookie', async () => {
    // Reading `document.cookie` back (the getter) never exposes attributes
    // like Max-Age — browsers and happy-dom alike only ever return
    // `name=value` pairs from the getter, per spec. Spying on the SETTER is
    // the only way to see the exact string `activateLocale` writes, which
    // is what actually kills the three ArithmeticOperator mutants at
    // i18n.ts:111 (each swaps one `*` for `/` between the four factors of
    // `60 * 60 * 24 * 365`, changing this number — a substring assertion on
    // `pref_locale=en` alone, as the test above uses, cannot see that).
    const setCookie = vi.spyOn(document, 'cookie', 'set')
    await activateLocale('en')
    expect(setCookie).toHaveBeenCalledWith('pref_locale=en; Path=/; Max-Age=31536000; SameSite=Lax')
  })

  it('activateLocale rejects a locale with no compiled catalog instead of activating undefined messages', async () => {
    // `Locale` only ever admits 'uk'/'en' at the type level, so this branch
    // (i18n.ts:105, `if (!loadCatalog)`) is unreachable through normal
    // typed callers — the cast mirrors how it WOULD be reached: a stale
    // build, a corrupted `@crm/shared-i18n-locales` glob, or (Task 4/API
    // parity) a locale the request-side resolver admits that the web
    // catalog glob does not. Kills the ConditionalExpression mutant that
    // forces this guard to `if (false)`, which would let execution fall
    // through to `await loadCatalog()` on `undefined` and throw a much less
    // diagnosable "loadCatalog is not a function" instead of this message.
    await expect(activateLocale('fr' as Locale)).rejects.toThrow(
      'activateLocale: no compiled catalog found for locale "fr"',
    )
  })
})
