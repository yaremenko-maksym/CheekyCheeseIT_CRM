import { describe, expect, it } from 'vitest'
import { csvEscape } from './csv'

// ---------------------------------------------------------------------------
// csvEscape — CSV injection mitigation + RFC 4180 quoting (security PR4)
// ---------------------------------------------------------------------------

describe('csvEscape — CSV injection mitigation', () => {
  // Use values without embedded " or , so RFC-4180 quoting doesn't interfere,
  // isolating the injection-prefix behavior.

  it('prefixes values starting with = (formula injection)', () => {
    expect(csvEscape('=HYPERLINK(evil.example.com)')).toBe("'=HYPERLINK(evil.example.com)")
  })

  it('prefixes values starting with +', () => {
    expect(csvEscape('+dangerous')).toBe("'+dangerous")
  })

  it('prefixes values starting with -', () => {
    expect(csvEscape('-dangerous')).toBe("'-dangerous")
  })

  it('prefixes values starting with @', () => {
    expect(csvEscape('@SUM(1+1)')).toBe("'@SUM(1+1)")
  })

  it('prefixes values starting with tab (0x09)', () => {
    expect(csvEscape('\tdangerous')).toBe("'\tdangerous")
  })

  it('prefixes values starting with carriage return (0x0D)', () => {
    expect(csvEscape('\rdangerous')).toBe("'\rdangerous")
  })
})

describe('csvEscape — RFC 4180 quoting', () => {
  it('wraps value containing comma in double-quotes', () => {
    expect(csvEscape('Контракт, підписаний')).toBe('"Контракт, підписаний"')
  })

  it('escapes internal double-quotes by doubling', () => {
    expect(csvEscape('She said "hello"')).toBe('"She said ""hello"""')
  })

  it('wraps value containing newline in double-quotes', () => {
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"')
  })

  it('returns plain value unchanged when no special chars', () => {
    expect(csvEscape('CHK-1-2026')).toBe('CHK-1-2026')
  })
})
