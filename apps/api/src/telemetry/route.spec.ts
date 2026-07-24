import { describe, expect, it } from 'vitest'
import { toPathname } from './route'

describe('toPathname', () => {
  it('strips a query string carrying an OAuth code/state (HIGH security fix)', () => {
    expect(toPathname('/auth/google/callback?code=secret&state=x')).toBe('/auth/google/callback')
  })

  it('strips a hash fragment', () => {
    expect(toPathname('/finance#section-2')).toBe('/finance')
  })

  it('strips both a query string and a hash fragment (query first, then hash)', () => {
    expect(toPathname('/finance?tab=history#row-3')).toBe('/finance')
  })

  it('leaves a plain path untouched', () => {
    expect(toPathname('/api/telemetry/digest')).toBe('/api/telemetry/digest')
  })

  it('handles the full request.url shape (as seen by TelemetryExceptionFilter)', () => {
    expect(toPathname('/api/finance/transactions?filter=pending&sort=desc')).toBe(
      '/api/finance/transactions',
    )
  })

  it('returns an empty string for an empty input', () => {
    expect(toPathname('')).toBe('')
  })

  it('returns an empty string for a bare query string with no path', () => {
    expect(toPathname('?code=secret')).toBe('')
  })
})
