/**
 * `client.tsx`'s pre-router URL normalization — see
 * app/lib/normalize-pathname.ts's module doc for the confirmed real CI
 * failure this closes (Lighthouse CI addresses prerendered pages by their
 * literal `/index.html` file path, which `trailingSlash: 'always'` matches
 * against no route, rendering a `noindex` 404 over otherwise-correct
 * content).
 */
import { describe, expect, it } from 'vitest'
import { normalizeIndexHtmlUrl } from '@/lib/normalize-pathname'

describe('normalizeIndexHtmlUrl', () => {
  it('normalizes the root file path to the pretty root URL', () => {
    expect(normalizeIndexHtmlUrl('/index.html', '', '')).toBe('/')
  })

  it('normalizes a nested file path to its trailing-slash pretty form', () => {
    expect(normalizeIndexHtmlUrl('/careers/index.html', '', '')).toBe('/careers/')
  })

  it('normalizes a deeply nested (vacancy detail) file path', () => {
    expect(normalizeIndexHtmlUrl('/careers/senior-ml-engineer/index.html', '', '')).toBe(
      '/careers/senior-ml-engineer/',
    )
  })

  it('preserves search params and hash across normalization', () => {
    expect(normalizeIndexHtmlUrl('/careers/index.html', '?utm_source=x', '#apply')).toBe(
      '/careers/?utm_source=x#apply',
    )
  })

  it('returns null for an already-pretty pathname (no-op, no history churn)', () => {
    expect(normalizeIndexHtmlUrl('/', '', '')).toBeNull()
    expect(normalizeIndexHtmlUrl('/careers/', '', '')).toBeNull()
    expect(normalizeIndexHtmlUrl('/careers/senior-ml-engineer/', '', '')).toBeNull()
  })

  it('leaves 404.html untouched — it is not a route-owned "/index.html" and its noindex is intentional', () => {
    expect(normalizeIndexHtmlUrl('/404.html', '', '')).toBeNull()
  })

  it('does not false-positive on a path ending in "index.html" without the leading slash boundary', () => {
    // e.g. a (contrived) slug like "my-index.html" — the char immediately
    // before "index.html" is "-", not "/", so this is NOT the SSG
    // per-directory index file this function targets.
    expect(normalizeIndexHtmlUrl('/careers/my-index.html', '', '')).toBeNull()
  })
})
