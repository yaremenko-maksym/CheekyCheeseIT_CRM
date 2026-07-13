import { describe, it, expect } from 'vitest'
import { resolveDropShare, DEFAULT_DROP_SHARE_PERCENT } from './drop-share-resolver'

/**
 * Unit tests for the drop-share resolver. The hierarchy is:
 *   project override > user default (→ 5). NO team level (a drop is bound to a
 *   project directly via projects.dropId, not through team membership).
 *
 * These tests freeze the resolver contract that feeds both the DROP_INCOME
 * snapshot and the admin-USDT obligation math.
 */
describe('resolveDropShare', () => {
  // ── Project override branch ─────────────────────────────────────────────
  it('returns project override when set, even if the drop has a user default', () => {
    const result = resolveDropShare({ dropSharePercentOverride: 12 }, { dropSharePercent: 5 })
    expect(result.value).toBe(12)
    expect(result.source).toBe('PROJECT')
  })

  it('accepts 0 as a valid project override (not coerced to null)', () => {
    const result = resolveDropShare({ dropSharePercentOverride: 0 }, { dropSharePercent: 5 })
    expect(result.value).toBe(0)
    expect(result.source).toBe('PROJECT')
  })

  it('accepts 100 as a valid project override', () => {
    const result = resolveDropShare({ dropSharePercentOverride: 100 }, { dropSharePercent: 5 })
    expect(result.value).toBe(100)
    expect(result.source).toBe('PROJECT')
  })

  // ── User-default branch ─────────────────────────────────────────────────
  it('falls back to the drop user default when no project override', () => {
    const result = resolveDropShare({ dropSharePercentOverride: null }, { dropSharePercent: 7 })
    expect(result.value).toBe(7)
    expect(result.source).toBe('USER_DEFAULT')
  })

  it('treats undefined project override the same as null (→ user default)', () => {
    const result = resolveDropShare(
      { dropSharePercentOverride: undefined },
      { dropSharePercent: 9 },
    )
    expect(result.value).toBe(9)
    expect(result.source).toBe('USER_DEFAULT')
  })

  // ── Default-of-default branch ───────────────────────────────────────────
  it('falls back to DEFAULT_DROP_SHARE_PERCENT (5) when both override and user default are null', () => {
    const result = resolveDropShare({ dropSharePercentOverride: null }, { dropSharePercent: null })
    expect(result.value).toBe(DEFAULT_DROP_SHARE_PERCENT)
    expect(result.value).toBe(5)
    expect(result.source).toBe('USER_DEFAULT')
  })

  it('falls back to 5 when both are undefined', () => {
    const result = resolveDropShare(
      { dropSharePercentOverride: undefined },
      { dropSharePercent: undefined },
    )
    expect(result.value).toBe(5)
    expect(result.source).toBe('USER_DEFAULT')
  })

  it('user default of 0 is respected (not treated as missing)', () => {
    const result = resolveDropShare({ dropSharePercentOverride: null }, { dropSharePercent: 0 })
    expect(result.value).toBe(0)
    expect(result.source).toBe('USER_DEFAULT')
  })
})
