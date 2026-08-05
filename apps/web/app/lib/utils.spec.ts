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

  it('single separator TYPE (even repeated): the FIRST occurrence is the decimal point', () => {
    // ru/uk primary locale — a lone `,` is always a decimal separator here,
    // never a thousands group, so "first wins" is the correct default, not
    // an arbitrary one. Repeated occurrences of the SAME symbol are a user
    // fat-fingering the separator key, not a thousands group (a real
    // thousands group never repeats the grouping symbol twice in a row
    // without digits between distinct groups the way `1,2,3` would parse if
    // taken literally — this is the pre-existing pinned behavior).
    expect(normalizeDecimalInput('1,2,3')).toBe('1.23')
    expect(normalizeDecimalInput('1.2.3')).toBe('1.23')
  })

  it('handles a bare integer with no separator', () => {
    expect(normalizeDecimalInput('1500')).toBe('1500')
  })

  it('handles an empty string', () => {
    expect(normalizeDecimalInput('')).toBe('')
  })

  // review round 2 (PR #481) — BOTH separators present. Position resolves
  // it unambiguously regardless of which locale produced the string:
  // thousands grouping always precedes the decimal point. Treating the
  // FIRST symbol as decimal (the single-separator rule) silently misreads
  // "1,000.50" as "1.00050" — ~1000x off, with no error raised anywhere
  // downstream (every consumer is `z.number()` + `parseFloat`/`Number()`,
  // and 1.00050 is a perfectly valid positive number to every one of them).
  describe('mixed separators — US "1,000.50" and EU "1.000,50" thousands+decimal', () => {
    it('US style: comma thousands, dot decimal', () => {
      expect(normalizeDecimalInput('1,000.50')).toBe('1000.50')
      expect(normalizeDecimalInput('1,000.50')).not.toBe('1.00050')
    })

    it('EU style: dot thousands, comma decimal', () => {
      expect(normalizeDecimalInput('1.000,50')).toBe('1000.50')
      expect(normalizeDecimalInput('1.000,50')).not.toBe('1.00050')
    })

    it('multiple thousands groups: "1,000,000.50"', () => {
      expect(normalizeDecimalInput('1,000,000.50')).toBe('1000000.50')
    })

    it('pasted with a currency symbol and mixed separators still resolves correctly', () => {
      expect(normalizeDecimalInput('$1,234.56')).toBe('1234.56')
    })
  })
})
