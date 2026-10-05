import { describe, expect, it } from 'vitest'
import { getInitialsBySpaceSplit } from './initials'

describe('getInitialsBySpaceSplit', () => {
  it('takes first letters of the first two words, upper-cased', () => {
    expect(getInitialsBySpaceSplit('john smith')).toBe('JS')
  })

  it('caps at two characters for three or more words', () => {
    expect(getInitialsBySpaceSplit('Anna Maria Lopez')).toBe('AM')
  })

  it('single word yields one letter', () => {
    expect(getInitialsBySpaceSplit('Madonna')).toBe('M')
  })

  it('empty string falls back to "?"', () => {
    expect(getInitialsBySpaceSplit('')).toBe('?')
  })

  it('null and undefined fall back to "?"', () => {
    expect(getInitialsBySpaceSplit(null)).toBe('?')
    expect(getInitialsBySpaceSplit(undefined)).toBe('?')
  })

  it('leading space contributes nothing (empty token)', () => {
    expect(getInitialsBySpaceSplit(' John')).toBe('J')
  })

  it('double space between words still yields both initials', () => {
    expect(getInitialsBySpaceSplit('John  Smith')).toBe('JS')
  })

  it('handles Cyrillic', () => {
    expect(getInitialsBySpaceSplit('иван петров')).toBe('ИП')
  })
})
