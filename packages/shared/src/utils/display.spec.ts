import { describe, it, expect } from 'vitest'
import { getInitials, formatRole, formatAmount } from './display'

describe('getInitials', () => {
  it('returns two initials for a full name', () => {
    expect(getInitials('John Doe')).toBe('JD')
  })

  it('returns one initial for a single-word name', () => {
    expect(getInitials('Maksym')).toBe('M')
  })

  it('takes only the first two words', () => {
    expect(getInitials('Anna Maria Petrova')).toBe('AM')
  })

  it('handles extra whitespace', () => {
    expect(getInitials('  Ivan   Ivanov  ')).toBe('II')
  })

  it('returns empty string for empty input', () => {
    expect(getInitials('')).toBe('')
  })

  it('uppercases initials', () => {
    expect(getInitials('alice bob')).toBe('AB')
  })
})

describe('formatRole', () => {
  it('formats each role correctly', () => {
    expect(formatRole('ADMIN')).toBe('Admin')
    expect(formatRole('SENIOR')).toBe('Senior')
    expect(formatRole('JUNIOR')).toBe('Junior')
    expect(formatRole('HR')).toBe('HR')
    expect(formatRole('ACCOUNTANT')).toBe('Accountant')
  })
})

describe('formatAmount', () => {
  it('prefixes fiat symbol for USD', () => {
    expect(formatAmount(1000, 'USD')).toBe('$1,000.00')
  })

  it('prefixes fiat symbol for EUR', () => {
    expect(formatAmount(500.5, 'EUR')).toBe('€500.50')
  })

  it('suffixes currency code for USDT', () => {
    expect(formatAmount(2500, 'USDT')).toBe('2,500.00 USDT')
  })

  it('formats zero correctly', () => {
    expect(formatAmount(0, 'USD')).toBe('$0.00')
  })

  it('falls back to currency code for unknown currency', () => {
    expect(formatAmount(100, 'BTC')).toBe('100.00 BTC')
  })
})
