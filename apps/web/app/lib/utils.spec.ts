import { describe, expect, it } from 'vitest'
import { cn, normalizeDecimalInput } from './utils'

describe('cn', () => {
  it('merges class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar')
  })

  it('deduplicates conflicting tailwind classes (last wins)', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4')
  })

  it('handles conditional classes', () => {
    expect(cn('base', false && 'skipped', 'added')).toBe('base added')
  })

  it('handles undefined and null gracefully', () => {
    expect(cn(undefined, null, 'valid')).toBe('valid')
  })

  it('handles empty input', () => {
    expect(cn()).toBe('')
  })
})

describe('normalizeDecimalInput — task-mobile-keyboards.md AC2', () => {
  // The whole point: comma is the natural decimal separator on ru/uk
  // keyboards. `type="number"` used to either strip it (1,5 -> 15, a 10x
  // error) or blank the field entirely — both silent. This must never
  // happen again, so these three cases are pinned individually.
  it('a comma decimal is preserved as a dot decimal, not stripped to an integer', () => {
    expect(normalizeDecimalInput('1,5')).toBe('1.5')
    expect(normalizeDecimalInput('1,5')).not.toBe('15')
  })

  it('a comma decimal never collapses to an empty string', () => {
    expect(normalizeDecimalInput('1,5')).not.toBe('')
  })

  it('a dot decimal keeps working exactly as before', () => {
    expect(normalizeDecimalInput('1.5')).toBe('1.5')
  })

  it('strips stray non-digit characters (e.g. a pasted currency symbol)', () => {
    expect(normalizeDecimalInput('$12.50')).toBe('12.50')
  })

  it('keeps only the first separator typed (matches real decimal-input behavior)', () => {
    expect(normalizeDecimalInput('1,2,3')).toBe('1.23')
    expect(normalizeDecimalInput('1.2.3')).toBe('1.23')
  })

  it('handles a bare integer with no separator', () => {
    expect(normalizeDecimalInput('1500')).toBe('1500')
  })

  it('handles an empty string', () => {
    expect(normalizeDecimalInput('')).toBe('')
  })
})
