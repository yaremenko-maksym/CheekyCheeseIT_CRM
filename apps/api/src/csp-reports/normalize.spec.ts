import { describe, expect, it } from 'vitest'
import {
  normalizeBlockedUri,
  normalizeDocumentPath,
  resolveDirective,
  truncateBytes,
} from './normalize'

describe('truncateBytes', () => {
  it('leaves a short ASCII string unchanged', () => {
    expect(truncateBytes('hello', 500)).toBe('hello')
  })

  it('truncates by UTF-8 BYTES, not UTF-16 code units (security round 1 LOW)', () => {
    // Each 'д' is 2 bytes in UTF-8 but 1 UTF-16 code unit — a naive
    // `.slice(0, 3)` would keep 3 characters (6 bytes); truncateBytes(…, 3)
    // must keep at most 1 full character (2 bytes) since a 2nd would exceed
    // the 3-byte budget without landing on a clean boundary.
    const result = truncateBytes('дддд', 3)
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(3)
    expect(result).toBe('д')
  })

  it('never splits a surrogate pair (emoji) into an invalid half', () => {
    const emoji = '😀' // U+1F600 — 4 bytes UTF-8, a surrogate pair in UTF-16
    const result = truncateBytes(`x${emoji}`, 2) // budget covers 'x' (1 byte) but not the full emoji
    // A byte-boundary cut mid-emoji must not leave a lone surrogate in the JS string.
    expect(result).toBe('x')
    expect([...result]).toHaveLength(1)
  })

  it('returns the input unchanged when already at or under the byte budget', () => {
    const emoji = '😀😀'
    expect(truncateBytes(emoji, Buffer.byteLength(emoji, 'utf8'))).toBe(emoji)
  })
})

describe('normalizeBlockedUri', () => {
  it('strips query/fragment/credentials from an http(s) URL, keeping origin+pathname', () => {
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

  it('non-http(s) schemes store ONLY the scheme, never origin+pathname garbage (MED-1/LOW)', () => {
    // `new URL('javascript:alert(1)').origin` is the literal string 'null'
    // per WHATWG — concatenating with pathname previously produced
    // "nullalert(1)". Storing just the scheme avoids that AND avoids
    // persisting the attacker-controlled inline payload.
    expect(normalizeBlockedUri('javascript:alert(1)')).toBe('javascript:')
    expect(normalizeBlockedUri('data:text/html,<script>evil()</script>')).toBe('data:')
    expect(normalizeBlockedUri('blob:https://evil.example/uuid')).toBe('blob:')
  })

  it('returns a sentinel for an empty/undefined/null value', () => {
    expect(normalizeBlockedUri('')).toBe('(empty)')
    expect(normalizeBlockedUri(undefined)).toBe('(empty)')
    expect(normalizeBlockedUri(null)).toBe('(empty)')
  })

  it('trims whitespace before normalizing', () => {
    expect(normalizeBlockedUri('  https://evil.example/x.js  ')).toBe('https://evil.example/x.js')
  })

  it('truncates an over-long non-URL value to 500 BYTES', () => {
    const long = 'x'.repeat(600)
    expect(Buffer.byteLength(normalizeBlockedUri(long), 'utf8')).toBeLessThanOrEqual(500)
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

describe('resolveDirective — allow-list (security round 1 HIGH-1c)', () => {
  it('prefers effective-directive when it is an allow-listed directive', () => {
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

  it('rejects an arbitrary, non-CSP-directive string (the unlimited-cardinality vector)', () => {
    expect(resolveDirective('not-a-real-directive-' + 'x'.repeat(200), undefined)).toBeNull()
  })

  it('rejects a directive value containing embedded control characters', () => {
    expect(resolveDirective('script-src\n\r evil', undefined)).toBeNull()
  })

  it('accepts every directive in the allow-list (spot-check a representative sample)', () => {
    for (const directive of [
      'default-src',
      'style-src-elem',
      'frame-ancestors',
      'base-uri',
      'form-action',
      'upgrade-insecure-requests',
      'report-to',
    ]) {
      expect(resolveDirective(directive, undefined)).toBe(directive)
    }
  })
})
