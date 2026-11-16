import { describe, expect, it } from 'vitest'
import { isFreshForEnable } from './enable-fetch-freshness'

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0)
const MIN = 60_000

describe('isFreshForEnable', () => {
  it('never ran -> stale', () => {
    expect(isFreshForEnable({ lastSuccessEndedAtMs: null, nowMs: NOW, intervalMinutes: 60 })).toBe(
      false,
    )
  })
  it('success inside the profile interval -> fresh, including the exact boundary', () => {
    const f = (ago: number) =>
      isFreshForEnable({ lastSuccessEndedAtMs: NOW - ago, nowMs: NOW, intervalMinutes: 60 })
    expect(f(59 * MIN)).toBe(true)
    expect(f(60 * MIN)).toBe(true)
    expect(f(60 * MIN + 1)).toBe(false)
  })
  it('null profile -> 24 h window', () => {
    const f = (ago: number) =>
      isFreshForEnable({ lastSuccessEndedAtMs: NOW - ago, nowMs: NOW, intervalMinutes: null })
    expect(f(23 * 60 * MIN)).toBe(true)
    expect(f(24 * 60 * MIN)).toBe(true)
    expect(f(24 * 60 * MIN + 1)).toBe(false)
  })
})
