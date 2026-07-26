import { describe, expect, it } from 'vitest'
import { normalizeBlockedUri, normalizeDocumentPath, resolveDirective } from './normalize'

describe('normalizeBlockedUri', () => {
  it('strips query/fragment/credentials from an absolute URL, keeping origin+pathname', () => {
    expect(normalizeBlockedUri('https://evil.example/x.js?foo=bar#frag')).toBe(
      'https://evil.example/x.js',
    )
  })

  it('strips credentials embedded in the URL', () => {
    expect(normalizeBlockedUri('https://user:pass@evil.example/x.js')).toBe(
      'https://evil.example/x.js',
    )
  })

  it('passes CSP special keywords through as-is (not a URL)', () => {
    expect(normalizeBlockedUri('inline')).toBe('inline')
    expect(normalizeBlockedUri('eval')).toBe('eval')
  })

  it('returns a sentinel for an empty/undefined/null value', () => {
    expect(normalizeBlockedUri('')).toBe('(empty)')
    expect(normalizeBlockedUri(undefined)).toBe('(empty)')
    expect(normalizeBlockedUri(null)).toBe('(empty)')
  })

  it('trims whitespace before normalizing', () => {
    expect(normalizeBlockedUri('  https://evil.example/x.js  ')).toBe('https://evil.example/x.js')
  })

  it('truncates an over-long non-URL value to 500 chars', () => {
    const long = 'x'.repeat(600)
    expect(normalizeBlockedUri(long)).toHaveLength(500)
  })
})

describe('normalizeDocumentPath', () => {
  it('extracts pathname only from an absolute URL (origin + query + fragment stripped)', () => {
    expect(normalizeDocumentPath('https://app.cheekycheese.tech/team?foo=bar#section')).toBe(
      '/team',
    )
  })

  it('falls back to manual query/hash stripping for a bare path (not an absolute URL)', () => {
    expect(normalizeDocumentPath('/team?foo=bar#section')).toBe('/team')
  })

  it('returns "/" for an absolute URL with no path segment', () => {
    expect(normalizeDocumentPath('https://app.cheekycheese.tech')).toBe('/')
  })

  it('returns a sentinel for an empty/undefined/null value', () => {
    expect(normalizeDocumentPath('')).toBe('(unknown)')
    expect(normalizeDocumentPath(undefined)).toBe('(unknown)')
    expect(normalizeDocumentPath(null)).toBe('(unknown)')
  })

  it('two violations differing ONLY by query string normalize to the SAME document path (aggregation)', () => {
    const a = normalizeDocumentPath('https://app.cheekycheese.tech/team?code=abc&state=xyz')
    const b = normalizeDocumentPath('https://app.cheekycheese.tech/team?other=1')
    expect(a).toBe(b)
    expect(a).toBe('/team')
  })
})

describe('resolveDirective', () => {
  it('prefers effective-directive when present', () => {
    expect(resolveDirective('script-src', "script-src 'self'")).toBe('script-src')
  })

  it('falls back to the first token of violated-directive when effective-directive is missing', () => {
    expect(resolveDirective(undefined, "script-src 'self' 'unsafe-inline'")).toBe('script-src')
  })

  it('falls back to violated-directive when effective-directive is an empty string', () => {
    expect(resolveDirective('', 'style-src')).toBe('style-src')
  })

  it('returns null when both are missing', () => {
    expect(resolveDirective(undefined, undefined)).toBeNull()
    expect(resolveDirective(null, null)).toBeNull()
  })

  it('returns null when both are empty/whitespace-only', () => {
    expect(resolveDirective('  ', '   ')).toBeNull()
  })

  it('truncates an over-long directive to 100 chars', () => {
    const long = 'script-src-' + 'x'.repeat(200)
    expect(resolveDirective(long, undefined)).toHaveLength(100)
  })
})
