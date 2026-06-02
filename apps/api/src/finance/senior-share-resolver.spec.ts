import { describe, it, expect } from 'vitest'
import { resolveSeniorShare } from './senior-share-resolver'

/**
 * Unit tests for the senior-share resolver. The hierarchy is:
 *   project override > team override > user default.
 *
 * Multi-team override situations intentionally fall through to the user
 * default — see the resolver implementation for the rationale ("ambiguous
 * configuration → safe default"). These tests freeze that contract.
 */
describe('resolveSeniorShare', () => {
  // ── Project override branch ─────────────────────────────────────────────
  it('returns project override when set, even if team override exists', () => {
    const result = resolveSeniorShare(
      { seniorSharePercentOverride: 40 },
      { seniorSharePercent: 26 },
      [{ seniorSharePercentOverride: 18 }],
    )
    expect(result.value).toBe(40)
    expect(result.source).toBe('PROJECT')
  })

  it('returns project override when set, with no teams provided', () => {
    const result = resolveSeniorShare(
      { seniorSharePercentOverride: 32 },
      { seniorSharePercent: 26 },
      [],
    )
    expect(result.value).toBe(32)
    expect(result.source).toBe('PROJECT')
  })

  it('accepts 0 as a valid project override (not coerced to null)', () => {
    const result = resolveSeniorShare(
      { seniorSharePercentOverride: 0 },
      { seniorSharePercent: 26 },
      [{ seniorSharePercentOverride: 18 }],
    )
    expect(result.value).toBe(0)
    expect(result.source).toBe('PROJECT')
  })

  // ── Team override branch ────────────────────────────────────────────────
  it('returns team override when project override is null', () => {
    const result = resolveSeniorShare(
      { seniorSharePercentOverride: null },
      { seniorSharePercent: 26 },
      [{ seniorSharePercentOverride: 16 }],
    )
    expect(result.value).toBe(16)
    expect(result.source).toBe('TEAM')
  })

  it('returns team override when project override is undefined', () => {
    const result = resolveSeniorShare(
      { seniorSharePercentOverride: undefined },
      { seniorSharePercent: 26 },
      [{ seniorSharePercentOverride: 22 }],
    )
    expect(result.value).toBe(22)
    expect(result.source).toBe('TEAM')
  })

  it('skips team override when the only team row has null override', () => {
    const result = resolveSeniorShare(
      { seniorSharePercentOverride: null },
      { seniorSharePercent: 26 },
      [{ seniorSharePercentOverride: null }],
    )
    expect(result.value).toBe(26)
    expect(result.source).toBe('USER_DEFAULT')
  })

  // ── Multi-team ambiguity ────────────────────────────────────────────────
  it('falls back to USER_DEFAULT when two teams both carry an override', () => {
    const result = resolveSeniorShare(
      { seniorSharePercentOverride: null },
      { seniorSharePercent: 26 },
      [{ seniorSharePercentOverride: 16 }, { seniorSharePercentOverride: 18 }],
    )
    expect(result.value).toBe(26)
    expect(result.source).toBe('USER_DEFAULT')
  })

  it('applies team override when only one of multiple teams has an override', () => {
    // Two teams in the input, only one with a non-null override — the
    // resolver treats this as unambiguous.
    const result = resolveSeniorShare(
      { seniorSharePercentOverride: null },
      { seniorSharePercent: 26 },
      [{ seniorSharePercentOverride: 14 }, { seniorSharePercentOverride: null }],
    )
    expect(result.value).toBe(14)
    expect(result.source).toBe('TEAM')
  })

  // ── User default branch ─────────────────────────────────────────────────
  it('returns user default when neither project nor team has an override', () => {
    const result = resolveSeniorShare(
      { seniorSharePercentOverride: null },
      { seniorSharePercent: 26 },
      [],
    )
    expect(result.value).toBe(26)
    expect(result.source).toBe('USER_DEFAULT')
  })

  it('returns user default with a non-default user percent', () => {
    const result = resolveSeniorShare(
      { seniorSharePercentOverride: null },
      { seniorSharePercent: 30 },
      [],
    )
    expect(result.value).toBe(30)
    expect(result.source).toBe('USER_DEFAULT')
  })

  it('falls back to 26 when senior.seniorSharePercent is null', () => {
    const result = resolveSeniorShare(
      { seniorSharePercentOverride: null },
      { seniorSharePercent: null },
      [],
    )
    expect(result.value).toBe(26)
    expect(result.source).toBe('USER_DEFAULT')
  })
})
