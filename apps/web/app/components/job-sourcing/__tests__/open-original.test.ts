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
