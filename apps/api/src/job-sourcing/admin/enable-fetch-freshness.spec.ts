import { describe, expect, it } from 'vitest'
import { enableWindowMinutes } from '../ownership/ledger-policy'
import { isFreshForEnable, msOrNull } from './enable-fetch-freshness'

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0)
const MIN = 60_000
const HOURLY = { intervalMinutes: 60, offIntervalMinutes: null, window: null }

const fresh = (ago: number | null, windowMinutes: number, nowMs = NOW) =>
  isFreshForEnable({
    lastAttemptAtMs: ago === null ? null : nowMs - ago,
    nowMs,
    windowMinutes,
  })

describe('isFreshForEnable', () => {
  it('never attempted -> stale, even when "now" is close to the epoch', () => {
    expect(fresh(null, 60)).toBe(false)
    // A null attempt must not read as epoch 0: 1 s after the epoch is inside a 60-min window.
    expect(fresh(null, 60, 1000)).toBe(false)
  })
  it('attempt inside the window -> fresh, including the exact boundary', () => {
    expect(fresh(59 * MIN, 60)).toBe(true)
    expect(fresh(60 * MIN, 60)).toBe(true)
    expect(fresh(60 * MIN + 1, 60)).toBe(false)
  })
  it('an unreadable clock counts as fresh (no immediate fetch)', () => {
    expect(isFreshForEnable({ lastAttemptAtMs: null, nowMs: null, windowMinutes: 60 })).toBe(true)
  })
})

describe('enableWindowMinutes', () => {
  it('the profile interval when the host floor is shorter', () => {
    expect(enableWindowMinutes({ fetchProfile: HOURLY, floorHours: 0.5 })).toBe(60)
  })
  it('the host floor when it is longer, rounded up to whole minutes', () => {
    expect(enableWindowMinutes({ fetchProfile: HOURLY, floorHours: 3 })).toBe(180)
    expect(enableWindowMinutes({ fetchProfile: HOURLY, floorHours: 1.0001 })).toBe(61)
  })
  it('24 h for a null profile or an entry the catalog does not hold', () => {
    expect(enableWindowMinutes({ fetchProfile: null, floorHours: 48 })).toBe(1440)
    expect(enableWindowMinutes(undefined)).toBe(1440)
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
