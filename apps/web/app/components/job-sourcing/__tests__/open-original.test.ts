import { describe, expect, it, vi } from 'vitest'
import { isSafeExternalUrl, openOriginalPosting } from '../open-original'

/** The canonical shape `canonicalizePostingUrl` produces, used as the trim target. */
const CANONICAL = 'https://host.test/a'

/**
 * task-job-sourcing-slice1 AC5, unit half.
 *
 * The dangerous refactor this guards against is:
 *
 *     const onClick = async () => {
 *       await markApplied()           // ← any await
 *       window.open(url, '_blank')    // ← now outside the user gesture
 *     }
 *
 * On desktop the popup usually still opens, so the bug looks fine in review and
 * in a desktop E2E run; on a phone the button silently does nothing (PR #476).
 * `openOriginalPosting` is therefore a plain synchronous function — the test
 * below asserts it calls `open` before returning, which no `await`-first
 * implementation can satisfy. The mobile-profile Playwright spec
 * (apps/e2e/tests/job-sourcing-mobile.spec.ts) covers the same contract in a
 * real browser.
 */
describe('isSafeExternalUrl', () => {
  it('accepts https', () => {
    expect(isSafeExternalUrl('https://jobs.dou.ua/x/1')).toBe(true)
  })

  it('rejects javascript:, data:, http: and relative URLs', () => {
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isSafeExternalUrl('http://jobs.dou.ua/x/1')).toBe(false)
    expect(isSafeExternalUrl('/relative/path')).toBe(false)
    expect(isSafeExternalUrl('')).toBe(false)
    expect(isSafeExternalUrl(null)).toBe(false)
    expect(isSafeExternalUrl(undefined)).toBe(false)
  })
})

describe('openOriginalPosting', () => {
  it('opens the URL SYNCHRONOUSLY — before the call returns, with no await', () => {
    const open = vi.fn()
    const returned = openOriginalPosting('https://jobs.dou.ua/x/1', open)

    // Asserted immediately, in the same tick: an implementation that awaited
    // anything first would not have called `open` yet.
    expect(open).toHaveBeenCalledTimes(1)
    expect(returned).toBe(true)
  })

  it('passes noopener,noreferrer so the opened page cannot reach our window', () => {
    const open = vi.fn()
    openOriginalPosting('https://jobs.dou.ua/x/1', open)
    expect(open).toHaveBeenCalledWith('https://jobs.dou.ua/x/1', '_blank', 'noopener,noreferrer')
  })

  it('refuses a javascript: URL instead of executing it in our origin', () => {
    const open = vi.fn()
    expect(openOriginalPosting('javascript:alert(1)', open)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('refuses an empty URL without throwing', () => {
    const open = vi.fn()
    expect(openOriginalPosting(null, open)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('is not an async function (an async handler cannot open a popup on mobile)', () => {
    // Belt and braces: if someone converts it to `async`, `constructor.name`
    // flips to AsyncFunction and this fails loudly with the reason.
    expect(openOriginalPosting.constructor.name).toBe('Function')
  })
})

/**
 * R11-H-4 — the last barrier before `window.open` must refuse embedded
 * credentials, exactly as `externalHttpsUrlSchema` in `@crm/shared` does.
 *
 * The predicate used to be `/^https:\/\/\S+$/i`, the same shape as the shared
 * schema's, and `\S+` matches an authority containing `@`: a feed URL of
 * `https://user:pw@evil.test/a` opened a page whose displayed host was a
 * plausible one. The header above claimed "two independent checks, neither one
 * load-bearing alone" — against this class of input they were not independent,
 * they failed identically.
 */
describe('isSafeExternalUrl rejects embedded credentials (R11-H-4)', () => {
  it('refuses credentials in the authority, with and without a password', () => {
    expect(isSafeExternalUrl('https://user:pw@example.com/a')).toBe(false)
    expect(isSafeExternalUrl('https://user@example.com/a')).toBe(false)
  })

  it('still accepts a `@` in the path, query or fragment', () => {
    expect(isSafeExternalUrl('https://host.test/a@b')).toBe(true)
    expect(isSafeExternalUrl('https://host.test/jobs?ref=a@b')).toBe(true)
    expect(isSafeExternalUrl('https://host.test/jobs#a@b')).toBe(true)
  })

  it('still accepts what canonicalizePostingUrl produces', () => {
    expect(isSafeExternalUrl('https://host.test/path?kept=params')).toBe(true)
    expect(isSafeExternalUrl('https://host.test/path')).toBe(true)
    expect(isSafeExternalUrl('https://host.test')).toBe(true)
    expect(isSafeExternalUrl('  https://host.test/path  ')).toBe(true)
  })

  it('refuses an empty or whitespace authority', () => {
    expect(isSafeExternalUrl('https://')).toBe(false)
    expect(isSafeExternalUrl('https:// x')).toBe(false)
    expect(isSafeExternalUrl('https:///path')).toBe(false)
  })

  it('the scheme must be at the START: an https url smuggled inside another scheme is refused', () => {
    // The `^` anchor is the ONLY thing standing between a smuggled scheme and
    // `window.open` here, because this guard has no `.url()` in front of it —
    // unlike the shared schema, where `.url()` runs first (and, measured, would
    // not have helped either: it accepts all three of these). Without the anchor
    // any string that merely CONTAINS an https URL is opened, payload and all.
    expect(isSafeExternalUrl('javascript:https://evil.test/a')).toBe(false)
    expect(isSafeExternalUrl('data:text/html,https://host.test/a')).toBe(false)
    expect(isSafeExternalUrl('x\nhttps://evil.test/a')).toBe(false)
    const open = vi.fn()
    expect(openOriginalPosting('javascript:https://evil.test/a', open)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('openOriginalPosting does not open a credentialed url', () => {
    const open = vi.fn()
    expect(openOriginalPosting('https://user:pw@example.com/a', open)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})

/**
 * SR-M-2, LAYER 2 — the four classes only `new URL` can see.
 *
 * Every URL below SATISFIES the shape regex: `:443`, `h.test:99999`,
 * `a%40b.test` and `ho\u0001st.test` are all non-empty, `@`-free and
 * whitespace-free as far as a character class can tell. A bare regex has no
 * parser behind it, so before SR-M-2 all four were handed to `window.open`,
 * where `new URL` — not `window.open` itself — threw a SyntaxError INSIDE the
 * click handler. The doc comment promised `false`; the code delivered a throw.
 *
 * Each test states the WHATWG fact as its own assertion rather than trusting the
 * prose: `new URL` throwing is the reason the guard can refuse these at all, and
 * if a future runtime stops throwing, the test says so instead of silently
 * becoming a check of nothing.
 *
 * THESE ARE THE TESTS THAT REDDEN WHEN THE `new URL` BLOCK IS DELETED, and the
 * only ones that do.
 */
describe('isSafeExternalUrl refuses what a shape regex cannot see (layer 2: new URL)', () => {
  it.each([
    ['an empty host carrying a port', 'https://:443/a'],
    ['a port outside the valid range', 'https://h.test:99999/a'],
    ['an @ smuggled into the host percent-encoded', 'https://a%40b.test/'],
    ['a C0 control inside the host', 'https://ho\u0001st.test/a'],
  ])('refuses %s', (_label, url) => {
    // The premise: this string is unparseable, which is WHY the shape check
    // alone could not reject it and why the old code threw instead of returning.
    expect(() => new URL(url)).toThrow()

    expect(isSafeExternalUrl(url)).toBe(false)

    const open = vi.fn()
    expect(openOriginalPosting(url, open)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})

/**
 * SR-M-2, LAYER 1 — the classes only the regex can see.
 *
 * `new URL` is the more thorough parser and is still the WEAKER guard for these:
 * it NORMALISES rather than refuses. It turns a single-slash `https:/host/x` into
 * a valid absolute URL, accepts an empty userinfo outright, and silently strips
 * tab/CR/LF out of a host. So layer 2 does not cover for the regex, and in
 * particular it does not cover for the leading `^` — the operand on which the
 * whole scheme check rests.
 *
 * Each test asserts what `new URL` DOES with the string, so the claim "layer 2
 * would have let this through" is measured here rather than asserted in a
 * comment. THESE ARE THE TESTS THAT REDDEN WHEN THE REGEX IS DELETED.
 */
describe('isSafeExternalUrl refuses what new URL would normalise away (layer 1: the regex)', () => {
  it('refuses a single slash after the scheme, which new URL repairs into a valid URL', () => {
    expect(new URL('https:/host.test/x').href).toBe('https://host.test/x')
    expect(isSafeExternalUrl('https:/host.test/x')).toBe(false)
  })

  it('refuses an empty userinfo, which new URL parses happily', () => {
    const parsed = new URL('https://@host.test/a')
    expect(parsed.host).toBe('host.test')
    expect(parsed.username).toBe('')
    expect(isSafeExternalUrl('https://@host.test/a')).toBe(false)
  })

  it('refuses tab/CR/LF inside the authority, which new URL strips before parsing', () => {
    expect(new URL('https://ho\tst.test/a').href).toBe('https://host.test/a')
    expect(isSafeExternalUrl('https://ho\tst.test/a')).toBe(false)
    expect(isSafeExternalUrl('https://ho\rst.test/a')).toBe(false)
    expect(isSafeExternalUrl('https://ho\nst.test/a')).toBe(false)
  })

  it('refuses tab and NBSP inside the path, which new URL keeps or percent-encodes', () => {
    expect(new URL('https://host.test/a\tb').href).toBe('https://host.test/ab')
    expect(isSafeExternalUrl('https://host.test/a\tb')).toBe(false)
    expect(isSafeExternalUrl('https://host.test/a b')).toBe(false)
  })

  it('refuses a smuggled scheme — the `^` anchor, which new URL cannot help with', () => {
    // `new URL` on 'javascript:https://evil.test/a' does NOT throw: it is a
    // perfectly valid javascript: URL. Only the anchored regex refuses it, and
    // `window.open` on it executes in OUR origin.
    expect(new URL('javascript:https://evil.test/a').protocol).toBe('javascript:')
    expect(isSafeExternalUrl('javascript:https://evil.test/a')).toBe(false)

    const open = vi.fn()
    expect(openOriginalPosting('javascript:https://evil.test/a', open)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})

/**
 * SR-M-2, THE CHECK/USE SKEW — asserted on the ARGUMENT, not the return value.
 *
 * `isSafeExternalUrl` validated `url.trim()`; `openOriginalPosting` then passed
 * the RAW `url` to `window.open`. Both facts were true at once, so the function
 * returned `true` and opened a string nothing had checked. A test asserting the
 * return value cannot see this — `true` was the correct return in every one of
 * these cases. Only `open.mock.calls` can, which is why these read the argument.
 *
 * `window.open`'s own preprocessing strips ONLY C0 controls and space, so a
 * leading U+00A0 / U+FEFF / U+2028 survived into the parser, which then saw no
 * scheme at that offset and resolved the whole thing against the CRM origin — or
 * threw.
 */
describe('openOriginalPosting opens the string it validated, not the raw one (SR-M-2)', () => {
  it.each([
    ['leading U+00A0 (NBSP)', ` ${CANONICAL}`],
    ['leading U+FEFF (BOM)', `﻿${CANONICAL}`],
    ['leading U+2028 (line separator)', ` ${CANONICAL}`],
    ['leading space', ` ${CANONICAL}`],
    ['trailing space', `${CANONICAL} `],
    ['surrounding whitespace', `  ${CANONICAL}\n`],
  ])('%s is trimmed before it reaches open', (_label, raw) => {
    const open = vi.fn()

    expect(openOriginalPosting(raw, open)).toBe(true)
    // THE assertion: the exact string handed to `window.open`.
    expect(open).toHaveBeenCalledWith(CANONICAL, '_blank', 'noopener,noreferrer')
    // And stated as a negative too, so the failure message names the cause: the
    // raw string must not survive into the call at all.
    expect(open.mock.calls[0]?.[0]).not.toBe(raw)
  })

  it('is the SAME string the predicate accepted — validate and use cannot diverge', () => {
    const raw = ` ${CANONICAL}`
    const open = vi.fn()
    openOriginalPosting(raw, open)
    const opened = open.mock.calls[0]?.[0] as string

    // Whatever was opened must itself pass the guard. Under the old code this
    // failed: the opened string was the untrimmed one, which the guard refuses
    // once it is no longer trimmed on the way in.
    expect(isSafeExternalUrl(opened)).toBe(true)
    expect(opened.trim()).toBe(opened)
  })
})

/**
 * POSITIVE CONTROLS — the half that distinguishes "stricter in the right way"
 * from "refuses everything".
 *
 * A hardening that broke every real posting URL would show the same green across
 * every refusal test above. These rows are the shapes the product actually
 * produces: `canonicalizePostingUrl` output with kept params, an `@` in the PATH
 * (an ordinary posting URL, not credentials), a bare host, an explicit port and an
 * upper-case scheme. They assert the URL is OPENED, not merely that the predicate
 * returned true, so a guard that accepted while the opener silently dropped the
 * call would still fail.
 */
describe('openOriginalPosting still opens the URLs the product really produces', () => {
  it.each([
    ['canonical form with kept params', 'https://host.test/path?kept=params'],
    ['an @ in the path', 'https://host.test/a@b'],
    ['an @ in the query', 'https://host.test/jobs?ref=a@b'],
    ['an @ in the fragment', 'https://host.test/jobs#a@b'],
    ['a bare host', 'https://host.test'],
    ['an explicit port', 'https://host.test:8443/a'],
    ['an upper-case scheme and host', 'HTTPS://HOST.TEST/x'],
    ['a real feed URL', 'https://jobs.dou.ua/companies/x/vacancies/123/'],
  ])('opens %s', (_label, url) => {
    const open = vi.fn()

    expect(isSafeExternalUrl(url)).toBe(true)
    expect(openOriginalPosting(url, open)).toBe(true)
    expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer')
  })
})
