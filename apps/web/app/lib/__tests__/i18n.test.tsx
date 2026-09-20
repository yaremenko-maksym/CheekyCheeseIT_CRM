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
    // fix-round 2 (PR #695, CR-M-1 mutation-gate survivor): the ORIGINAL
    // form of this test relied on `beforeEach`'s `document.cookie =
    // 'pref_locale=; Max-Age=0'` to make `.find(...)` return `undefined` —
    // but happy-dom (like real browsers) only expires an EXISTING cookie
    // via `Max-Age=0`; with no `pref_locale` cookie set yet, that line
    // instead CREATES one with an empty value, so `document.cookie` still
    // contains the literal substring `pref_locale=` for the rest of the
    // test (verified directly: `document.cookie` reads back
    // `"pref_locale="`). `.find(c => c.startsWith('pref_locale='))` then
    // matches that empty-value cookie and never returns `undefined` at
    // all — the mutation gate's `SURVIVED` report on the `?.` at i18n.ts:19
    // is exactly this: removing the optional chaining changed nothing,
    // because no test ever exercised the truly-empty jar. Stubbing the
    // `document.cookie` GETTER directly is the only way to produce a real
    // empty jar without depending on cookie-expiry semantics at all.
    // Restored explicitly (no global `restoreMocks` in this project's
    // vitest config) — an un-restored getter mock would silently blank
    // `document.cookie` for every test that runs after this one in the
    // same file.
    const cookieGetter = vi.spyOn(document, 'cookie', 'get').mockReturnValue('')
    try {
      expect(readPreLoginLocale()).toBe('uk')
    } finally {
      cookieGetter.mockRestore()
    }
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

  it('activateLocale sets the Secure flag on the pref_locale cookie over https', async () => {
    // CR-M-1 (fix-round 2, PR #695): over https the cookie MUST carry
    // `Secure` — otherwise a network attacker on the same wifi who can
    // inject an http:// response (no TLS needed for THAT leg) can plant an
    // arbitrary `pref_locale` value that a subsequent https request would
    // still send. Spying on the setter (not reading `document.cookie` back)
    // is required: the getter never exposes attributes like `Secure`, only
    // `name=value` pairs — same reasoning as the Max-Age test above.
    const setCookie = vi.spyOn(document, 'cookie', 'set')
    Object.defineProperty(window, 'location', {
      value: { ...window.location, protocol: 'https:' },
      writable: true,
      configurable: true,
    })
    await activateLocale('en')
    expect(setCookie).toHaveBeenCalledWith(
      'pref_locale=en; Path=/; Max-Age=31536000; SameSite=Lax; Secure',
    )
  })

  it('activateLocale omits the Secure flag on the pref_locale cookie over plain http', async () => {
    // Dev (`http://localhost`) MUST NOT carry `Secure` — a cookie set with
    // `Secure` over http is silently refused by real browsers, which would
    // break `readPreLoginLocale()` on the very next dev page load. Explicit
    // http case (not just relying on the ambient test default) so a future
    // edit can't accidentally make `secureFlag` unconditional without a
    // failing test — the exact-string assertion above alone would still
    // pass if the http branch were dropped, since it never sets protocol.
    const setCookie = vi.spyOn(document, 'cookie', 'set')
    Object.defineProperty(window, 'location', {
      value: { ...window.location, protocol: 'http:' },
      writable: true,
      configurable: true,
    })
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
