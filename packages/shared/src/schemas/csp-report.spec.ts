import { describe, expect, it } from 'vitest'
import { cspReportToBodySchema, cspReportUriBodySchema, cspViolationItemSchema } from './csp-report'

describe('cspReportUriBodySchema (application/csp-report)', () => {
  it('accepts a real Chrome-shaped csp-report payload', () => {
    const result = cspReportUriBodySchema.safeParse({
      'csp-report': {
        'document-uri': 'https://app.cheekycheese.tech/team?foo=bar',
        referrer: '',
        'violated-directive': "script-src 'self'",
        'effective-directive': 'script-src',
        'original-policy': "default-src 'self'; script-src 'self'",
        disposition: 'report',
        'blocked-uri': 'https://evil.example/x.js',
        'status-code': 200,
      },
    })
    expect(result.success).toBe(true)
  })

  it('strips unknown top-level keys instead of rejecting', () => {
    const result = cspReportUriBodySchema.parse({
      'csp-report': { 'effective-directive': 'script-src' },
      unexpected: 'field',
    })
    expect(result).not.toHaveProperty('unexpected')
  })

  it('accepts a completely empty object (no csp-report key) — garbage, not a hard reject', () => {
    const result = cspReportUriBodySchema.safeParse({})
    expect(result.success).toBe(true)
    expect(result.success && result.data['csp-report']).toBeUndefined()
  })

  it('rejects a non-object body (e.g. a bare string)', () => {
    const result = cspReportUriBodySchema.safeParse('garbage')
    expect(result.success).toBe(false)
  })

  it('rejects an invalid disposition value', () => {
    const result = cspReportUriBodySchema.safeParse({
      'csp-report': { disposition: 'wat' },
    })
    expect(result.success).toBe(false)
  })
})

describe('cspReportToBodySchema (application/reports+json)', () => {
  it('accepts a real Reporting-API-shaped batch', () => {
    const result = cspReportToBodySchema.safeParse([
      {
        age: 53531,
        type: 'csp-violation',
        url: 'https://app.cheekycheese.tech/team',
        user_agent: 'Mozilla/5.0',
        body: {
          blockedURL: 'https://evil.example/x.js',
          disposition: 'enforce',
          documentURL: 'https://app.cheekycheese.tech/team?foo=bar',
          effectiveDirective: 'script-src',
        },
      },
    ])
    expect(result.success).toBe(true)
  })

  it('accepts non-csp-violation report types (filtering happens at the controller)', () => {
    const result = cspReportToBodySchema.safeParse([{ type: 'deprecation', body: {} }])
    expect(result.success).toBe(true)
  })

  it('accepts a batch of up to 10 entries (security round 1 HIGH-1e)', () => {
    const items = Array.from({ length: 10 }, () => ({ type: 'csp-violation' }))
    const result = cspReportToBodySchema.safeParse(items)
    expect(result.success).toBe(true)
  })

  it('rejects a batch over 10 entries', () => {
    const items = Array.from({ length: 11 }, () => ({ type: 'csp-violation' }))
    const result = cspReportToBodySchema.safeParse(items)
    expect(result.success).toBe(false)
  })

  it('rejects a non-array body (e.g. the csp-report object shape sent to the wrong endpoint variant)', () => {
    const result = cspReportToBodySchema.safeParse({ 'csp-report': {} })
    expect(result.success).toBe(false)
  })

  it('accepts an empty array', () => {
    const result = cspReportToBodySchema.safeParse([])
    expect(result.success).toBe(true)
  })
})

describe('cspViolationItemSchema (digest item)', () => {
  it('accepts a well-formed aggregate row', () => {
    const result = cspViolationItemSchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      effectiveDirective: 'script-src',
      blockedUri: 'https://evil.example',
      documentPath: '/team',
      disposition: 'report',
      userAgent: 'Mozilla/5.0',
      count: 3,
      firstSeen: '2026-07-26T00:00:00.000Z',
      lastSeen: '2026-07-26T01:00:00.000Z',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a null userAgent', () => {
    const result = cspViolationItemSchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      effectiveDirective: 'script-src',
      blockedUri: '(empty)',
      documentPath: '/team',
      disposition: 'enforce',
      userAgent: null,
      count: 1,
      firstSeen: '2026-07-26T00:00:00.000Z',
      lastSeen: '2026-07-26T00:00:00.000Z',
    })
    expect(result.success).toBe(true)
  })
})
