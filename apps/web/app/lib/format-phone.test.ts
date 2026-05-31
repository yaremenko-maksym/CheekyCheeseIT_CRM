import { describe, it, expect } from 'vitest'
import { hasRealPhone } from './format-phone'

describe('hasRealPhone', () => {
  it('returns false for nullish / empty values', () => {
    expect(hasRealPhone(null)).toBe(false)
    expect(hasRealPhone(undefined)).toBe(false)
    expect(hasRealPhone('')).toBe(false)
    expect(hasRealPhone('   ')).toBe(false)
  })

  it('returns false for bare calling codes', () => {
    expect(hasRealPhone('+')).toBe(false)
    expect(hasRealPhone('+380')).toBe(false)
    expect(hasRealPhone('+1')).toBe(false)
    expect(hasRealPhone('+44')).toBe(false)
    expect(hasRealPhone('+49')).toBe(false)
  })

  it('returns false for inputs with fewer than 6 digits total', () => {
    expect(hasRealPhone('+38012')).toBe(false)
    expect(hasRealPhone('123')).toBe(false)
  })

  it('returns true for real Ukrainian phone numbers', () => {
    expect(hasRealPhone('+380501234567')).toBe(true)
    expect(hasRealPhone('+380 50 123 45 67')).toBe(true)
    expect(hasRealPhone('+380-50-123-45-67')).toBe(true)
  })

  it('returns true for international numbers', () => {
    expect(hasRealPhone('+12025551234')).toBe(true)
    expect(hasRealPhone('+447400123456')).toBe(true)
  })
})
