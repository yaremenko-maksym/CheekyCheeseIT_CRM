import { describe, expect, it, vi } from 'vitest'
import { isSafeExternalUrl, openOriginalPosting } from '../open-original'

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
