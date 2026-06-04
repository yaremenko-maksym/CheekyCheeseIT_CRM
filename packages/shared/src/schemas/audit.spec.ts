import { describe, expect, it } from 'vitest'
import { auditAllQuerySchema } from './audit'

// ---------------------------------------------------------------------------
// auditAllQuerySchema — date validation (security hardening PR4)
// ---------------------------------------------------------------------------

describe('auditAllQuerySchema — date validation', () => {
  it('accepts valid ISO 8601 UTC datetime for from/to', () => {
    expect(() =>
      auditAllQuerySchema.parse({ from: '2026-06-04T07:00:00Z', to: '2026-06-04T23:59:59Z' }),
    ).not.toThrow()
  })

  it('accepts ISO 8601 datetime with timezone offset', () => {
    expect(() =>
      auditAllQuerySchema.parse({ from: '2026-06-04T09:00:00+02:00' }),
    ).not.toThrow()
  })

  it('rejects garbage string for from — returns ZodError (400, not 500)', () => {
    expect(() => auditAllQuerySchema.parse({ from: 'garbage' })).toThrow()
  })

  it('rejects garbage string for to', () => {
    expect(() => auditAllQuerySchema.parse({ to: 'not-a-date' })).toThrow()
  })

  it('rejects plain date string without time component', () => {
    // "2026-06-04" is not a datetime — must include time
    expect(() => auditAllQuerySchema.parse({ from: '2026-06-04' })).toThrow()
  })

  it('rejects SQL injection attempt in from', () => {
    expect(() =>
      auditAllQuerySchema.parse({ from: "2026-01-01'; DROP TABLE users; --" }),
    ).toThrow()
  })

  it('accepts omitted from/to (both optional)', () => {
    expect(() => auditAllQuerySchema.parse({ limit: 10, offset: 0 })).not.toThrow()
  })

  it('applies default limit=50 and offset=0 when omitted', () => {
    const result = auditAllQuerySchema.parse({})
    expect(result.limit).toBe(50)
    expect(result.offset).toBe(0)
  })

  it('rejects limit > 200', () => {
    expect(() => auditAllQuerySchema.parse({ limit: 201 })).toThrow()
  })

  it('accepts all valid optional fields together', () => {
    expect(() =>
      auditAllQuerySchema.parse({
        userId: '123e4567-e89b-12d3-a456-426614174000',
        from: '2026-01-01T00:00:00Z',
        to: '2026-12-31T23:59:59Z',
        type: 'contract',
        limit: 100,
        offset: 50,
      }),
    ).not.toThrow()
  })
})
