import { describe, expect, it } from 'vitest'
import { sanitizeAndTruncate, sanitizeNullable, sanitizeText } from './sanitize'

describe('sanitizeText', () => {
  it('redacts a Bearer token', () => {
    const result = sanitizeText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def')
    expect(result).toBe('Authorization: [redacted]')
    expect(result).not.toContain('eyJ')
  })

  it('redacts a cookie header value', () => {
    const result = sanitizeText('Cookie: jwt=abc123; session=xyz789; other=1')
    expect(result).not.toContain('abc123')
    expect(result).toContain('[redacted]')
  })

  it('sec MED (review round 1): redacts EVERY pair in a multi-section Cookie header, not just up to the first ";"', () => {
    // Browsers always send every cookie on ONE `Cookie:` line, `; `-joined —
    // a real JWT session cookie is very likely to land AFTER the first `;`.
    const result = sanitizeText(
      'Cookie: jwt=eyJhbGciOiJIUzI1NiJ9.payload.sig; sessionid=s3cr3t; other=1',
    )
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(result).not.toContain('sessionid')
    expect(result).not.toContain('s3cr3t')
    expect(result).not.toContain(';')
  })

  it('sec MED: a multi-line message only redacts the Cookie line, not the following unrelated line', () => {
    const input = 'Cookie: jwt=secretvalue; sessionid=abc\nUnrelated next line stays intact'
    const result = sanitizeText(input)
    expect(result).not.toContain('secretvalue')
    expect(result).not.toContain('sessionid')
    expect(result).toContain('Unrelated next line stays intact')
  })

  it('redacts a password field (and its "password" keyword) in several notations', () => {
    expect(sanitizeText('password="hunter2"')).toBe('[redacted]')
    expect(sanitizeText("password='hunter2'")).toBe('[redacted]')
    expect(sanitizeText('password=hunter2')).toBe('[redacted]')
    expect(sanitizeText('password: hunter2')).toBe('[redacted]')
  })

  it('is case-insensitive', () => {
    expect(sanitizeText('BEARER abc123')).toBe('[redacted]')
    expect(sanitizeText('COOKIE: a=b')).toContain('[redacted]')
  })

  it('leaves ordinary error text untouched', () => {
    const message = "TypeError: Cannot read properties of undefined (reading 'id')"
    expect(sanitizeText(message)).toBe(message)
  })

  it('redacts multiple occurrences in the same string', () => {
    const result = sanitizeText('Bearer tok1 ... Bearer tok2')
    expect(result).toBe('[redacted] ... [redacted]')
  })
})

describe('sanitizeNullable', () => {
  it('passes null through', () => {
    expect(sanitizeNullable(null)).toBeNull()
  })

  it('passes undefined through', () => {
    expect(sanitizeNullable(undefined)).toBeUndefined()
  })

  it('sanitizes a real string', () => {
    expect(sanitizeNullable('Bearer secret')).toBe('[redacted]')
  })
})

describe('sanitizeAndTruncate', () => {
  it('truncates after sanitizing so a secret straddling the boundary is still redacted', () => {
    const input = `${'x'.repeat(10)}Bearer supersecrettoken`
    const result = sanitizeAndTruncate(input, 15)
    expect(result).not.toContain('supersecrettoken')
    expect(result.length).toBeLessThanOrEqual(15)
  })

  it('does not truncate a string shorter than maxLength', () => {
    expect(sanitizeAndTruncate('short message', 500)).toBe('short message')
  })

  it('truncates a long, non-sensitive string to exactly maxLength', () => {
    const result = sanitizeAndTruncate('x'.repeat(600), 500)
    expect(result.length).toBe(500)
  })
})
