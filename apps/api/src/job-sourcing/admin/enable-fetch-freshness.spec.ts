import { describe, expect, it } from 'vitest'
import { isFreshForEnable, msOrNull } from './enable-fetch-freshness'

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0)
const MIN = 60_000

const fresh = (ago: number | null, intervalMinutes: number | null, floorHours = 0, nowMs = NOW) =>
  isFreshForEnable({
    lastAttemptAtMs: ago === null ? null : nowMs - ago,
    nowMs,
    intervalMinutes,
    floorHours,
  })

describe('isFreshForEnable', () => {
  it('never attempted -> stale, even when "now" is close to the epoch', () => {
    expect(fresh(null, 60)).toBe(false)
    // A null attempt must not read as epoch 0: 1 s after the epoch is inside a 60-min window.
    expect(fresh(null, 60, 0, 1000)).toBe(false)
  })
  it('attempt inside the profile interval -> fresh, including the exact boundary', () => {
    expect(fresh(59 * MIN, 60)).toBe(true)
    expect(fresh(60 * MIN, 60)).toBe(true)
    expect(fresh(60 * MIN + 1, 60)).toBe(false)
  })
  it('a host floor longer than the interval widens the window', () => {
    expect(fresh(2 * 60 * MIN, 60, 3)).toBe(true)
    expect(fresh(3 * 60 * MIN, 60, 3)).toBe(true)
    expect(fresh(3 * 60 * MIN + 1, 60, 3)).toBe(false)
    // A floor shorter than the interval does not narrow it.
    expect(fresh(50 * MIN, 60, 0.5)).toBe(true)
  })
  it('null profile -> 24 h window, whatever the floor', () => {
    expect(fresh(23 * 60 * MIN, null)).toBe(true)
    expect(fresh(24 * 60 * MIN, null)).toBe(true)
    expect(fresh(24 * 60 * MIN + 1, null)).toBe(false)
    expect(fresh(24 * 60 * MIN + 1, null, 48)).toBe(false)
  })
  it('an unreadable clock counts as fresh (no immediate fetch)', () => {
    expect(
      isFreshForEnable({ lastAttemptAtMs: null, nowMs: null, intervalMinutes: 60, floorHours: 0 }),
    ).toBe(true)
  })
})

describe('msOrNull', () => {
  it('reads a number or a numeric string; null for absent or non-numeric', () => {
    expect(msOrNull(1234.5)).toBe(1234.5)
    expect(msOrNull('1800000000000')).toBe(1_800_000_000_000)
    expect(msOrNull(0)).toBe(0)
    expect(msOrNull(null)).toBeNull()
    expect(msOrNull(undefined)).toBeNull()
    expect(msOrNull('')).toBeNull()
    expect(msOrNull('abc')).toBeNull()
    expect(msOrNull(Number.POSITIVE_INFINITY)).toBeNull()
  })
})
