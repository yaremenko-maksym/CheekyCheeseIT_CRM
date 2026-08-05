import { describe, expect, it } from 'vitest'
import { cn, normalizeDecimalInput, parseStrictAmount } from './utils'

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

  it('a longer repeated-separator chain behaves the same way — confirmed deliberate, not a side effect (review round 3)', () => {
    // Not a money-realistic input (nobody types a rate/amount like this),
    // but the review explicitly asked to confirm this wasn't an accidental
    // side effect of the round-3 ambiguity fix: "12.34.56" has TWO dots,
    // each followed by only 2 digits — it does not match the "exactly
    // three digits after a SINGLE separator" ambiguous-thousands shape at
    // all (that shape requires exactly one separator type appearing with
    // proper 3-digit grouping), so it still falls through to the ordinary
    // first-wins rule, same as "1.2.3" above.
    expect(normalizeDecimalInput('12.34.56')).toBe('12.3456')
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

  // review round 3 (PR #481) — a SINGLE separator, shaped like a properly
  // thousands-grouped integer with NO fractional part, is genuinely
  // ambiguous: "1,000" is either one thousand (US convention) or 1.000 = 1
  // (this app's own ru/uk decimal convention) — a 1000x spread, and nobody
  // hand-types money to three decimal places, so there is no safe default.
  // The round-2 fix already closed the MIXED-separator case; this closes
  // the single-separator one it missed. Each case is pinned by name per the
  // review's explicit request — a function run by hand against these exact
  // strings is what caught the round-2 regression, so it's what verifies
  // the fix too.
  describe('single separator, thousands-only shape ("1,000") — genuinely ambiguous, left UNCHANGED', () => {
    it('"1,000" is NOT resolved to 1 (comma-as-decimal) or guessed as 1000 (comma-as-thousands) — returned as-is', () => {
      expect(normalizeDecimalInput('1,000')).toBe('1,000')
      expect(normalizeDecimalInput('1,000')).not.toBe('1.000')
      expect(normalizeDecimalInput('1,000')).not.toBe('1000')
    })

    it('same ambiguity with a dot separator: "12.000"', () => {
      expect(normalizeDecimalInput('12.000')).toBe('12.000')
    })

    it('multiple thousands groups, still no fractional part: "1,000,000"', () => {
      expect(normalizeDecimalInput('1,000,000')).toBe('1,000,000')
    })

    it('a pasted currency symbol does not change the ambiguity verdict: "$1,000"', () => {
      expect(normalizeDecimalInput('$1,000')).toBe('$1,000')
    })

    it('crypto-precision edge case: "0,001" is ALSO ambiguous (thousands-shaped "1" vs 3 decimal places) — not resolved either way', () => {
      expect(normalizeDecimalInput('0,001')).toBe('0,001')
    })

    it('a 4-digit tail is NOT the ambiguous shape (not real thousands grouping) — resolves as decimal, unchanged pre-existing rule', () => {
      expect(normalizeDecimalInput('1,0005')).toBe('1.0005')
    })

    it('a 2-digit tail is NOT the ambiguous shape — resolves as decimal (matches the pre-existing $12.50 case)', () => {
      expect(normalizeDecimalInput('1,00')).toBe('1.00')
    })

    it('the unresolved ambiguous string fails strict numeric parsing — the point of leaving it unchanged', () => {
      expect(Number.isNaN(Number(normalizeDecimalInput('1,000')))).toBe(true)
    })
  })
})

describe('parseStrictAmount — task-mobile-keyboards.md review round 3', () => {
  // `parseFloat` truncates at the first invalid character instead of
  // failing — `parseFloat("1,000") === 1`, NOT NaN. That silently defeats
  // `normalizeDecimalInput` leaving an ambiguous amount unresolved: every
  // caller that fed the ambiguous string straight into `parseFloat` would
  // still submit the wrong number. This is the strict replacement pinned
  // against exactly that leak.
  it('rejects an unresolved ambiguous thousands-grouped string that parseFloat would truncate to a wrong number', () => {
    expect(Number.isNaN(parseStrictAmount('1,000'))).toBe(true)
    expect(parseFloat('1,000')).toBe(1) // documents the leak this replaces
  })

  it('accepts a clean, fully-normalized decimal amount', () => {
    expect(parseStrictAmount('1000.50')).toBe(1000.5)
    expect(parseStrictAmount('1000')).toBe(1000)
  })

  it('rejects garbage that happens to start with digits', () => {
    expect(Number.isNaN(parseStrictAmount('12abc'))).toBe(true)
  })

  it('rejects an empty string', () => {
    expect(Number.isNaN(parseStrictAmount(''))).toBe(true)
  })
})
