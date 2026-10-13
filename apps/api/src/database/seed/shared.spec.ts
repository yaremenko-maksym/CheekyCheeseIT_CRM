import { describe, expect, it } from 'vitest'
import { d } from './shared'

describe('seed date helper d()', () => {
  it('builds a UTC date at 10:00 by default', () => {
    expect(d(2025, 6, 5).toISOString()).toBe('2025-06-05T10:00:00.000Z')
  })

  it('treats the month argument as 1-based', () => {
    expect(d(2026, 1, 31).toISOString()).toBe('2026-01-31T10:00:00.000Z')
    expect(d(2026, 12, 1).toISOString()).toBe('2026-12-01T10:00:00.000Z')
  })

  it('honours an explicit hour', () => {
    expect(d(2025, 11, 15, 7).toISOString()).toBe('2025-11-15T07:00:00.000Z')
  })

  it('always zeroes minutes and seconds', () => {
    const date = d(2025, 9, 1, 23)
    expect(date.getUTCMinutes()).toBe(0)
    expect(date.getUTCSeconds()).toBe(0)
    expect(date.getUTCMilliseconds()).toBe(0)
  })
})
